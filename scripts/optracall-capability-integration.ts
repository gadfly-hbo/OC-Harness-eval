/**
 * OptraCall A 族能力测评离线端到端验证（本地假 Provider，无真实外网/费用）。
 *
 *   node --experimental-strip-types scripts/optracall-capability-integration.ts \
 *     --checkout /Users/huangbo/Dev/OptraCall --node /path/to/node25+ --capability sap-method
 *
 * --capability memory|sap-method（默认 memory）。假 Provider 首轮调对应工具 find、次轮返回文本。
 * 验证：处理侧 Fixture 被查读、consulted=true；基线能力关闭、consulted=false。
 */
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareOptraCallEnvironments } from "../src/core/optracall-env.ts";
import { createOptraCallExecution } from "../src/core/optracall-execution.ts";
import { resolveOptraCallNode } from "../src/core/optracall-driver.ts";
import { CAPABILITIES, type CapabilityId } from "../src/core/optracall-capabilities.ts";
import type { EvaluationExecution } from "../src/core/execution.ts";
import type { BudgetSnapshot } from "../src/core/controlled-budget.ts";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const checkout = flag("checkout") ?? "/Users/huangbo/Dev/OptraCall";
const nodePath = resolveOptraCallNode(flag("node"));
const capability = (flag("capability") ?? "memory") as CapabilityId;
const def = CAPABILITIES[capability];
if (!def) { process.stderr.write(`未知能力：${capability}\n`); process.exit(1); }

const fixtures: Record<string, unknown>[] = capability === "sap-method"
  ? [{ title: "渠道转化率变动拆解", content: { conditions: "各渠道 visitor/conversion 两期数据", logic: "按 visitor 加权拆解结构与水平效应", judgment: "效应之和闭合到总变动", limits: "缺基期保留 UNKNOWN" } }]
  : [{ caseTitle: "门店缺货核查事项", caseStatus: "observing", judgment: { kind: "hypothesis", title: "缺货归因待核", statement: "历史判断：缺货更可能源于补货周期错配。" } }];

const findArgs = capability === "sap-method"
  ? { action: "find", query: "转化率", kinds: ["sap-method"] }
  : { action: "find", query: "缺货" };

function startFakeProvider(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) { response.writeHead(404); response.end(); return; }
    let body = "";
    request.on("data", c => body += c);
    request.on("end", () => {
      const parsed = JSON.parse(body);
      const toolMsgs = (parsed.messages ?? []).filter((m: any) => m.role === "tool");
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const chunk = (delta: any, finish: string | null) => `data: ${JSON.stringify({ id: "chatcmpl-f", object: "chat.completion.chunk", created: 0, model: "fixture-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      const emitToolCall = (name: string, args: unknown, callId: string) => {
        response.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: callId, type: "function", function: { name, arguments: "" } }] }, null));
        response.write(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }, null));
        response.write(chunk({}, "tool_calls"));
      };
      const emitText = () => {
        response.write(chunk({ role: "assistant", content: "已查阅相关来源，给出核查思路；未做因果检验。" }, null));
        response.write(chunk({}, "stop"));
      };
      const sapTarget = (content: any): any => {
        const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((c: any) => c.text ?? "").join("") : "";
        const match = text.match(/\{[^{}]*"kind"\s*:\s*"sap-method"[^{}]*\}/);
        if (!match) return null;
        try { const t = JSON.parse(match[0]); return t.methodId ? t : null; } catch { return null; }
      };
      if (toolMsgs.length === 0) {
        emitToolCall(def.forensicTool, findArgs, "call_find");
      } else if (capability === "sap-method" && toolMsgs.length === 1) {
        const target = sapTarget(toolMsgs[0].content);
        if (target) emitToolCall(def.forensicTool, { action: "read", target: { kind: "sap-method", methodId: target.methodId, version: target.version, ...(target.publishedHash ? { publishedHash: target.publishedHash } : {}) } }, "call_read");
        else emitText();
      } else {
        emitText();
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

const work = mkdtempSync(join(tmpdir(), "optracall-capability-integration-"));
let provider: Awaited<ReturnType<typeof startFakeProvider>> | undefined;
let execution: EvaluationExecution | undefined;
try {
  provider = await startFakeProvider();
  const envs = prepareOptraCallEnvironments({ sourceRoot: checkout, envRoot: join(work, "env") });
  const judge: EvaluationExecution = {
    mode: "simulated",
    run: async () => ({ exitCode: 0, metrics: { totalTokens: 0, totalCost: 0, toolCalls: 0, output: "{}", readPaths: [], toolNames: [] }, events: [], stderr: "", timedOut: false, isolation: { verified: true, issues: [] } }),
    isStopped: () => false, snapshot: () => ({ state: "open", stoppedReason: null, policy: { maxNanoUsd: null } } as unknown as BudgetSnapshot), finalize() {},
  };
  execution = createOptraCallExecution({
    mode: "simulated", runRoot: work, envs, model: "custom/fixture-model", judgeModel: "custom/fixture-model",
    nativeLimits: { subject: { contextWindow: 32000, maxOutputTokens: 4096 }, judge: { contextWindow: 32000, maxOutputTokens: 4096 } },
    judgePlannedSessions: 0, configuration: { name: "fixture", provider: "openai-compatible", api: "openai-completions", baseUrl: `http://127.0.0.1:${provider.port}/v1`, model: "fixture-model", apiKey: "offline-fixture" },
    templateFor: () => [], nodePath, judgeExecution: judge,
    capabilityToggle: { baselineArgs: [def.disableFlag], treatmentArgs: [] },
    capabilityId: capability, capabilityFixtures: fixtures,
  });
  const req = (variantId: string) => {
    const caseDir = join(work, "cases", variantId, "t", "1");
    return { workspaceRoot: join(caseDir, "workspace"), sessionId: `run-${variantId}`, taskId: "t", variantId, prompt: "查阅相关来源并给出核查思路", model: "custom/fixture-model", skillPaths: [] as string[] };
  };
  const treatment = await execution.run("subject", req("treatment"));
  const baseline = await execution.run("subject", req("baseline"));
  process.stdout.write(`[${capability}] 处理侧 exit=${treatment.exitCode} consulted=${treatment.memoryUsage?.consulted} findCalls=${treatment.memoryUsage?.findCalls}\n`);
  process.stdout.write(`[${capability}] 基线侧 exit=${baseline.exitCode} consulted=${baseline.memoryUsage?.consulted}\n`);
  if (treatment.exitCode !== 0) throw new Error(`处理侧未成功：${treatment.stderr}`);
  if (!treatment.memoryUsage?.consulted) throw new Error("处理侧未取证到能力调用");
  if (baseline.memoryUsage?.consulted) throw new Error("基线侧能力应关闭，不应取证到成功调用");
  await execution.finalize?.();
  process.stdout.write(`PASS（${capability} 离线端到端：注入→查读→取证正例成立，基线能力关闭）\n`);
} catch (error) {
  process.stderr.write(`FAIL：${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await execution?.finalize?.().catch(() => {});
  await provider?.close();
  rmSync(work, { recursive: true, force: true });
}