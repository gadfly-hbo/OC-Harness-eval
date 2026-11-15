import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { loadSuite, hashSuite } from "./suite.ts";
import { loadOptraCallTemplate, hashTemplate, optracallConfiguration, optracallManifestSection, readPiApiKey, OPTRACALL_SUBJECT_PROFILE } from "./optracall-setup.ts";
import { prepareOptraCallEnvironments } from "./optracall-env.ts";

const suiteDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "suites");

test("产品环境套件可加载，optracall 与 templateDir 纳入判据指纹", () => {
  const suite = loadSuite(join(suiteDir, "optracall-data-analysis-v1.json"));
  assert.equal(suite.optracall?.skillName, "data-analysis");
  const base = hashSuite(suite);
  const changedSkill = hashSuite({ ...suite, optracall: { ...suite.optracall!, skillName: "other" } });
  const changedTemplate = hashSuite({ ...suite, tasks: suite.tasks.map((task, index) => index === 0 ? { ...task, templateDir: "x" } : task) });
  assert.notEqual(base, changedSkill);
  assert.notEqual(base, changedTemplate);
});

test("模板加载读取 020_clean 平铺文件，两侧一致", () => {
  const suite = loadSuite(join(suiteDir, "optracall-data-analysis-v1.json"));
  const files = loadOptraCallTemplate(suiteDir, suite, "attr-sales");
  assert.equal(files.length, 2);
  assert.ok(files.every(file => file.directory === "020_clean"));
  assert.ok(files.some(file => file.name === "sales.csv"));
  assert.match(hashTemplate(files), /^[a-f0-9]{64}$/);
  assert.equal(hashTemplate(files), hashTemplate(loadOptraCallTemplate(suiteDir, suite, "attr-sales")));
});

test("配置身份含模型线路但不含 apiKey", () => {
  const configuration = optracallConfiguration("secret-key");
  assert.equal(configuration.provider, OPTRACALL_SUBJECT_PROFILE.provider);
  assert.equal(configuration.apiKey, "secret-key");
  const source = mkdtempSync(join(tmpdir(), "optracall-setup-src-"));
  const runRoot = mkdtempSync(join(tmpdir(), "optracall-setup-run-"));
  try {
    const write = (rel: string, content: string) => { const path = join(source, rel); mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, content); };
    write("package.json", "{}");
    write("extensions/analysis-assets/data-analysis/SKILL.md", "---\nname: data-analysis\n---\n");
    write("node_modules/@earendil-works/pi-coding-agent/package.json", JSON.stringify({ version: "1.4.0" }));
    write("node_modules/@earendil-works/pi-coding-agent/dist/index.js", "export {};\n");
    const envs = prepareOptraCallEnvironments({ sourceRoot: source, skillName: "data-analysis", envRoot: join(runRoot, "env") });
    const section = optracallManifestSection(envs, configuration, "/node26");
    assert.equal(section.configuration.model, "MiniMax-M3.1-Flash");
    assert.ok(!JSON.stringify(section).includes("secret-key"));
    assert.equal(section.sdk?.version, "1.4.0");
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(runRoot, { recursive: true, force: true });
  }
});

test("readPiApiKey 从隔离 home 读取，缺失即报错", () => {
  const home = mkdtempSync(join(tmpdir(), "optracall-home-"));
  try {
    assert.throws(() => readPiApiKey(home, "minimax-cn"), /OPTRACALL_CREDENTIAL_MISSING/);
    const authDir = join(home, ".pi", "agent");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), JSON.stringify({ "minimax-cn": { type: "api_key", key: "k-123" } }));
    assert.equal(readPiApiKey(home, "minimax-cn"), "k-123");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});