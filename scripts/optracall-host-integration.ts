/**
 * OptraCall 真实 Host 离线链路验证（无模型调用）。
 *
 * 手动运行（不在 npm test 内，需要本机 OptraCall checkout 与 Node 25+）：
 *   node --experimental-strip-types scripts/optracall-host-integration.ts \
 *     --checkout /Users/huangbo/Dev/OptraCall --node /path/to/node25+
 *
 * 验证：真实 Host 启动 → host-ready → 真实 HTTP 协议头 → 配置/项目/任务/上传 → 关闭。
 * 不发送任务消息，不调用模型；模型调用链路与候选效果由后续真实冒烟另行验证。
 */
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareOptraCallEnvironments } from "../src/core/optracall-env.ts";
import { startOptraCallHost, OptraCallClient } from "../src/core/optracall-driver.ts";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const checkout = flag("checkout") ?? "/Users/huangbo/Dev/OptraCall";
const nodePath = flag("node");
if (!existsSync(join(checkout, "scripts/start-host.mjs"))) {
  process.stderr.write(`未找到 OptraCall checkout：${checkout}\n`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "optracall-host-integration-"));
let host: Awaited<ReturnType<typeof startOptraCallHost>> | undefined;
try {
  const envs = prepareOptraCallEnvironments({ sourceRoot: checkout, skillName: "data-analysis", envRoot: join(work, "env") });
  process.stdout.write(`环境准备：baseline 无 data-analysis=${!existsSync(join(envs.baseline.codeRoot, "extensions/analysis-assets/data-analysis"))}，skill 侧有=${existsSync(envs.skill.skillPath!)}\n`);
  host = await startOptraCallHost({
    codeRoot: envs.skill.codeRoot, dataRoot: envs.skill.dataRoot, projectsRoot: envs.skill.projectsRoot,
    nodePath, logPath: join(work, "host.log"),
  });
  process.stdout.write(`Host 就绪：port=${host.port} sdk=${host.sdkVersion} transport=${host.transportVersion}\n`);
  const client = new OptraCallClient(host.port);
  const health = await client.health();
  if (health.status !== "ready") throw new Error(`health 非 ready：${JSON.stringify(health)}`);
  const configuration = await client.putConfiguration({ name: "integration-fixture", provider: "openai-compatible", api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", model: "fixture-model", apiKey: "offline-fixture-key" });
  const project = await client.createProject("integration", configuration.id);
  const task = await client.createTask(project.id, "integration-task", configuration.id);
  const file = await client.uploadFile(project.id, "sales.csv", Buffer.from("a,b\n1,2\n"), "020_clean");
  const fetched = await client.getProject(project.id);
  const foundTask = fetched.tasks.find(item => item.id === task.id);
  if (!foundTask) throw new Error("任务未出现在真实 Host 项目记录中");
  if (!existsSync(join(project.rootPath, "020_clean", "sales.csv"))) throw new Error("上传文件未落到真实项目目录");
  process.stdout.write(`真实 HTTP 链路通过：project=${project.id} task=${task.id} upload=${file.path}\n`);
  process.stdout.write("PASS（无模型调用；模型链路与候选效果待真实冒烟）\n");
} catch (error) {
  process.stderr.write(`FAIL：${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await host?.close();
  rmSync(work, { recursive: true, force: true });
}