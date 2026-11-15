/**
 * OptraCall 评测装配：模板资料、凭证读取、配置身份与冻结清单段。
 * 供 CLI 在 `eval --optracall` 分支调用；真实运行凭证仅来自 --home 的 Pi 隔离配置。
 */
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { SuiteFile } from "./suite.ts";
import type { OptraCallEnvironments } from "./optracall-env.ts";
import type { OptraCallTemplateFile } from "./optracall-execution.ts";
import type { OptraCallConfigurationInput } from "./optracall-driver.ts";

/** v1 被评模型固定为受控成本 profile 的 subject（OptraCall 预设 minimax-m31-flash）。 */
export const OPTRACALL_SUBJECT_PROFILE = Object.freeze({
  provider: "minimax-cn",
  api: "anthropic-messages" as const,
  baseUrl: "https://api.minimaxi.com/anthropic",
  model: "MiniMax-M3.1-Flash",
  thinkingLevel: "high",
});

export function optracallConfiguration(apiKey: string): OptraCallConfigurationInput {
  return { name: "skill-eval", ...OPTRACALL_SUBJECT_PROFILE, apiKey };
}

/** 从 --home 的 Pi 隔离配置读取指定 provider 的 API key；不触碰用户真实 ~/.optracall。 */
export function readPiApiKey(home: string | undefined, provider: string): string {
  const root = home ?? homedir();
  const authPath = join(root, ".pi", "agent", "auth.json");
  if (!existsSync(authPath)) throw new Error(`OPTRACALL_CREDENTIAL_MISSING: 未找到 ${authPath}；请用 --home 指定含 Pi 凭据的隔离配置`);
  const auth = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, { type?: string; key?: string }>;
  const key = auth[provider]?.key;
  if (typeof key !== "string" || !key.trim()) throw new Error(`OPTRACALL_CREDENTIAL_MISSING: ${authPath} 缺少 ${provider} 的 api_key`);
  return key;
}

function flatFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".DS_Store") continue;
    if (entry.isDirectory()) throw new Error(`OPTRACALL_TEMPLATE_NESTED: 模板暂不支持子目录 ${join(directory, entry.name)}`);
    if (entry.isSymbolicLink()) throw new Error(`OPTRACALL_TEMPLATE_SYMLINK: ${join(directory, entry.name)}`);
    if (entry.isFile()) out.push(entry.name);
  }
  return out.sort();
}

/** 读取本题初始资料模板（010_draw/020_clean 平铺文件），两侧完全一致。 */
export function loadOptraCallTemplate(suiteDir: string, suite: SuiteFile, taskId: string): OptraCallTemplateFile[] {
  const task = suite.tasks.find(item => item.id === taskId);
  const templateDir = task?.templateDir ?? suite.optracall?.templateDir;
  if (!templateDir) return [];
  const root = join(suiteDir, templateDir);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) throw new Error(`OPTRACALL_TEMPLATE_MISSING: ${root}`);
  const files: OptraCallTemplateFile[] = [];
  for (const directory of ["010_draw", "020_clean"] as const) {
    for (const name of flatFiles(join(root, directory))) {
      files.push({ name, directory, bytes: readFileSync(join(root, directory, name)) });
    }
  }
  return files;
}

export function optracallManifestSection(envs: OptraCallEnvironments, configuration: OptraCallConfigurationInput, nodePath: string | undefined) {
  const manifestHash = createHash("sha256").update(JSON.stringify(envs.manifests)).digest("hex");
  return {
    sourceRoot: envs.sourceRoot,
    commit: envs.commit,
    dirty: envs.dirty,
    skillName: envs.skillName,
    sdk: envs.manifests.skill.sdk,
    envManifestHash: manifestHash,
    excluded: envs.excluded,
    nodePath: nodePath ?? null,
    configuration: {
      provider: configuration.provider, model: configuration.model, baseUrl: configuration.baseUrl,
      api: configuration.api, thinkingLevel: configuration.thinkingLevel ?? null,
    },
  };
}

/** 模板内容指纹（纳入冻结清单，检测初始资料漂移）。 */
export function hashTemplate(files: OptraCallTemplateFile[]): string {
  const payload = files.map(file => ({ name: file.name, directory: file.directory, sha256: createHash("sha256").update(file.bytes).digest("hex") }));
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}