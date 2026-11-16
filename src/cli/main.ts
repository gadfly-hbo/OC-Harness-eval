#!/usr/bin/env node
/**
 * skill-eval 命令行入口。
 *
 * 子命令：
 *   eval       执行受控对照评估并生成报告
 *   preflight  只读核验 Pi 完整本地目录中的精确模型身份
 *   check      静态校验套件质量（可选结合 --run 做实证灵敏度体检）
 *   report     从已有运行产物重新生成报告
 *   archive    归档通过测评的 skill 快照
 *   verify     阴性对照元评估（生成契约剥离版 skill 或验证原版 vs 破坏版区分度）
 *   calibrate  导出人工匿名盲审表或计算人机评委一致性（Cohen's κ）
 *   pending    管理待测评 skill 暂存区
 *   threshold  查看全局判定门槛与回归门禁阈值
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { dirname, resolve, join, isAbsolute, basename, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { NativeModelLimitsByRole } from "../core/controlled-budget.ts";
import {
  runEvaluation,
  recomputeSummary,
  newRunId,
  type EvalTask,
  type Variant,
  type EvaluationSummary,
} from "../core/runner.ts";
import { renderReport, hashFile, type ReportMeta } from "../report/markdown.ts";
import {
  DEFAULT_THRESHOLDS,
  parseThresholds,
  type RegressionThresholds,
} from "../core/regression.ts";
import { expandTilde } from "../core/paths.ts";
import { evaluateGainFromResults, DEFAULT_GAIN_THRESHOLD_PP } from "../core/gain.ts";
import { recoverMetaFromReport, mergeMeta } from "../core/report-meta.ts";
import { decideVerdict, type VerdictDecision } from "../core/verdict.ts";
import {
  loadSuite,
  checkSuite,
  hashSuite,
  type SuiteFile,
} from "../core/suite.ts";
import {
  evaluateNegativeControl,
  formatNegativeControlReport,
  stripBehavioralContract,
} from "../core/verify.ts";
import {
  exportCalibrationSheet,
  evaluateCalibration,
  type BlindReviewSheet,
  type CalibrationAnswerKey,
  type CalibrationResult,
} from "../core/calibration.ts";
import { type SkillDocContext } from "../core/improve.ts";
import {
  ACTIVATION_THRESHOLD,
  COST_WARN_TOKENS_PER_PP,
  COST_WARN_TOKEN_RATIO,
  DEFAULT_JUDGE_REPEAT,
  DEFAULT_REPEAT,
  GAIN_THRESHOLD_PP,
  GAIN_STRONG_THRESHOLD_PP,
  MAX_FALSE_ACTIVATION_RATE,
  MAX_VARIANT_TIMEOUT_RATE,
  MIN_JUDGED_PAIRS,
  MIN_PAIR_COVERAGE,
  MIN_WIN_RATE_LOWER_BOUND,
  WIN_RATE_RELAXED_THRESHOLD,
  WIN_RATE_THRESHOLD,
} from "../core/thresholds.ts";

import { freezeSkill } from "../core/provenance.ts";
import { assertFreshRunRoot, saveRunManifest, loadRunManifest, frozenSkillPath, relativeSnapshotDir, EVALUATION_POLICY_VERSION, type RunManifest } from "../core/run-manifest.ts";
import { preflightModels } from "../core/model-preflight.ts";
import { validateControlledPlan, type EvaluationExecution } from "../core/execution.ts";
import { captureEvaluatorIdentity, type EvaluationRuntimeIdentity } from "../core/runtime-identity.ts";
import { prepareOptraCallEnvironments } from "../core/optracall-env.ts";
import { createOptraCallExecution } from "../core/optracall-execution.ts";
import { resolveOptraCallNode } from "../core/optracall-driver.ts";
import { OPTRACALL_SUBJECT_PROFILE, optracallConfiguration, readPiApiKey, loadOptraCallTemplate, optracallManifestSection, hashTemplate } from "../core/optracall-setup.ts";
import { CAPABILITIES } from "../core/optracall-capabilities.ts";

interface CliArgs {
  command: string;
  flags: Record<string, string | boolean>;
}

/** 解析命令行参数。支持 `--key value` 与 `--key=value`。 */
export function parseArgs(argv: string[]): CliArgs {
  const [command = "help", ...rest] = argv;
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!;
    if (!token.startsWith("--")) continue;

    const body = token.slice(2);
    if (body.includes("=")) {
      const [key, ...valueParts] = body.split("=");
      flags[key!] = valueParts.join("=");
      continue;
    }

    const next = rest[i + 1];
    if (next && !next.startsWith("--")) {
      flags[body] = next;
      i += 1;
    } else {
      flags[body] = true;
    }
  }

  return { command, flags };
}

