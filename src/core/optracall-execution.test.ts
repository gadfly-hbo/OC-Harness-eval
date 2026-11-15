import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { prepareOptraCallEnvironments, type OptraCallEnvironments, type OptraCallSide } from "./optracall-env.ts";
import { createOptraCallExecution } from "./optracall-execution.ts";
import { OptraCallHostFault, type FetchLike, type OptraCallHostHandle } from "./optracall-driver.ts";
import type { EvaluationExecution } from "./execution.ts";
import type { BudgetSnapshot } from "./controlled-budget.ts";

function fixtureSource(): string {
  const root = mkdtempSync(join(tmpdir(), "optracall-exec-src-"));
  const write = (rel: string, content: string) => { const path = join(root, rel); mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, content); };
  write("package.json", "{}");
  write("src/agent/x.ts", "x\n");
  write("extensions/analysis-assets/data-analysis/SKILL.md", "---\nname: data-analysis\n---\n");
  write("node_modules/@earendil-works/pi-coding-agent/package.json", JSON.stringify({ version: "1.4.0" }));
  write("node_modules/@earendil-works/pi-coding-agent/dist/index.js", "export {};\n");
  return root;
}

interface StubOptions { outcome: "completed" | "failed" }

function stubSide(side: OptraCallSide, envs: OptraCallEnvironments, port: number, opts: StubOptions) {
  const env = envs[side];
  const projects = new Map<string, any>();
  const handler = (method: string, path: string, body: any): { status: number; body: unknown } => {
    if (path === "/api/health") return { status: 200, body: { status: "ready", sdkVersion: "1.4.0" } };
    if (path === "/api/configuration" && method === "PUT") return { status: 200, body: { configuration: { id: `cfg-${side}`, revision: 1, provider: "minimax-cn", model: "MiniMax-M3.1-Flash", baseUrl: "https://x", api: "anthropic-messages" } } };
    if (path === "/api/projects" && method === "POST") {
      const id = randomUUID();
      const rootPath = join(env.projectsRoot, id);
      for (const directory of ["010_draw", "020_clean", "060_reports"]) mkdirSync(join(rootPath, directory), { recursive: true });
      const project = { id, rootPath, tasks: [] as any[] };
      projects.set(id, project);
      return { status: 201, body: { project } };
    }
    const projectMatch = /^\/api\/projects\/([a-f0-9-]+)(?:\/(.*))?$/.exec(path);
    if (projectMatch) {
      const project = projects.get(projectMatch[1]!);
      const action = projectMatch[2];
      if (!action && method === "GET") return { status: 200, body: { project } };
      if (action === "tasks" && method === "POST") {
        const id = randomUUID();
        const sessionDirectory = join(env.dataRoot, "projects", project.id, "tasks", id, "sessions");
        mkdirSync(sessionDirectory, { recursive: true });
        const task = { id, sessionDirectory, sessionFile: undefined, lastRun: undefined };
        project.tasks.push(task);
        return { status: 201, body: { task } };
      }
      if (action === "files/upload" && method === "POST") {
        const target = join(project.rootPath, body.directory, body.name);
        mkdirSync(join(target, ".."), { recursive: true });
        writeFileSync(target, Buffer.from(body.content, "base64"));
        return { status: 201, body: { file: { path: `${body.directory}/${body.name}`, sha256: "x" } } };
      }
      const taskMatch = /^tasks\/([a-f0-9-]+)(?:\/(.*))?$/.exec(action ?? "");
      if (taskMatch) {
        const task = project.tasks.find((item: any) => item.id === taskMatch[1]);
        const operation = taskMatch[2];
        if (operation === "messages" && method === "POST") {
          const skillRead = side === "skill"
            ? [{ type: "toolCall", id: "ts", name: "read", arguments: { path: env.skillPath } }]
            : [];
          const skillResult = side === "skill"
            ? [{ type: "message", id: "m1b", parentId: "m1", timestamp: "2026-11-15T00:00:01.500Z", message: { role: "toolResult", toolCallId: "ts", toolName: "read", content: [], isError: false } }]
            : [];
          const native = [
            { type: "session", version: 3, id: "sess", timestamp: "2026-11-15T00:00:00.000Z", cwd: join(project.rootPath, "020_clean") },
            { type: "message", id: "m1", parentId: null, timestamp: "2026-11-15T00:00:01.000Z", message: { role: "assistant", content: [...skillRead, { type: "toolCall", id: "td", name: "read", arguments: { path: "data.csv" } }], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.001 } }, stopReason: "toolUse" } },
            ...skillResult,
            { type: "message", id: "m2", parentId: "m1", timestamp: "2026-11-15T00:00:02.000Z", message: { role: "toolResult", toolCallId: "td", toolName: "read", content: [], isError: false } },
            { type: "message", id: "m3", parentId: "m2", timestamp: "2026-11-15T00:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "报告完成" }], usage: { input: 20, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 28, cost: { total: 0.002 } }, stopReason: "stop" } },
          ].map(line => JSON.stringify(line)).join("\n") + "\n";
          const sessionFile = join(task.sessionDirectory, "s.jsonl");
          writeFileSync(sessionFile, native);
          writeFileSync(join(project.rootPath, "060_reports", "analysis.md"), "# 报告\n");
          task.sessionFile = sessionFile;
          task.lastRun = { id: body.requestId, status: opts.outcome, startedAt: "2026-11-15T00:00:00.000Z", settledAt: "2026-11-15T00:00:04.000Z" };
          return { status: 202, body: { requestId: body.requestId, status: "running" } };
        }
        if (operation === "stop" && method === "POST") { task.lastRun = { ...task.lastRun, status: "cancelled" }; return { status: 200, body: { stopped: true } }; }
      }
    }
    return { status: 404, body: { code: "not_found" } };
  };
  const handle: OptraCallHostHandle = {
    port, pid: 1, sdkVersion: "1.4.0", transportVersion: "8.12.2",
    exited: new Promise(() => {}),
    async close() {},
  };
  return { handle, handler };
}

