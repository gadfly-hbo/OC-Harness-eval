#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, digest, readCaptures, snapshotCaptures, writeJson } from './archive.ts';
import { evaluate, fingerprint, sides, taskInput, validatePlan } from './evaluate.ts';
import type { Evaluation, Plan } from './evaluate.ts';
import { demoCaptures, demoPlan } from './demo.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourceFiles = ['package.json', 'src/archive.ts', 'src/cli.ts', 'src/conversion.ts',
  'src/demo.ts', 'src/evaluate.ts', 'src/sap.ts'];

function readRegular(path: string): Buffer {
  if (!lstatSync(path).isFile()) throw new Error(`Expected a regular file: ${path}`);
  return readFileSync(path);
}

function writeOnce(path: string, bytes: string | Buffer) {
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
}

function parseJson(bytes: Buffer, label: string) {
  try {
    return JSON.parse(bytes.toString('utf8'), (_key, value: unknown) => {
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Non-finite number');
      return value;
    });
  } catch {
    throw new Error(`Invalid JSON in ${label}`);
  }
}

function sourceIdentity() {
  return Object.fromEntries(sourceFiles.map(path => [path, digest(readRegular(join(root, path)))]));
}

function commitIdentity(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function matrix(plan: Plan) {
  return plan.cases.flatMap(item => sides.map(side => ({
    caseId: item.id, side, taskHash: fingerprint(taskInput(item)),
  })));
}

function freeze(planFile: string, destination: string) {
  const bytes = readRegular(planFile);
  const plan: unknown = parseJson(bytes, 'plan');
  validatePlan(plan);
  const sources = sourceIdentity();
  mkdirSync(destination, { mode: 0o700 });
  writeOnce(join(destination, 'plan.json'), bytes);
  writeJson(join(destination, 'freeze.json'), {
    schemaVersion: 1,
    frozenAt: new Date().toISOString(),
    planSha256: digest(bytes),
    evaluatorSha256: fingerprint(sources),
    sources,
    commit: commitIdentity(),
    node: process.version,
    settingsHash: fingerprint(plan.settings),
    matrix: matrix(plan),
  });
}

function readFrozen(directory: string) {
  const bytes = readRegular(join(directory, 'plan.json'));
  const plan: unknown = parseJson(bytes, 'frozen plan');
  validatePlan(plan);
  const lockBytes = readRegular(join(directory, 'freeze.json'));
  const lock = parseJson(lockBytes, 'freeze manifest');
  const sources = sourceIdentity();
  if (lock?.schemaVersion !== 1 || lock.planSha256 !== digest(bytes) ||
      lock.evaluatorSha256 !== fingerprint(sources) || canonical(lock.sources) !== canonical(sources) ||
      lock.node !== process.version || lock.settingsHash !== fingerprint(plan.settings) ||
      canonical(lock.matrix) !== canonical(matrix(plan))) {
    throw new Error('Frozen plan, evaluator source or Node identity mismatch');
  }
  return { plan, bytes, lock, lockBytes };
}

type Run = {
  schemaVersion: 1;
  runId: string;
  startedAt: string;
  parentRunId: string | null;
  reason: string | null;
  freezeSha256: string;
  matrix: ReturnType<typeof matrix>;
};

function buildReceipt(plan: Plan, lock: ReturnType<typeof readFrozen>['lock'], run: Run,
  inventory: Record<string, string>, captures: Map<string, Buffer>) {
  return {
    schemaVersion: 1,
    run,
    suite: plan.suite,
    planSha256: lock.planSha256,
    evaluatorSha256: lock.evaluatorSha256,
    evaluatorNode: lock.node,
    settings: plan.settings,
    settingsHash: lock.settingsHash,
    candidate: {
      source: plan.candidate.source,
      isolated: plan.candidate.isolated,
      versionBodySha256: digest(plan.candidate.versionBody),
    },
    rawSha256: inventory,
    verificationScope: {
      providerExecution: 'NOT_RUN',
      realIsolationProbes: 'NOT_RUN',
      formalHoldout: 'NOT_RUN',
      liveSapIntegration: 'NOT_RUN',
    },
    evaluation: evaluate(plan, captures),
  };
}

function formatReport(receipt: ReturnType<typeof buildReceipt>) {
  const { evaluation, run, candidate, suite } = receipt;
  const { gain, method } = evaluation;
  const lines = [
    '# IR 方法版本回执', '',
    `运行 \`${run.runId}\` · 套件 \`${suite.id}@${suite.version}\` · \`${evaluation.evidenceLevel}\``,
    '',
    `源 SAP \`${candidate.source.methodId}@${candidate.source.version}\` · 发布哈希 \`${candidate.source.publishedHash}\`。`,
    `隔离 SAP \`${candidate.isolated.methodId}@${candidate.isolated.version}\` · 冻结计划 \`${receipt.planSha256}\`。`,
    '',
    `- 方法正确性 **${method.correctness}**，源任务 ${method.sourceCases} 个，迁移任务 ${method.migrationCases} 个。`,
    `- 方法适用性 **${method.applicability}**，不可比边界 ${method.boundaryCases} 个。`,
    `- 配对状态 **${gain.status}**，${gain.comparablePairs}/${gain.plannedPairs} 对可判，${gain.comparableFamilies}/${gain.plannedFamilies} 个任务族可计分。可计分任务族的等权通过率差 **${gain.observedDelta === null ? 'UNKNOWN' : `${(100 * gain.observedDelta).toFixed(2)} pp`}**。`,
    evaluation.evidenceLevel === 'SYNTHETIC_REPLAY'
      ? '- 上述结论只描述合成夹具中的测评器行为。'
      : '- 档案复算依据冻结输入、原生轨迹和导入的独立评阅。真实配对增益为 UNKNOWN。',
    '- Provider 执行、在线 SAP、实际隔离探针及正式留出测评均为 NOT_RUN。', '',
    '| 案例 | 方法任务/边界 | 基线任务/业务 | 处理任务/业务 | SAP 查/读 | 正确采用 | 配对 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const item of evaluation.cases) {
    const sap = item.treatment.sap;
    lines.push(`| ${item.id} | ${item.method.task}/${item.method.applicability} | ${item.baseline.task}/${item.baseline.businessAnswer} | ${item.treatment.task}/${item.treatment.businessAnswer} | ${sap?.find.status ?? 'UNKNOWN'}/${sap?.read.status ?? 'UNKNOWN'} | ${item.treatment.reuse.status}${item.treatment.reuse.stage ? ` (${item.treatment.reuse.stage})` : ''} | ${item.gain} |`);
  }
  lines.push('', '## 计划对账', '',
    '| 侧 | COMPLETED | TIMEOUT | FAILED | CANCELLED | NOT_RUN | INVALID_CAPTURE |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const side of sides) {
    const counts = evaluation.terminations[side];
    lines.push(`| ${side} | ${counts.COMPLETED} | ${counts.TIMEOUT} | ${counts.FAILED} | ${counts.CANCELLED} | ${counts.NOT_RUN} | ${counts.INVALID_CAPTURE} |`);
  }
  lines.push('', '## 断言与证据', '');
  for (const item of evaluation.cases) {
    for (const side of sides) {
      const result = item[side];
      const ref = result.evidence ? `[原始档案](${result.evidence})` : '无原始档案';
      const incomplete = result.assertions.filter(entry => entry.status !== 'PASS')
        .map(entry => `${entry.id}=${entry.status}`);
      const details = [...incomplete, ...result.issues].join(', ');
      lines.push(`- ${item.id} · ${side} · ${result.termination} · ${ref}${details ? ` · ${details}` : ''}`);
    }
    if (item.pairIssues.length) lines.push(`- ${item.id} · 配对排除 · ${item.pairIssues.join(', ')}`);
  }
  lines.push('', `计划外文件 ${evaluation.unplannedFiles.length} 个。逐项原因、原件 SHA-256、查读事件索引、完成取证状态、Skill 诊断与用量见 [receipt.json](receipt.json)。用量缺失时记录为 null。`, '');
  return lines.join('\n');
}

function isWithin(path: string, directory: string): boolean {
  const rel = relative(directory, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

function replay(frozen: string, captureSource: string, outputRoot: string,
  parentRunId: string | null = null, reason: string | null = null) {
  const { plan, bytes, lock, lockBytes } = readFrozen(frozen);
  const source = realpathSync(captureSource);
  const output = resolve(outputRoot);
  // Refuse even nonexistent output paths nested under the input via an existing symlink.
  let existing = output;
  for (;;) {
    try { existing = realpathSync(existing); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = resolve(existing, '..');
      if (parent === existing) throw error;
      existing = parent;
    }
  }
  if (isWithin(output, source) || isWithin(existing, source)) {
    throw new Error('Output root cannot be inside the capture source');
  }
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const run: Run = {
    schemaVersion: 1, runId: randomUUID(), startedAt: new Date().toISOString(),
    parentRunId, reason, freezeSha256: digest(lockBytes), matrix: matrix(plan),
  };
  const directory = join(output, run.runId);
  mkdirSync(directory, { mode: 0o700 });
  writeJson(join(directory, 'run.json'), run);
  try {
    writeOnce(join(directory, 'plan.json'), bytes);
    writeOnce(join(directory, 'freeze.json'), lockBytes);
    const raw = join(directory, 'raw');
    const inventory = snapshotCaptures(captureSource, raw);
    writeJson(join(directory, 'inventory.json'), inventory);
    const receipt = buildReceipt(plan, lock, run, inventory, readCaptures(raw, inventory));
    writeJson(join(directory, 'receipt.json'), receipt);
    writeOnce(join(directory, 'report.md'), formatReport(receipt));
    writeJson(join(directory, 'completed.json'), {
      receiptSha256: digest(readRegular(join(directory, 'receipt.json'))),
      reportSha256: digest(readRegular(join(directory, 'report.md'))),
    });
  } catch (error) {
    try {
      writeJson(join(directory, 'interrupted.json'), {
        status: 'NOT_EVALUATED', reason: error instanceof Error ? error.message : String(error),
      });
    } catch {
      // The original persistence error and run path are still reported.
    }
    throw new Error(`Replay stopped. Preserved run: ${directory}`, { cause: error });
  }
  return directory;
}

function verify(directory: string) {
  const { plan, lock, lockBytes } = readFrozen(directory);
  const run: Run = parseJson(readRegular(join(directory, 'run.json')), 'run manifest');
  if (run?.schemaVersion !== 1 || run.freezeSha256 !== digest(lockBytes) ||
      canonical(run.matrix) !== canonical(matrix(plan))) throw new Error('Run manifest mismatch');
  const inventory = parseJson(readRegular(join(directory, 'inventory.json')), 'archive inventory');
  const captures = readCaptures(join(directory, 'raw'), inventory);
  const receipt = buildReceipt(plan, lock, run, inventory, captures);
  const actualReceipt = readRegular(join(directory, 'receipt.json'));
  const actualReport = readRegular(join(directory, 'report.md'));
  const completed = parseJson(readRegular(join(directory, 'completed.json')), 'completion marker');
  if (completed?.receiptSha256 !== digest(actualReceipt) ||
      completed?.reportSha256 !== digest(actualReport) ||
      canonical(parseJson(actualReceipt, 'receipt')) !== canonical(receipt) ||
      actualReport.toString('utf8') !== formatReport(receipt)) {
    throw new Error('Receipt or report differs from archived evidence');
  }
  return run.runId;
}

function demo(output: string) {
  const input = join(output, 'demo-inputs', randomUUID());
  mkdirSync(input, { recursive: true, mode: 0o700 });
  const planFile = join(input, 'plan.json');
  const frozen = join(input, 'frozen');
  const source = join(input, 'captures');
  writeJson(planFile, demoPlan);
  freeze(planFile, frozen);
  mkdirSync(source, { mode: 0o700 });
  for (const [name, bytes] of demoCaptures(demoPlan)) writeOnce(join(source, name), bytes);
  return replay(frozen, source, output);
}

const help = `ir-eval · offline SAP method evaluator

  demo [output-root]
  freeze <plan.json> <new-freeze-directory>
  replay <freeze-directory> <capture-directory> <output-root> [--parent <run-id> --reason <text>]
  verify <run-directory>
`;

function main([command, ...args]: string[]) {
  if (!command || command === '--help' || command === 'help') {
    process.stdout.write(help);
  } else if (command === 'demo' && args.length <= 1) {
    console.log(demo(resolve(args[0] ?? '.local/ir-eval')));
  } else if (command === 'freeze' && args.length === 2) {
    freeze(args[0], args[1]);
    console.log(resolve(args[1]));
  } else if (command === 'replay' && (args.length === 3 ||
      (args.length === 7 && args[3] === '--parent' && /^[a-f0-9-]{36}$/.test(args[4]) &&
        args[5] === '--reason' && args[6].trim()))) {
    console.log(replay(args[0], args[1], args[2], args[4] ?? null, args[6] ?? null));
  } else if (command === 'verify' && args.length === 1) {
    console.log(JSON.stringify({ status: 'VERIFIED', runId: verify(args[0]) }));
  } else {
    throw new Error(help);
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? `\n${error.cause.message}` : '';
    process.stderr.write(`${error.message}${cause}\n`);
  } else {
    process.stderr.write('Unexpected CLI failure\n');
  }
  process.exitCode = 1;
}