function flagString(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

function flagNumber(flags: Record<string, string | boolean>, key: string): number | undefined {
  const value = flagString(flags, key);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function positiveInteger(flags: Record<string, string | boolean>, key: string, fallback: number): number {
  const value = flags[key] === undefined ? fallback : Number(flagString(flags, key));
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`参数 --${key} 必须为正整数`);
  return value;
}

function rejectUnbudgetedAdvice(flags: Record<string, string | boolean>): void {
  if (flags["llm-advice"] !== undefined) {
    throw new Error("--llm-advice 额外调用入口已退役；请使用报告中的离线改进建议");
  }
}

/** eval 与只读预检共享选型优先级，不依赖交互式 Pi 的默认模型。 */
function modelSelection(flags: Record<string, string | boolean>) {
  for (const key of ["model", "models", "judge-model", "home"]) {
    if (flags[key] !== undefined && (typeof flags[key] !== "string" || !String(flags[key]).trim())) {
      throw new Error(`参数 --${key} 缺少非空值；不会回退到其他模型或配置`);
    }
  }
  const modelsFlag = flagString(flags, "models");
  const modelList = modelsFlag ? modelsFlag.split(",").map((model) => model.trim()).filter(Boolean) : [];
  if (modelsFlag !== undefined && modelList.length === 0) throw new Error("参数 --models 必须包含模型");
  const singleModel = flagString(flags, "model") ?? process.env.SKILL_EVAL_MODEL;
  return {
    modelList,
    singleModel,
    models: modelList.length ? modelList : singleModel ? [singleModel] : [],
    judgeOverride: flagString(flags, "judge-model") ?? process.env.SKILL_EVAL_JUDGE_MODEL,
    piHome: flagString(flags, "home") ?? process.env.SKILL_EVAL_PI_HOME ?? undefined,
  };
}

function printHelp(): void {
  process.stdout.write(`skill-eval — 独立评估 Agent Skill 的激活率与实际增益

用法：
  skill-eval eval --suite <套件.json> --optracall <checkout> [选项]
  skill-eval preflight --model <provider/model> [--judge-model <provider/model>] [--home <dir>]
  skill-eval check --suite <套件.json> [--run <运行目录>] [--strict]
  skill-eval report --run <运行目录> [--suite-file <套件.json>]
  skill-eval verify --original <原版目录> --broken <破坏版目录>
  skill-eval verify --generate-broken <SKILL.md> --out <输出目录>
  skill-eval calibrate --run <运行目录> --export <盲审表.json>
  skill-eval calibrate --run <运行目录> --score <已填盲审表.json>
  skill-eval threshold [--score-drop <n>] [--activation-rate-drop <n>]

eval 选项（仅 OptraCall 产品环境套件）：
  --suite <path>          评估套件定义（必填，须声明 optracall 段）
  --optracall <path>      OptraCall checkout 路径（必填）
  --optracall-node <path> Host/worker 解释器（Node 25+；默认当前解释器）
  --model <id>            被评模型：minimax-cn/MiniMax-M3.1-Flash
  --judge-model <id>      评委：xiaomi-token-plan-cn/mimo-v2.6-flash（须显式指定或设置环境变量）
  --repeat <n>            每用例重复次数（默认取套件值或 ${DEFAULT_REPEAT}）
  --judge-repeat <n>      评委轮数，≥2 启用位置偏好探测（默认取套件值或 ${DEFAULT_JUDGE_REPEAT}）
  --out <dir>             输出目录（默认 runs/<run-id>）
  --home <dir>            pi 隔离 HOME（读取被评模型凭据），避免污染全局配置
  --context <text>        附加上下文前缀（覆盖套件）
  --no-keyword-signal     关闭关键词弱证据，仅用工具调用取证
  --timeout <ms>          显式设置单次运行超时（默认不设）
  --judge-timeout <ms>    显式设置评委单次超时（默认不设）
  --gain-threshold <pp>   增益门槛（百分点，默认 ${GAIN_THRESHOLD_PP}）

当前模型费用记录配置：被评与评委使用模型原生上下文和输出上限，保留 SDK 原生思考与恢复。
诊断题与全部评委轮次同样计入会话规划；不会替换未受支持的模型。
不设预算封顶、固定会话上限或默认执行超时；费用与全部调用仍留痕。

preflight 选项：
  --model / --models     被评模型；选型与 eval 相同，要求精确 provider/model
  --judge-model <id>      评委模型；未指定时使用环境变量或被评模型
  --home <dir>            模型配置来源 HOME；只读核验合并目录，输出 JSON，不调用 Provider

check 选项：
  --suite <path>          校验套件结构、正则合法性、恒真断言与负向断言覆盖
  --run <dir>             结合历史跑批结果诊断「白送断言」（baseline ≥ 80%）与零区分度用例
  --strict                存在警告时也返回非零退出码

verify 选项：
  --generate-broken <p>   剥离 SKILL.md 的正文行为契约（保留 frontmatter 触发契约）写入 --out
  --out <dir>             生成的破坏版 skill 目录
  --original <dir>        原版 skill 跑批产物目录
  --broken <dir>          破坏版 skill 跑批产物目录
  --gain-threshold <pp>   区分度增益门槛（默认 ${GAIN_THRESHOLD_PP}）
  --json                  以 JSON 输出验证结果

calibrate 选项：
  --run <dir>             评估运行目录（必填）
  --export <file>         导出打乱 A/B 顺序的匿名盲审表 JSON
  --score <file>          读取人工回填的盲审表，计算一致率、Cohen's κ 与乐观偏置
  --suite-file <path>     旧运行缺少任务定义时使用的套件
  --limit <n>             限制导出的抽检对数
`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case "eval":
      return await commandEval(args);
    case "memory-eval":
    case "capability-eval":
      return await commandCapabilityEval(args);
    case "preflight":
      return await commandPreflight(args);
    case "check":
      return commandCheck(args);
    case "report":
      return await commandReport(args);
    case "verify":
      return commandVerify(args);
    case "calibrate":
      return commandCalibrate(args);
    case "threshold":
      return commandThreshold(args);
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return 0;
    default:
      process.stderr.write(`未知命令: ${args.command}\n\n`);
      printHelp();
      return 1;
  }
}

async function commandPreflight(args: CliArgs): Promise<number> {
  const selection = modelSelection(args.flags);
  const result = await preflightModels({ models: selection.models, judgeModel: selection.judgeOverride, home: selection.piHome });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return result.valid ? 0 : 1;
}

/** 收集 SKILL.md 与包内附属文档内容，供优化建议定位规则是在主文件、未读附属文件还是完全缺失。 */
function buildSkillDocContext(
  skillPath: string | undefined,
  summary: EvaluationSummary,
): SkillDocContext | undefined {
  if (!skillPath || !existsSync(skillPath)) return undefined;
  let skillContent = "";
  try {
    skillContent = readFileSync(skillPath, "utf8");
  } catch {
    return undefined;
  }

  const skillDir = dirname(resolve(skillPath));
  const subFiles: Record<string, string> = {};
  const scanSubDir = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        scanSubDir(full);
      } else if (
        entry.isFile() &&
        full !== resolve(skillPath) &&
        (entry.name.endsWith(".md") || entry.name.endsWith(".txt"))
      ) {
        try {
          const rel = relative(skillDir, full).replace(/\\/g, "/");
          subFiles[rel] = readFileSync(full, "utf8").slice(0, 65536);
        } catch {
          // 忽略不可读文件
        }
      }
    }
  };
  scanSubDir(skillDir);

  const readSubSet = new Set<string>();
  for (const row of summary.results) {
    if (row.variantId === "baseline") continue;
    for (const p of row.activation?.readSubPaths ?? []) {
      readSubSet.add(p);
    }
  }

  return {
    skillContent,
    subFiles,
    readSubPaths: Array.from(readSubSet),
  };
}

function loadCalibrationIfPresent(runDir: string): CalibrationResult | null {
  const p = join(runDir, "calibration-result.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as CalibrationResult;
  } catch {
    return null;
  }
}

