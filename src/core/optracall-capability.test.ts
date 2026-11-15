import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { prepareOptraCallEnvironments, verifyOptraCallEnvironments, type OptraCallEnvironments } from "./optracall-env.ts";
import { createOptraCallExecution } from "./optracall-execution.ts";
import { findBaselineVariant } from "./runner.ts";
import type { FetchLike, OptraCallHostHandle } from "./optracall-driver.ts";
import type { EvaluationExecution } from "./execution.ts";
import type { BudgetSnapshot } from "./controlled-budget.ts";

function fixtureSource(): string {
  const root = mkdtempSync(join(tmpdir(), "optracall-cap-src-"));
  const write = (rel: string, content: string) => { const path = join(root, rel); mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, content); };
  write("package.json", "{}");
  write("src/agent/x.ts", "x\n");
  write("extensions/analysis-assets/data-analysis/SKILL.md", "---\nname: data-analysis\n---\n");
  write("node_modules/@earendil-works/pi-coding-agent/package.json", JSON.stringify({ version: "1.4.0" }));
  write("node_modules/@earendil-works/pi-coding-agent/dist/index.js", "export {};\n");
  return root;
}

test("能力模式：双 codeRoot 全等，两侧 skillPath 皆 null", () => {
  const source = fixtureSource();
  const envRoot = join(source, "..", `cap-env-${Date.now()}`);
  try {
    const envs = prepareOptraCallEnvironments({ sourceRoot: source, envRoot });
    assert.equal(envs.skillName, null);
    assert.equal(envs.baseline.skillPath, null);
    assert.equal(envs.skill.skillPath, null);
    // 两侧都保留全部 skill（不删包）。
    assert.ok(existsSync(join(envs.baseline.codeRoot, "extensions/analysis-assets/data-analysis/SKILL.md")));
    assert.ok(existsSync(join(envs.skill.codeRoot, "extensions/analysis-assets/data-analysis/SKILL.md")));
    assert.deepEqual(verifyOptraCallEnvironments(envs), []);
    // 任一侧改动都被核验捕获。
    writeFileSync(join(envs.skill.codeRoot, "src/agent/x.ts"), "changed\n");
    assert.ok(verifyOptraCallEnvironments(envs).some(i => i.includes("文件漂移") || i.includes("不一致")));
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(envRoot, { recursive: true, force: true });
  }
});

test("findBaselineVariant 按 id 判定（能力模式两侧皆空 skillPaths）", () => {
  const baseline = { id: "baseline", label: "B", skillPaths: [] as string[] };
  const treatment = { id: "memory", label: "M", skillPaths: [] as string[] };
  assert.equal(findBaselineVariant([baseline, treatment]), baseline);
  assert.equal(findBaselineVariant([treatment, baseline]), baseline);
  // skill 模式兼容：baseline 空 skillPaths。
  const skill = { id: "skill", label: "S", skillPaths: ["/x/SKILL.md"] };
  assert.equal(findBaselineVariant([baseline, skill]), baseline);
  // 旧清单无 id=baseline 时按空 skillPaths 回退。
  const legacyBase = { id: "b0", label: "B", skillPaths: [] as string[] };
  assert.equal(findBaselineVariant([legacyBase, skill]), legacyBase);
});

