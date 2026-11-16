/**
 * 评测工具对齐探针：用户发起测评前，检查 OC-Harness-eval 与当前 OptraCall 产品是否适配。
 *
 *   node --experimental-strip-types scripts/eval-align.ts \
 *     --checkout /Users/huangbo/Dev/OptraCall --node /path/to/node25+
 *
 * 依次跑各接缝的离线集成探针（真实 Host + 假 Provider，无真实费用），汇总 PASS/FAIL。
 * 全 PASS＝评测工具与当前产品适配，可发起测评；任一 FAIL＝对应接缝漂移，需修评测工具适配器。
 * 红线：本脚本只读使用 OptraCall 产品，绝不修改产品源码或真实数据。
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const checkout = flag("checkout") ?? "/Users/huangbo/Dev/OptraCall";
const nodePath = flag("node") ?? process.execPath;
const scriptsDir = dirname(fileURLToPath(import.meta.url));

const probes: Array<{ name: string; script: string; args: string[] }> = [
  { name: "Host API 链路", script: "optracall-host-integration.ts", args: [] },
  { name: "模型调用链路", script: "optracall-model-integration.ts", args: [] },
  { name: "memory 能力", script: "optracall-capability-integration.ts", args: ["--capability", "memory"] },
  { name: "sap-method 能力", script: "optracall-capability-integration.ts", args: ["--capability", "sap-method"] },
];

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
for (const probe of probes) {
  const res = spawnSync(process.execPath, ["--experimental-strip-types", join(scriptsDir, probe.script), "--checkout", checkout, "--node", nodePath, ...probe.args], { encoding: "utf8", timeout: 240_000 });
  const out = (res.stdout ?? "") + (res.stderr ?? "");
  const pass = res.status === 0 && /PASS/.test(out);
  const detail = pass ? "适配" : (out.split("\n").filter(l => /FAIL|Error|错误/.test(l)).slice(0, 2).join(" ") || `退出码 ${res.status}`).slice(0, 300);
  results.push({ name: probe.name, pass, detail });
  process.stdout.write(`${pass ? "✅" : "❌"} ${probe.name}${pass ? "" : ` — ${detail}`}\n`);
}

const failed = results.filter(r => !r.pass);
process.stdout.write(`\n${failed.length === 0 ? "全部适配，可以发起测评。" : `${failed.length}/${results.length} 项不适配：${failed.map(f => f.name).join("、")}。需修评测工具适配器后重跑本探针。`}\n`);
process.exit(failed.length === 0 ? 0 : 1);