function commandCheck(args: CliArgs): number {
  const suitePath = flagString(args.flags, "suite");
  if (!suitePath) {
    process.stderr.write("缺少 --suite\n");
    return 1;
  }

  try {
    const suite = loadSuite(suitePath);
    const runDir = flagString(args.flags, "run");
    let empiricalSummary: EvaluationSummary | undefined;
    if (runDir) {
      const summaryPath = join(resolve(runDir), "summary.json");
      if (!existsSync(summaryPath)) {
        process.stderr.write(`未找到历史运行摘要：${summaryPath}\n`);
        return 1;
      }
      empiricalSummary = JSON.parse(readFileSync(summaryPath, "utf8")) as EvaluationSummary;
    }

    const report = checkSuite(suite, empiricalSummary);
    const s = report.stats;

    process.stdout.write(
      `${report.valid ? "套件校验通过" : "套件校验失败"}：${suite.id}（${report.suiteHash}）\n`,
    );
    process.stdout.write(
      `  用例总数：${s.taskCount}（计分 ${s.scoredCount} / 诊断 ${s.diagnosticCount} / 负向误触发 ${s.negativeTriggerCount}）\n`,
    );
    process.stdout.write(
      `  断言条数：${s.assertionCount}（含负向红线断言 ${s.negativeAssertionCount}）\n`,
    );
    process.stdout.write(`  重复次数：${suite.repeat ?? `${DEFAULT_REPEAT}（默认）`}\n`);
    process.stdout.write(`  评委轮数：${suite.judgeRepeat ?? `${DEFAULT_JUDGE_REPEAT}（默认）`}\n`);

    if (report.errors.length > 0) {
      process.stderr.write("\n❌ 错误（必须修复）：\n");
      for (const err of report.errors) {
        process.stderr.write(`  - ${err}\n`);
      }
    }

    if (report.warnings.length > 0) {
      process.stdout.write("\n⚠️ 质量提示：\n");
      for (const warn of report.warnings) {
        process.stdout.write(`  - ${warn}\n`);
      }
    }

    if (!report.valid) return 1;
    if (args.flags["strict"] === true && report.warnings.length > 0) return 1;
    return 0;
  } catch (error) {
    process.stderr.write(`套件校验失败：${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function runSingleModelEval(params: {
  suite: SuiteFile;
  suiteHash: string;
  skillPath: string;
  model: string;
  judgeModel: string;
  nativeLimits: NativeModelLimitsByRole;
  repeat: number;
  judgeRepeat: number;
  outDir: string;
  runId: string;
  piHome: string | undefined;
  contextPrefix: string | undefined;
  keywordSignal: boolean;
  timeoutMs: number | undefined;
  judgeTimeoutMs: number | undefined;
  gainThresholdPp: number | undefined;
  runtimeIdentity: EvaluationRuntimeIdentity;
  signal: AbortSignal;
  /** 产品环境对照：提供 OptraCall checkout 与解释器，执行层在冻结后构建。 */
  optracall?: { sourceRoot: string; nodePath: string | undefined; suiteDir: string };
}): Promise<{ summary: EvaluationSummary; decision: VerdictDecision; reportPath: string }> {
  const { suite, skillPath, model, judgeModel, repeat, judgeRepeat, outDir, runId } = params;
  assertFreshRunRoot(outDir);
  const frozen = freezeSkill(skillPath, join(outDir, ".frozen", "skill"));
  let optracallBuilt: { envs: ReturnType<typeof prepareOptraCallEnvironments>; execution: EvaluationExecution; manifestSection: NonNullable<RunManifest["optracall"]> } | undefined;
  if (params.optracall) {
    const skillName = suite.optracall!.skillName;
    const envs = prepareOptraCallEnvironments({ sourceRoot: params.optracall.sourceRoot, skillName, envRoot: join(outDir, "optracall-env") });
    const configuration = optracallConfiguration(readPiApiKey(params.piHome, OPTRACALL_SUBJECT_PROFILE.provider));
    const execution = createOptraCallExecution({
      mode: "real", runRoot: outDir, envs, model, judgeModel, nativeLimits: params.nativeLimits,
      judgePlannedSessions: suite.tasks.length * repeat * judgeRepeat, home: params.piHome, configuration,
      templateFor: taskId => loadOptraCallTemplate(params.optracall!.suiteDir, suite, taskId),
      nodePath: params.optracall.nodePath, signal: params.signal, timeoutMs: params.timeoutMs,
    });
    const templateHashes = Object.fromEntries(suite.tasks.map(task => [task.id, hashTemplate(loadOptraCallTemplate(params.optracall!.suiteDir, suite, task.id))]));
    optracallBuilt = { envs, execution, manifestSection: { ...optracallManifestSection(envs, configuration, params.optracall.nodePath), templateHashes } };
  }
  const effectiveSuiteHash = hashSuite({ ...suite, contextPrefix: params.contextPrefix });
  const variants: Variant[] = [
    { id: "baseline", label: "Baseline（不装 skill）", skillPaths: [] },
    { id: "skill", label: `Skill（${suite.skill?.version ?? "当前版本"}）`, skillPaths: optracallBuilt ? [optracallBuilt.envs.skill.skillPath!] : [frozen.skillPath] },
  ];
  const manifest: RunManifest = {
    schemaVersion: 1, policyVersion: EVALUATION_POLICY_VERSION, runId, model, judgeModel, repeat, judgeRepeat, judgeSeed: runId,
    tasks: suite.tasks, variants, contextPrefix: params.contextPrefix, runtimeIdentity: params.runtimeIdentity,
    settings: { gainThresholdPp: params.gainThresholdPp ?? GAIN_THRESHOLD_PP, timeoutMs: params.timeoutMs, judgeTimeoutMs: params.judgeTimeoutMs, keywordSignal: params.keywordSignal, nodeVersion: process.version, nativeLimits: params.nativeLimits },
    candidate: { identity: frozen.identity, snapshotDir: relativeSnapshotDir(outDir, frozen.skillPath), originalSkillPath: skillPath },
    suiteMeta: { suiteId: suite.id, suiteVersion: suite.version ?? "未标注", suiteHash: effectiveSuiteHash, skillVersion: suite.skill?.version ?? "未标注", skillPath },
    ...(optracallBuilt ? { optracall: optracallBuilt.manifestSection } : {}),
  };
  saveRunManifest(outDir, manifest);

  const totalRuns = variants.length * suite.tasks.length * repeat;
  process.stderr.write(
    `开始评估：${suite.id}（${params.suiteHash}）\n` +
      `  被测 skill：${skillPath}\n` +
      `  模型：${model}（评委：${judgeModel}）\n` +
      `  用例 ${suite.tasks.length} × 变体 ${variants.length} × 重复 ${repeat} = ${totalRuns} 次运行\n` +
      `  评委轮数：${judgeRepeat}\n` +
      `  输出：${outDir}\n\n`,
  );

  const summary = await runEvaluation({
    runRoot: outDir,
    runId,
    manifest,
    judgeSeed: manifest.judgeSeed,
    model,
    judgeModel,
    nativeLimits: params.nativeLimits,
    signal: params.signal,
    variants,
    tasks: suite.tasks,
    repeat,
    judgeRepeat,
    contextPrefix: params.contextPrefix,
    home: params.piHome,
    keywordSignal: params.keywordSignal,
    timeoutMs: params.timeoutMs,
    judgeTimeoutMs: params.judgeTimeoutMs,
    ...(optracallBuilt ? { execution: optracallBuilt.execution } : {}),
    // 污染检测：baseline 侧若自行读到了被测 skill 或含 skill 路径的元数据文件，
    // 对照实验的唯一变量就被破坏了。检测需要知道 skill 的位置。
    skillPathForContamination: skillPath,
    skillDirForContamination: dirname(resolve(skillPath)),
    onProgress: (event) => {
      process.stderr.write(`  [${event.phase}] ${event.message}\n`);
    },
  });

  summary.suiteMeta = manifest.suiteMeta;
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");

  const decision = decideVerdict(summary, {
    ...(params.gainThresholdPp !== undefined ? { gainThresholdPp: params.gainThresholdPp } : {}),
  });
  const skillContext = buildSkillDocContext(frozen.skillPath, summary);

  const meta: ReportMeta = {
    skillPath,
    skillHash: frozen.identity.hash,
    skillVersion: suite.skill?.version ?? "未标注",
    suiteId: suite.id,
    suiteVersion: suite.version ?? "未标注",
    suiteHash: effectiveSuiteHash,
    runRoot: outDir,
    piHome: params.piHome ?? null,
    generatedAt: new Date().toISOString(),
  };

  const report = renderReport({
    summary,
    meta,
    tasks: suite.tasks,
    variants,
    verdict: decision.verdict,
    expensive: decision.expensive,
    verdictReason: decision.reason,
    skillContext,
    calibration: loadCalibrationIfPresent(outDir),
  });

  const reportPath = join(outDir, "REPORT.md");
  writeFileSync(reportPath, report, "utf8");
  process.stderr.write(`\n报告已生成：${reportPath}\n`);

  return { summary, decision, reportPath };
}

async function commandEval(args: CliArgs): Promise<number> {
  rejectUnbudgetedAdvice(args.flags);
  const suitePath = flagString(args.flags, "suite");
  if (!suitePath) {
    process.stderr.write("缺少 --suite\n");
    return 1;
  }

  const suite = loadSuite(suitePath);
  const suiteCheck = checkSuite(suite);
  if (!suiteCheck.valid) {
    process.stderr.write(`套件存在阻断性错误，无法启动评估：\n  ${suiteCheck.errors.join("\n  ")}\n`);
    return 1;
  }
  const suiteDir = dirname(resolve(suitePath));

  if (!suite.optracall) {
    process.stderr.write("本入口仅支持 OptraCall 产品环境套件：套件须声明 optracall 段（skillName/templateDir）\n");
    return 1;
  }
  const optracallRoot = flagString(args.flags, "optracall");
  if (!optracallRoot) {
    process.stderr.write("产品环境套件需要 --optracall <OptraCall checkout 路径>\n");
    return 1;
  }
  if (suite.optracall.capability) { process.stderr.write("能力套件请用 capability-eval 命令\n"); return 1; }
  if (!suite.optracall.skillName) { process.stderr.write("skill 套件须声明 optracall.skillName\n"); return 1; }
  const skillPath = resolve(optracallRoot, "extensions", "analysis-assets", suite.optracall.skillName, "SKILL.md");
  let optracallNode: string | undefined;
  try { optracallNode = resolveOptraCallNode(flagString(args.flags, "optracall-node")); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); return 1; }
  if (!existsSync(skillPath)) {
    process.stderr.write(`被测 skill 不存在: ${skillPath}\n`);
    return 1;
  }

  const { modelList, singleModel, models, judgeOverride, piHome } = modelSelection(args.flags);

  if (modelList.length === 0 && !singleModel) {
    process.stderr.write("缺少被评模型：用 --model 或 --models 指定，或设置 SKILL_EVAL_MODEL 环境变量\n");
    return 1;
  }

  const repeat = positiveInteger(args.flags, "repeat", suite.repeat ?? DEFAULT_REPEAT);
  const judgeRepeat = positiveInteger(args.flags, "judge-repeat", suite.judgeRepeat ?? DEFAULT_JUDGE_REPEAT);
  const timeoutMs = flagNumber(args.flags, "timeout");
  const judgeTimeoutMs = flagNumber(args.flags, "judge-timeout");
  const keywordSignal = args.flags["no-keyword-signal"] !== true;
  const contextPrefix = flagString(args.flags, "context") ?? suite.contextPrefix;
  const gainThresholdPp = flagNumber(args.flags, "gain-threshold");

  // Keep historical-output protection ahead of SDK discovery without creating a directory.
  const requestedOut = flagString(args.flags, "out");
  if (requestedOut && existsSync(resolve(requestedOut)) && readdirSync(resolve(requestedOut)).length > 0) {
    throw new Error("运行目录非空，禁止覆盖历史评测记录；请使用新的 --out");
  }
  if (modelList.length > 1) {
    throw new Error("当前真实执行入口只接受单个被评模型；请使用 --model 或单元素 --models");
  }
  const model = (modelList[0] ?? singleModel)!;
  const judgeModel = judgeOverride ?? model;
  // All task kinds are executed and judged. Plan the full successful path before any directory or Provider.
  validateControlledPlan({ model, judgeModel, plannedSessions: suite.tasks.length * repeat * (2 + judgeRepeat) });

  // 核验完整本地目录中的精确身份；缺失时不创建运行目录或启动任何模型会话。
  const modelCheck = await preflightModels({ models, judgeModel: judgeOverride, home: piHome });
  if (!modelCheck.valid) {
    process.stderr.write(`模型预检未通过（未调用 Provider）：\n  ${modelCheck.errors.join("\n  ")}\n`);
    return 1;
  }
  if (!modelCheck.runtime?.sdkEntrySha256) throw new Error("PI_SDK_IDENTITY_MISSING: 未找到 Pi SDK 执行入口");
  const runtimeIdentity: EvaluationRuntimeIdentity = { evaluator: captureEvaluatorIdentity(), piSdk: modelCheck.runtime };
  const limitsFor = (role: "subject" | "judge", reference: string) => {
    const native = modelCheck.models.find(entry => entry.role === role && entry.requested === reference)?.model;
    if (!native || !Number.isSafeInteger(native.contextWindow) || !Number.isSafeInteger(native.maxTokens) || native.contextWindow! < 1 || native.maxTokens! < 1) {
      throw new Error(`模型目录缺少原生 token 上限：${reference}`);
    }
    return { contextWindow: native.contextWindow!, maxOutputTokens: native.maxTokens! };
  };
  const nativeLimits: NativeModelLimitsByRole = { subject: limitsFor("subject", model), judge: limitsFor("judge", judgeModel) };

  const runId = newRunId();
  const outDir = flagString(args.flags, "out") ? resolve(flagString(args.flags, "out")!) : resolve("runs", runId);

  const interruption = new AbortController();
  const interrupt = (signal: NodeJS.Signals) => interruption.abort(`EVALUATION_INTERRUPTED_${signal}`);
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const { summary, decision } = await runSingleModelEval({
    suite,
    suiteHash: suiteCheck.suiteHash,
    skillPath,
    model,
    judgeModel,
    nativeLimits,
    repeat,
    judgeRepeat,
    outDir,
    runId,
    piHome,
    contextPrefix,
    keywordSignal,
    timeoutMs,
    judgeTimeoutMs,
    gainThresholdPp,
    runtimeIdentity,
    signal: interruption.signal,
    optracall: { sourceRoot: resolve(optracallRoot), nodePath: optracallNode, suiteDir },
  }).finally(() => {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  });

  if (interruption.signal.aborted) return interruption.signal.reason === "EVALUATION_INTERRUPTED_SIGINT" ? 130 : 143;

  process.stdout.write(`${decision.verdict}\n${decision.reason}\n`);
  return summary.status === "success" ? 0 : 1;
}

/**
 * memory 测评：能力开关模式（read_case_sources 有无），复用 runner 与计分引擎。
 */
async function commandCapabilityEval(args: CliArgs): Promise<number> {
  rejectUnbudgetedAdvice(args.flags);
  const suitePath = flagString(args.flags, "suite");
  if (!suitePath) { process.stderr.write("缺少 --suite\n"); return 1; }
  const suite = loadSuite(suitePath);
  const suiteCheck = checkSuite(suite);
  if (!suiteCheck.valid) { process.stderr.write(`套件存在阻断性错误：\n  ${suiteCheck.errors.join("\n  ")}\n`); return 1; }
  const capability = suite.optracall?.capability;
  if (!capability || !CAPABILITIES[capability]) { process.stderr.write("capability-eval 需要套件声明 optracall.capability=memory/sap-method/case-decision 与 capabilityFixtures\n"); return 1; }
  const fixtures = (suite.optracall!.capabilityFixtures ?? suite.optracall!.memoryFixtures)!;
  const optracallRoot = flagString(args.flags, "optracall");
  if (!optracallRoot) { process.stderr.write("能力测评需要 --optracall <OptraCall checkout 路径>\n"); return 1; }
  let optracallNode: string | undefined;
  try { optracallNode = resolveOptraCallNode(flagString(args.flags, "optracall-node")); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); return 1; }

  const { modelList, singleModel, models, judgeOverride, piHome } = modelSelection(args.flags);
  if (modelList.length === 0 && !singleModel) { process.stderr.write("缺少被评模型：用 --model 指定\n"); return 1; }
  if (modelList.length > 1) { process.stderr.write("当前入口只接受单个被评模型\n"); return 1; }
  const model = (modelList[0] ?? singleModel)!;
  const judgeModel = judgeOverride ?? model;
  const repeat = positiveInteger(args.flags, "repeat", suite.repeat ?? DEFAULT_REPEAT);
  const judgeRepeat = positiveInteger(args.flags, "judge-repeat", suite.judgeRepeat ?? DEFAULT_JUDGE_REPEAT);
  const timeoutMs = flagNumber(args.flags, "timeout");
  const judgeTimeoutMs = flagNumber(args.flags, "judge-timeout");
  const keywordSignal = args.flags["no-keyword-signal"] !== true;
  const gainThresholdPp = flagNumber(args.flags, "gain-threshold");
  validateControlledPlan({ model, judgeModel, plannedSessions: suite.tasks.length * repeat * (2 + judgeRepeat) });
  const modelCheck = await preflightModels({ models, judgeModel: judgeOverride, home: piHome });
  if (!modelCheck.valid) { process.stderr.write(`模型预检未通过：\n  ${modelCheck.errors.join("\n  ")}\n`); return 1; }
  if (!modelCheck.runtime?.sdkEntrySha256) throw new Error("PI_SDK_IDENTITY_MISSING");
  const runtimeIdentity: EvaluationRuntimeIdentity = { evaluator: captureEvaluatorIdentity(), piSdk: modelCheck.runtime };
  const limitsFor = (role: "subject" | "judge", reference: string) => {
    const native = modelCheck.models.find(entry => entry.role === role && entry.requested === reference)?.model;
    if (!native || !Number.isSafeInteger(native.contextWindow) || !Number.isSafeInteger(native.maxTokens)) throw new Error(`模型目录缺少原生 token 上限：${reference}`);
    return { contextWindow: native.contextWindow!, maxOutputTokens: native.maxTokens! };
  };
  const nativeLimits: NativeModelLimitsByRole = { subject: limitsFor("subject", model), judge: limitsFor("judge", judgeModel) };

  const runId = newRunId();
  const outDir = flagString(args.flags, "out") ? resolve(flagString(args.flags, "out")!) : resolve("runs", runId);
  const interruption = new AbortController();
  const interrupt = (signal: NodeJS.Signals) => interruption.abort(`EVALUATION_INTERRUPTED_${signal}`);
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  try {
    assertFreshRunRoot(outDir);
    const fixturesSrcDir = join(outDir, ".frozen", "capability-src");
    mkdirSync(fixturesSrcDir, { recursive: true });
    const fixturesPath = join(fixturesSrcDir, "capability-fixtures.json");
    writeFileSync(fixturesPath, JSON.stringify(fixtures, null, 2));
    const frozen = freezeSkill(fixturesPath, join(outDir, ".frozen", "capability"));
    const envs = prepareOptraCallEnvironments({ sourceRoot: resolve(optracallRoot), envRoot: join(outDir, "optracall-env") });
    const configuration = optracallConfiguration(readPiApiKey(piHome, OPTRACALL_SUBJECT_PROFILE.provider));
    const suiteDir = dirname(resolve(suitePath));
    const execution = createOptraCallExecution({
      mode: "real", runRoot: outDir, envs, model, judgeModel, nativeLimits,
      judgePlannedSessions: suite.tasks.length * repeat * judgeRepeat, home: piHome, configuration,
      templateFor: taskId => loadOptraCallTemplate(suiteDir, suite, taskId),
      nodePath: optracallNode, signal: interruption.signal, timeoutMs,
      capabilityToggle: { baselineArgs: [CAPABILITIES[capability].disableFlag], treatmentArgs: [] },
      capabilityId: capability, capabilityFixtures: fixtures,
    });
    const variants: Variant[] = [
      { id: "baseline", label: `Baseline（无${CAPABILITIES[capability].label}能力）`, skillPaths: [] },
      { id: "treatment", label: `Treatment（${CAPABILITIES[capability].label}可用）`, skillPaths: [] },
    ];
    const effectiveSuiteHash = hashSuite({ ...suite, contextPrefix: suite.contextPrefix });
    const templateHashes = Object.fromEntries(suite.tasks.map(task => [task.id, hashTemplate(loadOptraCallTemplate(suiteDir, suite, task.id))]));
    const manifest: RunManifest = {
      schemaVersion: 1, policyVersion: EVALUATION_POLICY_VERSION, runId, model, judgeModel, repeat, judgeRepeat, judgeSeed: runId,
      tasks: suite.tasks, variants, runtimeIdentity,
      settings: { gainThresholdPp: gainThresholdPp ?? GAIN_THRESHOLD_PP, timeoutMs, judgeTimeoutMs, keywordSignal, nodeVersion: process.version, nativeLimits },
      candidate: { identity: frozen.identity, snapshotDir: relativeSnapshotDir(outDir, frozen.skillPath), originalSkillPath: fixturesPath },
      suiteMeta: { suiteId: suite.id, suiteVersion: suite.version ?? "未标注", suiteHash: effectiveSuiteHash, skillVersion: `${capability}-fixtures`, skillPath: fixturesPath },
      optracall: { ...optracallManifestSection(envs, configuration, optracallNode), templateHashes, capability },
    };
    saveRunManifest(outDir, manifest);
    process.stderr.write(`开始 ${capability} 能力测评：${suite.id}\n  模型：${model}（评委：${judgeModel}）\n  用例 ${suite.tasks.length} × 变体 2 × 重复 ${repeat}\n  输出：${outDir}\n\n`);
    const summary = await runEvaluation({
      runRoot: outDir, runId, manifest, judgeSeed: runId, model, judgeModel, nativeLimits, signal: interruption.signal,
      variants, tasks: suite.tasks, repeat, judgeRepeat, home: piHome, keywordSignal, timeoutMs, judgeTimeoutMs,
      execution, skillPathForContamination: "", skillDirForContamination: "",
      onProgress: event => process.stderr.write(`  [${event.phase}] ${event.message}\n`),
    });
    summary.suiteMeta = manifest.suiteMeta;
    writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
    const decision = decideVerdict(summary, { ...(gainThresholdPp !== undefined ? { gainThresholdPp } : {}) });
    const skillContext = buildSkillDocContext(frozen.skillPath, summary);
    const report = renderReport({
      summary, meta: { skillPath: fixturesPath, skillHash: frozen.identity.hash, skillVersion: `${capability}-fixtures`, suiteId: suite.id, suiteVersion: suite.version ?? "未标注", suiteHash: effectiveSuiteHash, runRoot: outDir, piHome: piHome ?? null, generatedAt: new Date().toISOString() },
      tasks: suite.tasks, variants, verdict: decision.verdict, expensive: decision.expensive, verdictReason: decision.reason, skillContext, calibration: loadCalibrationIfPresent(outDir),
    });
    writeFileSync(join(outDir, "REPORT.md"), report);
    process.stderr.write(`\n报告已生成：${join(outDir, "REPORT.md")}\n`);
    if (interruption.signal.aborted) return interruption.signal.reason === "EVALUATION_INTERRUPTED_SIGINT" ? 130 : 143;
    process.stdout.write(`${decision.verdict}\n${decision.reason}\n`);
    return summary.status === "success" ? 0 : 1;
  } finally {
    process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
  }
}

/**
 * 从已有运行产物重新生成报告。
 */
async function commandReport(args: CliArgs): Promise<number> {
  rejectUnbudgetedAdvice(args.flags);
  const runDir = flagString(args.flags, "run");
  if (!runDir) {
    process.stderr.write("缺少 --run\n");
    return 1;
  }

  const absolute = resolve(runDir);
  const summaryPath = join(absolute, "summary.json");
  if (!existsSync(summaryPath)) {
    process.stderr.write(`未找到运行摘要：${summaryPath}\n`);
    return 1;
  }

  const stored = JSON.parse(readFileSync(summaryPath, "utf8")) as EvaluationSummary;

  const suitePath = flagString(args.flags, "suite-file");
  let tasks: EvalTask[];
  let variants: Variant[];
  let loadedSuite: SuiteFile | undefined;
  let computedSuiteHash: string | undefined;

  if (suitePath) {
    const suite = loadSuite(suitePath);
    loadedSuite = suite;
    computedSuiteHash = hashSuite(suite);
    const suiteDir = dirname(resolve(suitePath));
    const skillPath = suite.skill?.path
      ? isAbsolute(suite.skill.path)
        ? suite.skill.path
        : resolve(suiteDir, suite.skill.path)
      : undefined;
    tasks = suite.tasks;
    variants = [
      { id: "baseline", label: "Baseline（不装 skill）", skillPaths: [] },
      { id: "skill", label: `Skill（${suite.skill?.version ?? "当前版本"}）`, skillPaths: skillPath ? [skillPath] : [] },
    ];
  } else {
    tasks = (stored.taskSummaries ?? []).map(
      (task): EvalTask => ({
        id: task.taskId,
        prompt: "",
        kind: task.kind,
        ...(task.shouldActivate !== undefined ? { shouldActivate: task.shouldActivate } : {}),
      }),
    );
    const manifest = loadRunManifest(absolute);
    tasks = stored.tasks ?? manifest?.tasks ?? tasks;
    variants = manifest?.variants ?? rebuildVariantsForRecompute(stored, stored.suiteMeta?.skillPath ?? "(legacy-unverified)");
  }

  const summary = await recomputeSummary(absolute, { variants, tasks });
  summary.evidenceLevel = "replay";
  summary.analysisOf = { runId: stored.runId, originalSuiteHash: stored.suiteMeta?.suiteHash, suiteHash: computedSuiteHash ?? stored.suiteMeta?.suiteHash, createdAt: new Date().toISOString() };
  if (loadedSuite && computedSuiteHash && summary.suiteMeta) summary.suiteMeta = {
    ...summary.suiteMeta, suiteId: loadedSuite.id, suiteVersion: loadedSuite.version ?? "未标注", suiteHash: computedSuiteHash,
  };
  if (computedSuiteHash && stored.suiteMeta?.suiteHash && computedSuiteHash !== stored.suiteMeta.suiteHash) {
    summary.integrity = { verified: false, issues: [...(summary.integrity?.issues ?? []), "派生复核使用了不同套件判据，旧评委记录不能作为新判据的确认性证据"] };
  }

  const existingReportPath = join(absolute, "REPORT.md");
  const existingReportText = existsSync(existingReportPath)
    ? readFileSync(existingReportPath, "utf8")
    : null;
  const recovered = existingReportText
    ? recoverMetaFromReport(existingReportText)
    : recoverMetaFromReport("");

  const merged = mergeMeta(
    {
      skillPath: flagString(args.flags, "skill") ?? stored.suiteMeta?.skillPath,
      skillHash: flagString(args.flags, "skill-hash"),
      skillVersion: flagString(args.flags, "skill-version") ?? stored.suiteMeta?.skillVersion,
      suiteId: loadedSuite?.id ?? flagString(args.flags, "suite") ?? stored.suiteMeta?.suiteId,
      suiteVersion:
        flagString(args.flags, "suite-version") ??
        loadedSuite?.version ??
        stored.suiteMeta?.suiteVersion,
      suiteHash: computedSuiteHash ?? stored.suiteMeta?.suiteHash ?? null,
      piHome: flagString(args.flags, "home"),
    },
    recovered,
  );

  const resolvedSkillPath =
    merged.skillPath && merged.skillPath !== "（未记录）"
      ? resolve(expandTilde(merged.skillPath))
      : undefined;

  const meta: ReportMeta = {
    skillPath: merged.skillPath ?? "（未记录）",
    skillHash: summary.manifest?.candidate.identity.hash ?? merged.skillHash ?? "（未记录）",
    skillVersion: merged.skillVersion ?? "（未记录）",
    suiteId: merged.suiteId ?? "（未记录）",
    suiteVersion: merged.suiteVersion ?? "（未记录）",
    suiteHash: merged.suiteHash ?? null,
    runRoot: absolute,
    piHome: merged.piHome ?? null,
    generatedAt: new Date().toISOString(),
  };

  const decision = decideVerdict(summary, {
    ...(flagNumber(args.flags, "gain-threshold") !== undefined
      ? { gainThresholdPp: flagNumber(args.flags, "gain-threshold")! }
      : summary.manifest?.settings ? { gainThresholdPp: summary.manifest.settings.gainThresholdPp } : {}),
  });
  const skillContext = buildSkillDocContext(summary.manifest ? frozenSkillPath(absolute, summary.manifest) : resolvedSkillPath, summary);

  const report = renderReport({
    summary,
    meta,
    tasks,
    variants,
    verdict: decision.verdict,
    expensive: decision.expensive,
    verdictReason: decision.reason,
    skillContext,
    calibration: loadCalibrationIfPresent(absolute),
  });

  const analysisRoot = join(absolute, "analyses", newRunId());
  mkdirSync(analysisRoot, { recursive: true });
  writeFileSync(join(analysisRoot, "REPORT.md"), report, { encoding: "utf8", flag: "wx" });
  writeFileSync(join(analysisRoot, "summary.json"), JSON.stringify(summary, null, 2), { encoding: "utf8", flag: "wx" });
  writeFileSync(join(analysisRoot, "analysis.json"), JSON.stringify({ ...summary.analysisOf, policyVersion: EVALUATION_POLICY_VERSION, sourceRun: absolute }, null, 2), { encoding: "utf8", flag: "wx" });
  process.stdout.write(`派生复核已生成（原记录未覆盖）：${join(analysisRoot, "REPORT.md")}\n`);
  process.stdout.write(`${decision.verdict}${decision.expensive ? " (expensive)" : ""}\n${decision.reason}\n`);
  return 0;
}

/**
 * 为 recomputeSummary 重建 variants。
 *
 * 关键不变量：**非 baseline 变体必须带非空 skillPaths**——runner 的
 * `isBaseline = skillPaths.length === 0 || id === "baseline"`，若把 skill 侧
 * 也填成 `[]`，重算会把它当 baseline，pairCoverage / winRateLowerBound 被置
 * null，decideVerdict 误拦为 inconclusive（2026-11-06 归档 run2 时实测踩中）。
 */
export function rebuildVariantsForRecompute(
  stored: EvaluationSummary,
  skillPath: string,
): Variant[] {
  return (stored.variantSummaries ?? []).map((item): Variant => ({
    id: item.variantId,
    label: item.variantLabel,
    skillPaths: item.variantId === "baseline" ? [] : [skillPath],
  }));
}

/** 阴性对照元评估子命令（`skill-eval verify`）。 */
async function commandVerify(args: CliArgs): Promise<number> {
  const genBrokenSource = flagString(args.flags, "generate-broken");
  if (genBrokenSource) {
    const srcPath = resolve(expandTilde(genBrokenSource));
    if (!existsSync(srcPath)) {
      process.stderr.write(`找不到源 SKILL.md：${srcPath}\n`);
      return 1;
    }
    const outDirFlag = flagString(args.flags, "out");
    if (!outDirFlag) {
      process.stderr.write("使用 --generate-broken 时须通过 --out 指定破坏版输出目录\n");
      return 1;
    }
    const outDir = resolve(expandTilde(outDirFlag));
    mkdirSync(outDir, { recursive: true });
    const raw = readFileSync(srcPath, "utf8");
    const stripped = stripBehavioralContract(raw);
    const destFile = join(outDir, "SKILL.md");
    writeFileSync(destFile, stripped.content, "utf8");
    process.stdout.write(
      `已生成行为契约剥离版 SKILL.md：${destFile}\n` +
        `  原版行数：${stripped.originalLines} → 剥离后行数：${stripped.strippedLines}\n` +
        `  保留 YAML frontmatter 触发契约：${stripped.preservedFrontmatter ? "是" : "否"}\n`,
    );
    return 0;
  }

  const origDir = flagString(args.flags, "original");
  const brokenDir = flagString(args.flags, "broken");
  if (!origDir || !brokenDir) {
    process.stderr.write(
      "用法：\n" +
        "  skill-eval verify --original <原版运行目录> --broken <破坏版运行目录>\n" +
        "  skill-eval verify --generate-broken <SKILL.md> --out <破坏版目录>\n",
    );
    return 1;
  }

  const origSummaryPath = join(resolve(origDir), "summary.json");
  const brokenSummaryPath = join(resolve(brokenDir), "summary.json");
  if (!existsSync(origSummaryPath)) {
    process.stderr.write(`找不到原版运行摘要：${origSummaryPath}\n`);
    return 1;
  }
  if (!existsSync(brokenSummaryPath)) {
    process.stderr.write(`找不到破坏版运行摘要：${brokenSummaryPath}\n`);
    return 1;
  }

  const revalidate = async (runDir: string, path: string): Promise<EvaluationSummary> => {
    const stored = JSON.parse(readFileSync(path, "utf8")) as EvaluationSummary;
    try {
      const manifest = loadRunManifest(runDir);
      if (!manifest) return { ...stored, integrity: { verified: false, issues: ["缺少冻结清单与当前原始产物核验，不能信任历史摘要中的已验证旗标"] } };
      return await recomputeSummary(runDir, { variants: manifest.variants, tasks: manifest.tasks, repeat: manifest.repeat });
    } catch {
      return { ...stored, integrity: { verified: false, issues: ["冻结清单或原始产物无法核验"] } };
    }
  };
  const origSummary = await revalidate(resolve(origDir), origSummaryPath);
  const brokenSummary = await revalidate(resolve(brokenDir), brokenSummaryPath);
  const thresholdPp = flagNumber(args.flags, "gain-threshold");
  const report = evaluateNegativeControl(origSummary, brokenSummary, {
    ...(thresholdPp !== undefined ? { thresholdPp } : {}),
  });

  if (args.flags["json"] === true) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatNegativeControlReport(report));
  }

  return report.passed ? 0 : 1;
}

/** 人工盲审抽检与评委校准子命令（`skill-eval calibrate`）。 */
function commandCalibrate(args: CliArgs): number {
  const runDirFlag = flagString(args.flags, "run");
  if (!runDirFlag) {
    process.stderr.write("缺少 --run <运行目录>\n");
    return 1;
  }
  const runDir = resolve(runDirFlag);
  const summaryPath = join(runDir, "summary.json");
  if (!existsSync(summaryPath)) {
    process.stderr.write(`找不到运行摘要：${summaryPath}\n`);
    return 1;
  }

  const exportPathFlag = flagString(args.flags, "export");
  const scorePathFlag = flagString(args.flags, "score");

  if (exportPathFlag) {
    const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as EvaluationSummary;
    const manifest = loadRunManifest(runDir) ?? summary.manifest;
    if (manifest && manifest.runId !== summary.runId) throw new Error("冻结运行清单与摘要的运行身份不匹配");
    const suiteFileFlag = flagString(args.flags, "suite-file");
    const tasks = manifest?.tasks ?? summary.tasks ?? (suiteFileFlag ? loadSuite(suiteFileFlag).tasks : undefined);
    const limit = flagNumber(args.flags, "limit");

    const { blindSheet, answerKey } = exportCalibrationSheet(summary, tasks, limit, runDir);
    const unavailableCount = answerKey.unavailableCount ?? 0;
    const exportPath = resolve(exportPathFlag);
    const keyPath = join(runDir, "calibration-key.json");
    mkdirSync(dirname(exportPath), { recursive: true });
    writeFileSync(exportPath, JSON.stringify(blindSheet, null, 2), "utf8");
    writeFileSync(keyPath, JSON.stringify(answerKey, null, 2), "utf8");

    process.stdout.write(
      `已导出匿名盲审表（可盲审 ${blindSheet.items.length} 对，无法校准 ${unavailableCount} 对）：${exportPath}\n` +
        `映射密钥已保存至：${keyPath}\n` +
        "填写每条的 humanVerdict ('A' | 'B' | 'tie') 后执行：\n" +
        `  skill-eval calibrate --run ${runDir} --score ${exportPath}\n`,
    );
    return 0;
  }

  if (scorePathFlag) {
    const keyPath = join(runDir, "calibration-key.json");
    if (!existsSync(keyPath)) {
      process.stderr.write(`未找到映射密钥：${keyPath}（请先执行 --export）\n`);
      return 1;
    }
    const sheetPath = resolve(scorePathFlag);
    if (!existsSync(sheetPath)) {
      process.stderr.write(`未找到已填写的盲审表：${sheetPath}\n`);
      return 1;
    }

    const blindSheet = JSON.parse(readFileSync(sheetPath, "utf8")) as BlindReviewSheet;
    const answerKey = JSON.parse(readFileSync(keyPath, "utf8")) as CalibrationAnswerKey;
    const result = evaluateCalibration(blindSheet, answerKey);
    const outPath = join(runDir, "calibration-result.json");
    writeFileSync(outPath, JSON.stringify(result, null, 2), "utf8");

    process.stdout.write(`人工盲审校准完成（已审核 ${result.reviewedCount}/${result.totalItems} 对，无法校准 ${result.unavailableCount ?? 0} 对）：\n`);
    process.stdout.write(
      `  人机一致率：${result.agreementRate === null ? "—" : `${(result.agreementRate * 100).toFixed(1)}%`}\n`,
    );
    process.stdout.write(
      `  Cohen's κ：${result.kappa === null ? "—" : result.kappa.toFixed(3)}\n`,
    );
    process.stdout.write(
      `  评委乐观偏置：${result.optimismBiasPp === null ? "—" : `${result.optimismBiasPp >= 0 ? "+" : ""}${result.optimismBiasPp.toFixed(1)}pp`}\n`,
    );
    process.stdout.write(`  结果已落盘：${outPath}（运行 skill-eval report 可自动写入报告）\n`);
    return 0;
  }

  process.stderr.write("请指定 --export <盲审表.json> 或 --score <已填盲审表.json>\n");
  return 1;
}

