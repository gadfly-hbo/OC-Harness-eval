/**
 * OptraCall 完整模型调用链路离线验证（本地假 Provider，无真实外网）。
 *
 *   node --experimental-strip-types scripts/optracall-model-integration.ts \
 *     --checkout /Users/huangbo/Dev/OptraCall --node /path/to/node25+
 *
 * 用本地 OpenAI 兼容假 Provider 返回固定文本，验证：Host → worker → Pi SDK →
 * native 会话 JSONL → 取证解析 的完整链路。不调用真实模型、不产生费用。
 */
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { prepareOptraCallEnvironments } from "../src/core/optracall-env.ts";
import { startOptraCallHost, OptraCallClient } from "../src/core/optracall-driver.ts";
import { collectCaseEvidence, parseNativeSession } from "../src/core/optracall-evidence.ts";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const checkout = flag("checkout") ?? "/Users/huangbo/Dev/OptraCall";
const nodePath = flag("node");

function startFakeProvider(): Promise<{ port: number; close: () => Promise<void>; requests: number }> {
  let requests = 0;
  const server = createServer((request, response) => {
    if (request.method === "POST" && request.url?.endsWith("/chat/completions")) {
      requests += 1;
      request.resume();
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const chunk = (delta: unknown, finish: string | null, usage?: unknown) => `data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 0, model: "fixture-model", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
      response.write(chunk({ role: "assistant", content: "OK" }, null));
      response.write(chunk({}, "stop"));
      response.write(`data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 0, model: "fixture-model", choices: [], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } })}\n\n`);
      response.write("data: [DONE]\n\n");
      response.end();
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: `unexpected ${request.method} ${request.url}` } }));
  });
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ port: typeof address === "object" && address ? address.port : 0, requests: 0, close: () => new Promise<void>(done => server.close(() => done())) });
    });
  });
}

const work = mkdtempSync(join(tmpdir(), "optracall-model-integration-"));
let host: Awaited<ReturnType<typeof startOptraCallHost>> | undefined;
let provider: Awaited<ReturnType<typeof startFakeProvider>> | undefined;
try {
  provider = await startFakeProvider();
  const envs = prepareOptraCallEnvironments({ sourceRoot: checkout, skillName: "data-analysis", envRoot: join(work, "env") });
  host = await startOptraCallHost({ codeRoot: envs.skill.codeRoot, dataRoot: envs.skill.dataRoot, projectsRoot: envs.skill.projectsRoot, nodePath, logPath: join(work, "host.log") });
  const client = new OptraCallClient(host.port);
  const configuration = await client.putConfiguration({ name: "fixture", provider: "openai-compatible", api: "openai-completions", baseUrl: `http://127.0.0.1:${provider.port}/v1`, model: "fixture-model", apiKey: "offline-fixture" });
  const project = await client.createProject("model-integration", configuration.id);
  const task = await client.createTask(project.id, "model-task", configuration.id);
  await client.uploadFile(project.id, "sales.csv", Buffer.from("a,b\n1,2\n"), "020_clean");
  const requestId = randomUUID();
  await client.sendMessage(project.id, task.id, "请只回复两个字母：OK", requestId);
  const { lastRun, timedOut } = await client.waitTerminal(project.id, task.id, requestId, { timeoutMs: 60_000, pollMs: 300, hostExited: host.exited });
  if (timedOut || lastRun?.status !== "completed") throw new Error(`任务未成功终态：${JSON.stringify(lastRun)} timedOut=${timedOut}`);
  const fetched = await client.getProject(project.id);
  const finalTask = fetched.tasks.find(item => item.id === task.id)!;
  const caseDir = join(work, "case");
  const evidence = collectCaseEvidence({ caseDir, projectDir: fetched.rootPath, dataRoot: envs.skill.dataRoot, projectId: project.id, taskId: task.id, requestId, sessionFile: finalTask.sessionFile ?? null, hostPort: host.port, lastRun });
  if (!evidence.nativeSession) throw new Error("未产生 native 会话 JSONL");
  const parsed = parseNativeSession(readFileSync(join(caseDir, "optracall", "native-session.jsonl"), "utf8"), join(fetched.rootPath, "020_clean"));
  process.stdout.write(`任务终态=${lastRun.status}，native 条目=${parsed.entryCount}，最终输出=${JSON.stringify(parsed.metrics.output)}，tokens=${parsed.metrics.totalTokens}\n`);
  if (!parsed.metrics.output.includes("OK")) throw new Error(`最终输出不含预期文本：${parsed.metrics.output}`);
  process.stdout.write("PASS（完整模型调用链路离线验证；假 Provider，无真实费用）\n");
} catch (error) {
  process.stderr.write(`FAIL：${error instanceof Error ? error.stack : String(error)}\n`);
  try { process.stderr.write(`--- host.log ---\n${readFileSync(join(work, "host.log"), "utf8").slice(-3000)}\n`); } catch { /* no log */ }
  process.exitCode = 1;
} finally {
  await host?.close();
  await provider?.close();
  rmSync(work, { recursive: true, force: true });
}