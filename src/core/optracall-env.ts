/**
 * OptraCall 对照环境准备。
 *
 * 唯一变量：两份 codeRoot 除 `extensions/analysis-assets/<skillName>/` 外逐字节一致。
 * node_modules 是指向同一冻结安装的只读共享符号链接；每侧独立 dataRoot/projectsRoot。
 * 环境身份用全量 SHA-256 清单核验，运行前后都比对照样，漂移即 Host 故障。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync } from "node:fs";
import { join, relative, sep } from "node:path";

export type OptraCallSide = "baseline" | "skill";

export interface OptraCallSideEnv {
  side: OptraCallSide;
  codeRoot: string;
  dataRoot: string;
  projectsRoot: string;
  /** 目标 skill 在本侧 codeRoot 内的 SKILL.md 绝对路径；baseline 为 null。 */
  skillPath: string | null;
}

export interface OptraCallEnvManifest {
  /** codeRoot 内全部普通文件的相对路径 → SHA-256。 */
  files: Record<string, string>;
  /** 共享 node_modules 符号链接的目标。 */
  nodeModulesTarget: string;
  sdk: { version: string; entrySha256: string } | null;
}

export interface OptraCallEnvironments {
  sourceRoot: string;
  commit: string | null;
  dirty: boolean | null;
  /** skill 模式为目标 skill 名；能力开关模式为 null（双 codeRoot 全等）。 */
  skillName: string | null;
  baseline: OptraCallSideEnv;
  skill: OptraCallSideEnv;
  manifests: { baseline: OptraCallEnvManifest; skill: OptraCallEnvManifest };
  /** 复制时排除的顶层目录（不影响无头 API 运行）。 */
  excluded: string[];
}

// 排除依赖、版本库、构建产物、运行时状态与私有材料；两侧一致排除，不影响无头 API 运行。
// .local 含私有凭据/材料，绝不复制进评测环境；.runtime 是运行时 Python 等状态，评测用系统 python3。
const EXCLUDED_TOP = ["node_modules", ".git", "dist", ".runtime", ".local"];
const SKILL_ROOT = join("extensions", "analysis-assets");

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function listFiles(root: string, base = root): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      // 唯一允许的链接是我们创建的共享 node_modules。
      if (root === base && entry.name === "node_modules") continue;
      throw new Error(`OPTRACALL_ENV_SYMLINK: 树含符号链接 ${path}`);
    }
    if (entry.isDirectory()) out.push(...listFiles(path, base));
    else if (entry.isFile()) out.push(relative(base, path));
    else throw new Error(`OPTRACALL_ENV_SPECIAL_FILE: ${path}`);
  }
  return out;
}

function copyTree(source: string, destination: string, skipAbs: string | null, excludeAbs: string[]): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === ".DS_Store") continue;
    const from = join(source, entry.name), to = join(destination, entry.name);
    if (skipAbs && (from === skipAbs || from.startsWith(skipAbs + sep))) continue;
    if (excludeAbs.some(path => from === path || from.startsWith(path + sep))) continue;
    if (entry.isSymbolicLink()) throw new Error(`OPTRACALL_ENV_SYMLINK: 源树含符号链接 ${from}`);
    if (entry.isDirectory()) copyTree(from, to, skipAbs, excludeAbs);
    else if (entry.isFile()) copyFileSync(from, to);
    else throw new Error(`OPTRACALL_ENV_SPECIAL_FILE: ${from}`);
  }
}

function manifestOf(codeRoot: string, nodeModulesTarget: string): OptraCallEnvManifest {
  const files: Record<string, string> = {};
  for (const rel of listFiles(codeRoot).sort()) files[rel] = sha256(join(codeRoot, rel));
  let sdk: OptraCallEnvManifest["sdk"] = null;
  const pkgPath = join(nodeModulesTarget, "@earendil-works", "pi-coding-agent", "package.json");
  const entryPath = join(nodeModulesTarget, "@earendil-works", "pi-coding-agent", "dist", "index.js");
  if (existsSync(pkgPath) && existsSync(entryPath)) {
    sdk = { version: String(JSON.parse(readFileSync(pkgPath, "utf8")).version ?? ""), entrySha256: sha256(entryPath) };
  }
  return { files, nodeModulesTarget, sdk };
}

function gitIdentity(sourceRoot: string): { commit: string | null; dirty: boolean | null } {
  if (!existsSync(join(sourceRoot, ".git"))) return { commit: null, dirty: null };
  const commit = spawnSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
  const status = spawnSync("git", ["-C", sourceRoot, "status", "--porcelain"], { encoding: "utf8" });
  if (commit.status !== 0 || status.status !== 0) return { commit: null, dirty: null };
  return { commit: commit.stdout.trim(), dirty: status.stdout.trim().length > 0 };
}