/** 查看全局判定门槛与回归门禁阈值。 */
function commandThreshold(args: CliArgs): number {
  const scoreDrop = flagNumber(args.flags, "score-drop");
  const activationRateDrop = flagNumber(args.flags, "activation-rate-drop");

  if (scoreDrop === undefined && activationRateDrop === undefined) {
    process.stdout.write(
      `全局有效判定门槛（src/core/thresholds.ts）：\n` +
        `  默认重复运行次数（repeat）：${DEFAULT_REPEAT}\n` +
        `  默认评委轮数（judgeRepeat）：${DEFAULT_JUDGE_REPEAT}\n` +
        `  正向激活率门槛：${(ACTIVATION_THRESHOLD * 100).toFixed(0)}%\n` +
        `  负向最大误触发率：${(MAX_FALSE_ACTIVATION_RATE * 100).toFixed(0)}%\n` +
        `  成对评委胜率门槛（含超时惩罚与规则纠偏后）：${(WIN_RATE_THRESHOLD * 100).toFixed(0)}%（断言增益过硬 ≥ +${GAIN_STRONG_THRESHOLD_PP}pp 且 CI 下界 > 0 时降为 ${(WIN_RATE_RELAXED_THRESHOLD * 100).toFixed(0)}% 守门线）\n` +
        `  全样本胜率下界门槛：${(MIN_WIN_RATE_LOWER_BOUND * 100).toFixed(0)}%（胜出的计分对 / 计划计分对）\n` +
        `  有效评判覆盖率门槛：${(MIN_PAIR_COVERAGE * 100).toFixed(0)}%（且有效计分对 ≥ ${MIN_JUDGED_PAIRS}）\n` +
        `  skill 侧最大超时率：${(MAX_VARIANT_TIMEOUT_RATE * 100).toFixed(0)}%\n` +
        `  单次会话默认不设超时（--timeout 指定被评时限，--judge-timeout 指定评委时限）\n` +
        `  完整的任务等权配对断言增益须 ≥ +${GAIN_THRESHOLD_PP}pp（保守 95% Hoeffding 下界 > 0）\n` +
        `  无计分断言时，任务级纯评委胜率的保守 95% Hoeffding 下界须 > 50%\n` +
        `  Hoeffding 区间以独立计分任务为统计单位。原始评委胜率的 95% Wilson 区间用于描述。\n` +
        `  成本昂贵警告线：token > ${COST_WARN_TOKEN_RATIO}x 或 > ${COST_WARN_TOKENS_PER_PP} tokens/pp\n\n` +
        `默认回归门禁阈值：\n` +
        `  胜率最大下降：${DEFAULT_THRESHOLDS.scoreDrop}\n` +
        `  激活率最大下降：${DEFAULT_THRESHOLDS.activationRateDrop}\n` +
        `  接受门：严格接受（候选必须严格优于当前版本，且套件哈希未漂移）\n`,
    );
    return 0;
  }

  const thresholds: RegressionThresholds = parseThresholds({
    scoreDrop: scoreDrop ?? DEFAULT_THRESHOLDS.scoreDrop,
    activationRateDrop: activationRateDrop ?? DEFAULT_THRESHOLDS.activationRateDrop,
  });

  process.stdout.write(
    `自定义回归门禁阈值：\n` +
      `  胜率最大下降：${thresholds.scoreDrop}\n` +
      `  激活率最大下降：${thresholds.activationRateDrop}\n`,
  );
  return 0;
}

// 仅在直接作为 CLI 脚本执行时触发 main()，方便单测直接 import parseArgs 等辅助函数。
const isMainModule =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(
        `执行失败：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
