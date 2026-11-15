import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { diffEnvManifests, prepareOptraCallEnvironments, verifyOptraCallEnvironments } from "./optracall-env.ts";

function fixtureSource(): string {
  const root = mkdtempSync(join(tmpdir(), "optracall-env-src-"));
  const write = (rel: string, content: string) => {
    const path = join(root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  };
  write("package.json", JSON.stringify({ name: "optracall-fixture" }));
  write("src/agent/project-session.ts", "export const x = 1;\n");
  write("scripts/start-host.mjs", "// host\n");
  write("extensions/analysis-assets/data-analysis/SKILL.md", "---\nname: data-analysis\n---\nbody\n");
  write("extensions/analysis-assets/data-analysis/references/a.md", "ref\n");
  write("extensions/analysis-assets/other-skill/SKILL.md", "---\nname: other\n---\n");
  write("node_modules/@earendil-works/pi-coding-agent/package.json", JSON.stringify({ version: "1.4.0" }));
  write("node_modules/@earendil-works/pi-coding-agent/dist/index.js", "export {};\n");
  return root;
}

test("双环境唯一差异是目标 skill 包，其余逐字节一致", () => {
  const source = fixtureSource();
  const envRoot = join(source, "..", `env-${Date.now()}`);
  try {
    const envs = prepareOptraCallEnvironments({ sourceRoot: source, skillName: "data-analysis", envRoot });
    assert.equal(envs.baseline.skillPath, null);
    assert.ok(envs.skill.skillPath?.endsWith(join("extensions", "analysis-assets", "data-analysis", "SKILL.md")));
    assert.ok(!existsSync(join(envs.baseline.codeRoot, "extensions/analysis-assets/data-analysis")));
    assert.ok(existsSync(join(envs.skill.codeRoot, "extensions/analysis-assets/data-analysis/SKILL.md")));
    // 其余内置 skill 两侧都在。
    assert.ok(existsSync(join(envs.baseline.codeRoot, "extensions/analysis-assets/other-skill/SKILL.md")));
    assert.ok(existsSync(join(envs.skill.codeRoot, "extensions/analysis-assets/other-skill/SKILL.md")));
    // node_modules 共享同一目标。
    assert.equal(envs.manifests.baseline.nodeModulesTarget, join(source, "node_modules"));
    assert.equal(envs.manifests.baseline.sdk?.version, "1.4.0");
    assert.deepEqual(diffEnvManifests(envs.manifests.baseline, envs.manifests.skill, "data-analysis"), []);
    assert.deepEqual(verifyOptraCallEnvironments(envs), []);
    // 目标 skill 内容与源一致。
    assert.equal(
      readFileSync(join(envs.skill.codeRoot, "extensions/analysis-assets/data-analysis/SKILL.md"), "utf8"),
      readFileSync(join(source, "extensions/analysis-assets/data-analysis/SKILL.md"), "utf8"),
    );
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(envRoot, { recursive: true, force: true });
  }
});

test("运行后文件漂移与新增文件被核验捕获", () => {
  const source = fixtureSource();
  const envRoot = join(source, "..", `env-drift-${Date.now()}`);
  try {
    const envs = prepareOptraCallEnvironments({ sourceRoot: source, skillName: "data-analysis", envRoot });
    writeFileSync(join(envs.skill.codeRoot, "src/agent/project-session.ts"), "export const x = 2;\n");
    writeFileSync(join(envs.baseline.codeRoot, "intruder.txt"), "x");
    const issues = verifyOptraCallEnvironments(envs);
    assert.ok(issues.some(item => item.includes("文件漂移")));
    assert.ok(issues.some(item => item.includes("新增文件")));
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(envRoot, { recursive: true, force: true });
  }
});

test("缺少目标 skill 或依赖时拒绝准备", () => {
  const source = fixtureSource();
  const envRoot = join(source, "..", `env-missing-${Date.now()}`);
  try {
    assert.throws(() => prepareOptraCallEnvironments({ sourceRoot: source, skillName: "nope", envRoot }), /OPTRACALL_SKILL_MISSING/);
    rmSync(join(source, "node_modules"), { recursive: true, force: true });
    assert.throws(() => prepareOptraCallEnvironments({ sourceRoot: source, skillName: "data-analysis", envRoot }), /OPTRACALL_NODE_MODULES_MISSING/);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(envRoot, { recursive: true, force: true });
  }
});

test("源树含符号链接时拒绝复制（fail-closed）", () => {
  const source = fixtureSource();
  const envRoot = join(source, "..", `env-link-${Date.now()}`);
  try {
    symlinkSync(join(source, "package.json"), join(source, "src", "link.json"));
    assert.throws(() => prepareOptraCallEnvironments({ sourceRoot: source, skillName: "data-analysis", envRoot }), /OPTRACALL_ENV_SYMLINK/);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(envRoot, { recursive: true, force: true });
  }
});