function setup(opts: StubOptions = { outcome: "completed" }) {
  const source = fixtureSource();
  const runRoot = mkdtempSync(join(tmpdir(), "optracall-exec-run-"));
  const envs = prepareOptraCallEnvironments({ sourceRoot: source, skillName: "data-analysis", envRoot: join(runRoot, "env") });
  const baseline = stubSide("baseline", envs, 5001, opts);
  const skill = stubSide("skill", envs, 5002, opts);
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input);
    const side = url.port === "5001" ? baseline : skill;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const { status, body: responseBody } = side.handler(init?.method ?? "GET", url.pathname, body);
    return new Response(JSON.stringify(responseBody), { status });
  };
  const hostFactory = (async (options: any) => (options.codeRoot === envs.baseline.codeRoot ? baseline.handle : skill.handle)) as any;
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
    judgePlannedSessions: 1, configuration: { name: "n", provider: "minimax-cn", api: "anthropic-messages", baseUrl: "https://x", model: "MiniMax-M3.1-Flash", apiKey: "fixture" },
    templateFor: () => [{ name: "data.csv", directory: "020_clean", bytes: Buffer.from("a,b\n1,2\n") }],
    hostFactory, judgeExecution: judge, fetchImpl,
  });
  const cleanup = () => { rmSync(source, { recursive: true, force: true }); rmSync(runRoot, { recursive: true, force: true }); };
  return { execution, envs, runRoot, cleanup };
}

function subjectRequest(envs: OptraCallEnvironments, runRoot: string, side: OptraCallSide, sessionId: string) {
  const caseDir = join(runRoot, "cases", side, "task-a", "1");
  mkdirSync(join(caseDir, "workspace"), { recursive: true });
  return {
    workspaceRoot: join(caseDir, "workspace"), sessionId, taskId: "task-a", prompt: "分析 data.csv",
    model: "minimax-cn/MiniMax-M3.1-Flash",
    skillPaths: side === "skill" ? [envs.skill.skillPath!] : [],
  };
}