function capabilitySetup() {
  const source = fixtureSource();
  const runRoot = mkdtempSync(join(tmpdir(), "optracall-cap-run-"));
  const envs = prepareOptraCallEnvironments({ sourceRoot: source, envRoot: join(runRoot, "env") });
  const argsBySide: Record<string, string[] | undefined> = {};
  const projects = new Map<string, any>();
  const makeHandler = (side: string) => (method: string, path: string, body: any): { status: number; body: unknown } => {
    if (path === "/api/health") return { status: 200, body: { status: "ready", sdkVersion: "1.4.0" } };
    if (path === "/api/configuration" && method === "PUT") return { status: 200, body: { configuration: { id: `cfg-${side}`, revision: 1 } } };
    if (path === "/api/projects" && method === "POST") {
      const id = randomUUID();
      const rootPath = join(envs[side as "baseline" | "skill"].projectsRoot, id);
      for (const d of ["010_draw", "020_clean", "060_reports"]) mkdirSync(join(rootPath, d), { recursive: true });
      const project = { id, rootPath, tasks: [] as any[] };
      projects.set(id, project);
      return { status: 201, body: { project } };
    }
    const m = /^\/api\/projects\/([a-f0-9-]+)(?:\/(.*))?$/.exec(path);
    if (m) {
      const project = projects.get(m[1]!);
      const action = m[2];
      if (!action && method === "GET") return { status: 200, body: { project } };
      if (action === "tasks" && method === "POST") {
        const id = randomUUID();
        const sessionDirectory = join(envs[side as "baseline" | "skill"].dataRoot, "projects", project.id, "tasks", id, "sessions");
        mkdirSync(sessionDirectory, { recursive: true });
        const task = { id, sessionDirectory, sessionFile: undefined, lastRun: undefined };
        project.tasks.push(task);
        return { status: 201, body: { task } };
      }
      const tm = /^tasks\/([a-f0-9-]+)(?:\/(.*))?$/.exec(action ?? "");
      if (tm) {
        const task = project.tasks.find((t: any) => t.id === tm[1]);
        if (tm[2] === "messages" && method === "POST") {
          const native = [
            { type: "session", version: 3, id: "sess", timestamp: "2026-11-16T00:00:00.000Z", cwd: join(project.rootPath, "020_clean") },
            { type: "message", id: "m1", parentId: null, timestamp: "2026-11-16T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } }, stopReason: "stop" } },
          ].map(l => JSON.stringify(l)).join("\n") + "\n";
          const sessionFile = join(task.sessionDirectory, "s.jsonl");
          writeFileSync(sessionFile, native);
          task.sessionFile = sessionFile;
          task.lastRun = { id: body.requestId, status: "completed", startedAt: "2026-11-16T00:00:00.000Z", settledAt: "2026-11-16T00:00:02.000Z" };
          return { status: 202, body: { requestId: body.requestId, status: "running" } };
        }
      }
    }
    return { status: 404, body: { code: "not_found" } };
  };
  const handlers: Record<string, ReturnType<typeof makeHandler>> = { "6001": makeHandler("baseline"), "6002": makeHandler("skill") };
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const { status, body: rb } = handlers[url.port]!(init?.method ?? "GET", url.pathname, body);
    return new Response(JSON.stringify(rb), { status });
  };
  const hostFactory = (async (options: any) => {
    const side = options.codeRoot === envs.baseline.codeRoot ? "baseline" : "skill";
    argsBySide[side] = options.extraArgs;
    const port = side === "baseline" ? 6001 : 6002;
    const handle: OptraCallHostHandle = { port, pid: 1, sdkVersion: "1.4.0", transportVersion: "8.12.2", exited: new Promise(() => {}), async close() {} };
    return handle;
  }) as any;
  const judge: EvaluationExecution = {
    mode: "simulated",
    run: async () => ({ exitCode: 0, metrics: { totalTokens: 0, totalCost: 0, toolCalls: 0, output: "{}", readPaths: [], toolNames: [] }, events: [], stderr: "", timedOut: false, isolation: { verified: true, issues: [] } }),
    isStopped: () => false,
    snapshot: () => ({ state: "open", stoppedReason: null, policy: { maxNanoUsd: null } } as unknown as BudgetSnapshot),
    finalize() {},
  };
  const execution = createOptraCallExecution({
    mode: "simulated", runRoot, envs, model: "minimax-cn/MiniMax-M3.1-Flash", judgeModel: "xiaomi-token-plan-cn/mimo-v2.6-flash",
    nativeLimits: { subject: { contextWindow: 1_000_000, maxOutputTokens: 524_288 }, judge: { contextWindow: 1_048_576, maxOutputTokens: 131_072 } },
    judgePlannedSessions: 0, configuration: { name: "n", provider: "minimax-cn", api: "anthropic-messages", baseUrl: "https://x", model: "MiniMax-M3.1-Flash", apiKey: "fixture" },
    templateFor: () => [], hostFactory, judgeExecution: judge, fetchImpl,
    capabilityToggle: { baselineArgs: ["--disable-experience-learning"], treatmentArgs: [] },
  });
  const cleanup = () => { rmSync(source, { recursive: true, force: true }); rmSync(runRoot, { recursive: true, force: true }); };
  return { execution, envs, runRoot, argsBySide, cleanup };
}

test("能力开关：按 variantId 分侧，baseline 带 disable flag、treatment 不带", async () => {
  const { execution, envs, runRoot, argsBySide, cleanup } = capabilitySetup();
  try {
    const req = (variantId: string) => {
      const caseDir = join(runRoot, "cases", variantId, "t", "1");
      mkdirSync(join(caseDir, "workspace"), { recursive: true });
      return { workspaceRoot: join(caseDir, "workspace"), sessionId: `run-${variantId}`, taskId: "t", variantId, prompt: "p", model: "minimax-cn/MiniMax-M3.1-Flash", skillPaths: [] as string[] };
    };
    const base = await execution.run("subject", req("baseline"));
    const treat = await execution.run("subject", req("memory"));
    assert.equal(base.exitCode, 0);
    assert.equal(treat.exitCode, 0);
    assert.deepEqual(argsBySide.baseline, ["--disable-experience-learning"]);
    assert.deepEqual(argsBySide.skill, []);
    assert.equal(base.isolation.verified, true);
    assert.equal(treat.isolation.verified, true);
    await execution.finalize?.();
  } finally { cleanup(); }
});