/** skill 模式：唯一允许差异是 skill 侧多出目标 skill 包。能力模式（skillName=null）：两侧必须全等。 */
export function diffEnvManifests(baseline: OptraCallEnvManifest, skill: OptraCallEnvManifest, skillName: string | null): string[] {
  const issues: string[] = [];
  if (skillName === null) {
    for (const [path, hash] of Object.entries(skill.files)) {
      if (baseline.files[path] !== hash) issues.push(`两侧文件不一致：${path}`);
    }
    for (const path of Object.keys(baseline.files)) {
      if (!(path in skill.files)) issues.push(`baseline 独有文件：${path}`);
    }
  } else {
    const prefix = join(SKILL_ROOT, skillName) + sep;
    const skillOnly: Record<string, string> = {};
    for (const [path, hash] of Object.entries(skill.files)) {
      if (path.startsWith(prefix)) { skillOnly[path] = hash; continue; }
      if (baseline.files[path] !== hash) issues.push(`两侧文件不一致：${path}`);
    }
    for (const path of Object.keys(baseline.files)) {
      if (!(path in skill.files)) issues.push(`baseline 独有文件：${path}`);
    }
    if (!Object.keys(skillOnly).some(path => path === join(SKILL_ROOT, skillName, "SKILL.md"))) {
      issues.push(`skill 侧缺少目标 skill 入口：${join(SKILL_ROOT, skillName, "SKILL.md")}`);
    }
  }
  if (baseline.nodeModulesTarget !== skill.nodeModulesTarget) issues.push("两侧 node_modules 目标不一致");
  if (JSON.stringify(baseline.sdk) !== JSON.stringify(skill.sdk)) issues.push("两侧 SDK 身份不一致");
  return issues;
}

export function prepareOptraCallEnvironments(options: {
  sourceRoot: string;
  /** 提供则 skill 模式（baseline 删包）；缺省则能力开关模式（双 codeRoot 全等）。 */
  skillName?: string;
  envRoot: string;
}): OptraCallEnvironments {
  const sourceRoot = options.sourceRoot;
  const skillName = options.skillName ?? null;
  if (skillName !== null) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(skillName)) throw new Error("OPTRACALL_SKILL_NAME_INVALID");
    const skillSource = join(sourceRoot, SKILL_ROOT, skillName);
    if (!existsSync(join(skillSource, "SKILL.md"))) throw new Error(`OPTRACALL_SKILL_MISSING: ${skillSource}`);
  }
  const nodeModules = join(sourceRoot, "node_modules");
  if (!existsSync(nodeModules) || !lstatSync(nodeModules).isDirectory()) throw new Error("OPTRACALL_NODE_MODULES_MISSING: 源 checkout 须已安装依赖");
  if (existsSync(options.envRoot)) throw new Error("OPTRACALL_ENV_EXISTS: 环境目录已存在，禁止覆盖");

  const sides: Record<OptraCallSide, OptraCallSideEnv> = {} as Record<OptraCallSide, OptraCallSideEnv>;
  for (const side of ["baseline", "skill"] as const) {
    const root = join(options.envRoot, side);
    const codeRoot = join(root, "code");
    const removeSkill = skillName !== null && side === "baseline" ? join(sourceRoot, SKILL_ROOT, skillName) : null;
    copyTree(sourceRoot, codeRoot, removeSkill, EXCLUDED_TOP.map(name => join(sourceRoot, name)));
    symlinkSync(nodeModules, join(codeRoot, "node_modules"), "dir");
    const dataRoot = join(root, "data"), projectsRoot = join(root, "projects");
    mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
    mkdirSync(projectsRoot, { recursive: true, mode: 0o700 });
    sides[side] = {
      side, codeRoot, dataRoot, projectsRoot,
      skillPath: skillName !== null && side === "skill" ? join(codeRoot, SKILL_ROOT, skillName, "SKILL.md") : null,
    };
  }
  const manifests = {
    baseline: manifestOf(sides.baseline.codeRoot, nodeModules),
    skill: manifestOf(sides.skill.codeRoot, nodeModules),
  };
  const issues = diffEnvManifests(manifests.baseline, manifests.skill, skillName);
  if (issues.length) throw new Error(`OPTRACALL_ENV_IDENTITY: ${issues.join("；")}`);
  const { commit, dirty } = gitIdentity(sourceRoot);
  return { sourceRoot, commit, dirty, skillName, baseline: sides.baseline, skill: sides.skill, manifests, excluded: EXCLUDED_TOP };
}

/** 运行前后复核环境身份；返回漂移清单（空 = 一致）。 */
export function verifyOptraCallEnvironments(envs: OptraCallEnvironments): string[] {
  const issues: string[] = [];
  for (const side of ["baseline", "skill"] as const) {
    const env = envs[side];
    const link = join(env.codeRoot, "node_modules");
    try {
      if (!lstatSync(link).isSymbolicLink() || readlinkSync(link) !== envs.manifests[side].nodeModulesTarget) {
        issues.push(`${side} node_modules 链接变化`);
      }
    } catch { issues.push(`${side} node_modules 链接缺失`); }
    let current: OptraCallEnvManifest;
    try { current = manifestOf(env.codeRoot, envs.manifests[side].nodeModulesTarget); }
    catch { issues.push(`${side} codeRoot 无法读取`); continue; }
    const frozen = envs.manifests[side];
    for (const [path, hash] of Object.entries(frozen.files)) {
      if (current.files[path] !== hash) issues.push(`${side} 文件漂移：${path}`);
    }
    for (const path of Object.keys(current.files)) {
      if (!(path in frozen.files)) issues.push(`${side} 新增文件：${path}`);
    }
    if (JSON.stringify(current.sdk) !== JSON.stringify(frozen.sdk)) issues.push(`${side} SDK 身份漂移`);
  }
  issues.push(...diffEnvManifests(envs.manifests.baseline, envs.manifests.skill, envs.skillName));
  return issues;
}