test("skill 侧成功：激活取证、交付采集、账本与隔离核验", async () => {
  const { execution, envs, runRoot, cleanup } = setup();
  try {
    const result = await execution.run("subject", subjectRequest(envs, runRoot, "skill", "run-skill-1"));
    assert.equal(result.exitCode, 0);
    assert.equal(result.metrics.output, "报告完成");
    assert.ok(result.metrics.readPaths.includes(envs.skill.skillPath!));
    assert.equal(result.isolation.verified, true);
    assert.equal(result.isolation.backend, "optracall-host-eval-roots");
    const caseDir = join(runRoot, "cases", "skill", "task-a", "1");
    assert.ok(existsSync(join(caseDir, "workspace", "060_reports", "analysis.md")));
    assert.ok(existsSync(join(caseDir, "optracall", "native-session.jsonl")));
    assert.ok(existsSync(join(runRoot, "optracall-ledger.jsonl")));
    assert.equal(execution.isStopped(), false);
    await execution.finalize?.();
    assert.ok(existsSync(join(runRoot, "optracall-execution.json")));
  } finally { cleanup(); }
});

test("baseline 侧不读目标 skill，使用独立环境", async () => {
  const { execution, envs, runRoot, cleanup } = setup();
  try {
    const result = await execution.run("subject", subjectRequest(envs, runRoot, "baseline", "run-base-1"));
    assert.equal(result.exitCode, 0);
    assert.ok(!result.metrics.readPaths.some(path => path.includes("data-analysis")));
    assert.equal(result.isolation.verified, true);
  } finally { cleanup(); }
});

test("单样本终态失败记失败但不亦停批，证据仍采集", async () => {
  const { execution, envs, runRoot, cleanup } = setup({ outcome: "failed" });
  try {
    const result = await execution.run("subject", subjectRequest(envs, runRoot, "skill", "run-fail-1"));
    assert.equal(result.exitCode, 1);
    assert.equal(execution.isStopped(), false);
    assert.ok(existsSync(join(runRoot, "cases", "skill", "task-a", "1", "optracall", "native-session.jsonl")));
  } finally { cleanup(); }
});

test("skill 身份不符即停批", async () => {
  const { execution, envs, runRoot, cleanup } = setup();
  try {
    const request = subjectRequest(envs, runRoot, "skill", "run-bad-1");
    request.skillPaths = ["/wrong/SKILL.md"];
    const result = await execution.run("subject", request);
    assert.equal(result.exitCode, null);
    assert.equal(execution.isStopped(), true);
    assert.match(execution.snapshot().stoppedReason ?? "", /OPTRACALL_SKILL_IDENTITY_MISMATCH/);
  } finally { cleanup(); }
});

test("Host 启动故障停批并保留首因", async () => {
  const source = fixtureSource();
  const runRoot = mkdtempSync(join(tmpdir(), "optracall-exec-fault-"));
  try {
    const envs = prepareOptraCallEnvironments({ sourceRoot: source, skillName: "data-analysis", envRoot: join(runRoot, "env") });
    const judge: EvaluationExecution = { mode: "simulated", run: async () => ({ exitCode: 0, metrics: { totalTokens: 0, totalCost: 0, toolCalls: 0, output: "", readPaths: [], toolNames: [] }, events: [], stderr: "", timedOut: false, isolation: { verified: true, issues: [] } }), isStopped: () => false, snapshot: () => ({ state: "open", stoppedReason: null, policy: { maxNanoUsd: null } } as unknown as BudgetSnapshot), finalize() {} };
    const execution = createOptraCallExecution({
      mode: "simulated", runRoot, envs, model: "minimax-cn/MiniMax-M3.1-Flash", judgeModel: "xiaomi-token-plan-cn/mimo-v2.6-flash",
      nativeLimits: { subject: { contextWindow: 1_000_000, maxOutputTokens: 524_288 }, judge: { contextWindow: 1_048_576, maxOutputTokens: 131_072 } },
      judgePlannedSessions: 1, configuration: { name: "n", provider: "minimax-cn", api: "anthropic-messages", baseUrl: "https://x", model: "MiniMax-M3.1-Flash", apiKey: "fixture" },
      templateFor: () => [], hostFactory: (async () => { throw new OptraCallHostFault("OPTRACALL_HOST_START_TIMEOUT"); }) as any, judgeExecution: judge,
    });
    const result = await execution.run("subject", subjectRequest(envs, runRoot, "skill", "run-fault-1"));
    assert.equal(result.exitCode, null);
    assert.equal(execution.isStopped(), true);
    assert.match(execution.snapshot().stoppedReason ?? "", /OPTRACALL_HOST_START_TIMEOUT/);
  } finally { rmSync(source, { recursive: true, force: true }); rmSync(runRoot, { recursive: true, force: true }); }
});