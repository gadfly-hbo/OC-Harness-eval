/**
 * OptraCall memory 测评离线端到端验证（本地假 Provider，无真实外网/费用）。
 *
 *   node --experimental-strip-types scripts/optracall-memory-integration.ts \
 *     --checkout /Users/huangbo/Dev/OptraCall --node /path/to/node25+
 *
 * 假 Provider 首轮返回 read_case_sources find 工具调用、次轮返回文本。验证：
 * 处理侧（记忆开）注入的判断卡片被查读、取证 consulted=true；基线侧（记忆关）工具不可用。
 */
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareOptraCallEnvironments } from "../src/core/optracall-env.ts";
import { createOptraCallExecution } from "../src/core/optracall-execution.ts";
import { resolveOptraCallNode } from "../src/core/optracall-driver.ts";
import type { EvaluationExecution } from "../src/core/execution.ts";
import type { BudgetSnapshot } from "../src/core/controlled-budget.ts";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const checkout = flag("checkout") ?? "/Users/huangbo/Dev/OptraCall";
const nodePath = resolveOptraCallNode(flag("node"));

function startFakeProvider(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
      response.writeHead(404); response.end(); return;
    }
    let body = "";
    request.on("data", c => body += c);
    request.on("end", () => {
      const parsed = JSON.parse(body);
      const hasToolResult = (parsed.messages ?? []).some((m: any) => m.role === "tool");
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const chunk = (delta: any, finish: string | null) => `data: ${JSON.stringify({ id: "chatcmpl-f", object: "chat.completion.chunk", created: 0, model: "fixture-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      if (!hasToolResult) {
        response.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_case_sources", arguments: "" } }] }, null));
        response.write(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ action: "find", query: "缺货" }) } }] }, null));
        response.write(chunk({}, "tool_calls"));
      } else {
        response.write(chunk({ role: "assistant", content: "已查阅历史判断：缺货归因待核，需核对补货记录，未做因果检验。" }, null));
        response.write(chunk({}, "stop"));
      }
      response.write(`data: ${JSON.stringify({ id: "chatcmpl-f", object: "chat.completion.chunk", created: 0, model: "fixture-model", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => {
    const addr = server.address();
    resolve({ port: typeof addr === "object" && addr ? addr.port : 0, close: () => new Promise<void>(d => server.close(() => d())) });
  }));
}

const work = mkdtempSync(join(tmpdir(), "optracall-memory-integration-"));
let provider: Awaited<ReturnType<typeof startFakeProvider>> | undefined;
const executions: EvaluationExecution[] = [];
try {
  provider = await startFakeProvider();
  const envs = prepareOptraCallEnvironments({ sourceRoot: checkout, envRoot: join(work, "env") });
  const judge: EvaluationExecution = {
    mode: "simulated",
    run: async () => ({ exitCode: 0, metrics: { totalTokens: 0, totalCost: 0, toolCalls: 0, output: "{}", readPaths: [], toolNames: [] }, events: [], stderr: "", timedOut: false, isolation: { verified: true, issues: [] } }),
    isStopped: () => false, snapshot: () => ({ state: "open", stoppedReason: null, policy: { maxNanoUsd: null } } as unknown as BudgetSnapshot), finalize() {},
  };
  const execution = createOptraCallExecution({
    mode: "simulated", runRoot: work, envs, model: "custom/fixture-model", judgeModel: "custom/fixture-model",
    nativeLimits: { subject: { contextWindow: 32000, maxOutputTokens: 4096 }, judge: { contextWindow: 32000, maxOutputTokens: 4096 } },
    judgePlannedSessions: 0, configuration: { name: "fixture", provider: "openai-compatible", api: "openai-completions", baseUrl: `http://127.0.0.1:${provider.port}/v1`, model: "fixture-model", apiKey: "offline-fixture" },
    templateFor: () => [], nodePath, judgeExecution: judge,
    capabilityToggle: { baselineArgs: ["--disable-experience-learning"], treatmentArgs: [] },
    memoryFixtures: [{ caseTitle: "门店缺货核查事项", caseStatus: "observing", judgment: { kind: "hypothesis", title: "缺货归因待核", statement: "历史判断：缺货更可能源于补货周期错配。" } }],
  });
  executions.push(execution);
  const req = (variantId: string) => {
    const caseDir = join(work, "cases", variantId, "t", "1");
    return { workspaceRoot: join(caseDir, "workspace"), sessionId: `run-${variantId}`, taskId: "t", variantId, prompt: "查阅历史判断并给出缺货核查思路", model: "custom/fixture-model", skillPaths: [] as string[] };
  };
  const treatment = await execution.run("subject", req("memory"));
  const baseline = await execution.run("subject", req("baseline"));
  process.stdout.write(`处理侧 exit=${treatment.exitCode} consulted=${treatment.memoryUsage?.consulted} findCalls=${treatment.memoryUsage?.findCalls} readCalls=${treatment.memoryUsage?.readCalls}\n`);
  process.stdout.write(`基线侧 exit=${baseline.exitCode} consulted=${baseline.memoryUsage?.consulted}\n`);
  if (treatment.exitCode !== 0) throw new Error(`处理侧未成功：${treatment.stderr}`);
  if (!treatment.memoryUsage?.consulted) throw new Error("处理侧未取证到 read_case_sources 调用");
  if (baseline.memoryUsage?.consulted) throw new Error("基线侧记忆能力应关闭，不应取证到调用");
  await execution.finalize?.();
  process.stdout.write("PASS（memory 离线端到端：注入→查读→取证正例成立，基线能力关闭）\n");
} catch (error) {
  process.stderr.write(`FAIL：${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
} finally {
  for (const e of executions) await e.finalize?.().catch(() => {});
  await provider?.close();
  rmSync(work, { recursive: true, force: true });
}