import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, readCaptures, writeJson } from './archive.ts';
import { sides } from './evaluate.ts';
import type { Evaluation } from './evaluate.ts';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const evaluator = join(projectRoot, 'src/cli.ts');
const defaultPending = join(projectRoot, 'pending');
const defaultOutput = join(projectRoot, '.local/ir-eval');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const controlChars = /[\x00-\x1f\x7f]/;

const options = {
  pending: ['--pending', '--json'],
  prepare: ['--pending'],
  eval: ['--pending', '--out', '--parent', '--reason'],
  archive: ['--pending'],
  demo: ['--out'],
  verify: [],
} as const;

type Command = keyof typeof options;
type RunMode = 'eval' | 'demo' | 'verify' | 'archive';

const usage = [
  'pending [--json] [--pending <directory>]',
  'prepare [bundle] [--pending <directory>]',
  'eval [bundle] [--pending <directory>] [--out <directory>] [--parent <run-id> --reason <text>]',
  'archive <run-directory> [bundle] [--pending <directory>]',
  'demo [--out <directory>]',
  'verify <run-directory>',
];

class FlowError extends Error {
  code: string;
  details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function parse(command: Command, tokens: string[]) {
  const allowed: readonly string[] = options[command];
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  let readOptions = true;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (readOptions && token === '--') {
      readOptions = false;
    } else if (readOptions && token.startsWith('--')) {
      if (!allowed.includes(token) || flags.has(token)) {
        throw new FlowError('INVALID_ARGUMENT', `Unexpected or repeated option: ${token}`);
      }
      const value = token === '--json' ? 'true' : tokens[++index];
      if (!value?.trim() || (token !== '--json' && value.startsWith('--'))) {
        throw new FlowError('INVALID_ARGUMENT', `Missing value: ${token}`);
      }
      flags.set(token, value);
    } else {
      positionals.push(token);
    }
  }
  const max = command === 'archive' ? 2 : ['prepare', 'eval', 'verify'].includes(command) ? 1 : 0;
  const min = command === 'verify' || command === 'archive' ? 1 : 0;
  if (positionals.length > max || positionals.length < min) {
    throw new FlowError('INVALID_ARGUMENT', `Usage: ${usage[Object.keys(options).indexOf(command)]}`);
  }
  return { flags, positionals };
}

function absolute(value: string) {
  if (!value.trim() || controlChars.test(value)) throw new FlowError('INVALID_PATH', 'Empty or invalid path');
  return resolve(value);
}

function pathType(path: string) {
  try {
    const entry = lstatSync(path);
    return entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

function requireDirectory(path: string) {
  if (pathType(path) !== 'directory') {
    throw new FlowError('INVALID_DIRECTORY', `Expected a regular directory: ${path}`);
  }
}

function inspectBundle(path: string) {
  const issues: string[] = [];
  const name = basename(path);
  if (controlChars.test(path) || pathType(path) !== 'directory') {
    return { name, path, state: 'INVALID', issues: ['Bundle path must be a regular directory'] };
  }

  const frozen = join(path, 'frozen');
  const captures = join(path, 'captures');
  const freezeType = pathType(frozen);
  const capturesType = pathType(captures);
  if (freezeType === 'missing') {
    if (pathType(join(path, 'plan.json')) !== 'file') issues.push('Expected plan.json as a regular file');
  } else if (freezeType !== 'directory') {
    issues.push('Expected frozen/ as a regular directory');
  } else {
    for (const file of ['plan.json', 'freeze.json']) {
      if (pathType(join(frozen, file)) !== 'file') issues.push(`Expected frozen/${file} as a regular file`);
    }
  }
  if (capturesType !== 'missing' && capturesType !== 'directory') {
    issues.push('Expected captures/ as a regular directory');
  }

  let state: string;
  if (issues.length) state = 'INVALID';
  else if (freezeType === 'missing') {
    state = capturesType === 'directory' && readdirSync(captures, { withFileTypes: true }).some(entry =>
      !entry.isFile() || !['.DS_Store', '.gitkeep'].includes(entry.name))
      ? 'UNFROZEN_CAPTURES' : 'NEEDS_FREEZE';
  } else state = capturesType === 'directory' ? 'READY' : 'NEEDS_CAPTURES';
  return { name, path, state, issues };
}

function listBundles(directory: string) {
  requireDirectory(directory);
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => !entry.name.startsWith('.') && (entry.isDirectory() || entry.isSymbolicLink()))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'))
    .map(entry => inspectBundle(join(directory, entry.name)));
}

function selectBundle(explicit: string | undefined, pending: string) {
  if (explicit !== undefined) return inspectBundle(absolute(explicit));
  const bundles = listBundles(pending);
  if (bundles.length === 0) {
    throw new FlowError('NO_BUNDLE', `No candidate bundles in ${pending}`, { pendingDirectory: pending });
  }
  if (bundles.length > 1) {
    throw new FlowError('AMBIGUOUS_BUNDLE', 'Select a candidate bundle explicitly', {
      pendingDirectory: pending, bundles: bundles.map(bundle => bundle.path),
    });
  }
  return bundles[0];
}

function runEvaluator(args: string[], runDirectory?: string) {
  // The evaluator commands used here only process local files. No Provider session is started.
  const result = spawnSync(process.execPath, [evaluator, ...args], {
    cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const message = result.stderr?.trimEnd() || result.error?.message || 'ir-eval did not complete';
    const preserved = message.match(/^Replay stopped\. Preserved run: ([^\r\n]+)$/m)?.[1];
    const directory = runDirectory ?? preserved;
    throw new FlowError('IR_EVAL_FAILED', message, {
      command: args[0], exitCode: result.status, signal: result.signal,
      ...(directory ? { runDirectory: directory } : {}),
    });
  }
  return result.stdout.trimEnd();
}

function readJsonFile(path: string) {
  if (pathType(path) !== 'file') throw new FlowError('INVALID_FILE', `Expected a regular file: ${path}`);
  try {
    const bytes = readFileSync(path);
    return { bytes, value: JSON.parse(bytes.toString('utf8')) };
  } catch {
    throw new FlowError('INVALID_JSON', `Cannot read JSON: ${path}`);
  }
}

type VerifiedReceipt = {
  run: { runId: string; freezeSha256: string };
  planSha256: string;
  rawSha256: Record<string, string>;
  suite: { id: string; version: string };
  candidate: { source: unknown; isolated: unknown; versionBodySha256: string };
  evaluation: Evaluation;
  verificationScope: {
    providerExecution: string; realIsolationProbes: string; formalHoldout: string; liveSapIntegration: string;
  };
};

function verified(mode: RunMode, directory: string) {
  if (!isAbsolute(directory) || controlChars.test(directory)) {
    throw new FlowError('IR_EVAL_OUTPUT', 'ir-eval did not return an absolute run directory');
  }
  requireDirectory(directory);
  const check: { status: string; runId: string } = JSON.parse(runEvaluator(['verify', directory], directory));
  const reportPath = join(directory, 'report.md');
  const receiptPath = join(directory, 'receipt.json');
  const { bytes: receiptBytes, value: receipt } = readJsonFile(receiptPath) as {
    bytes: Buffer; value: VerifiedReceipt;
  };
  const receiptSha256 = digest(receiptBytes);
  const { value: completed } = readJsonFile(join(directory, 'completed.json'));
  if (check.status !== 'VERIFIED' || !uuid.test(check.runId) || check.runId !== receipt?.run?.runId ||
      receiptSha256 !== completed?.receiptSha256) {
    throw new FlowError('IR_EVAL_OUTPUT', 'ir-eval did not verify the expected run', { runDirectory: directory });
  }
  const { evidenceLevel, method, gain, terminations } = receipt.evaluation;
  const summary = {
    status: check.status, mode, evidenceLevel, runId: check.runId, runDirectory: directory,
    reportPath, receiptPath, method, gain, terminations, verificationScope: receipt.verificationScope,
  };
  return { summary, receipt, receiptSha256 };
}

function verifiedArchiveReason(evaluation: Evaluation) {
  if (evaluation.evidenceLevel !== 'RECORDED_REPLAY') return 'SYNTHETIC_REPLAY';
  const attempts = evaluation.cases.flatMap(item => sides.map(side => item[side]));
  if (attempts.some(attempt => attempt.termination !== 'COMPLETED')) return 'INCOMPLETE_RUN';
  if (evaluation.method.correctness !== 'PASS' || evaluation.method.applicability !== 'PASS') {
    return 'METHOD_GATE_NOT_PASSED';
  }
  if (attempts.some(attempt => attempt.issues.length)) return 'ATTEMPT_IDENTITY_UNVERIFIED';
  if (evaluation.cases.some(item => item.treatment.task !== 'PASS')) return 'TREATMENT_TASK_NOT_PASSED';
  return null;
}

function matchesRun(bundlePath: string, receipt: VerifiedReceipt): boolean {
  const matchesFile = (path: string, hash: string) =>
    pathType(path) === 'file' && digest(readFileSync(path)) === hash;
  try {
    const frozen = join(bundlePath, 'frozen');
    if (pathType(frozen) !== 'directory' ||
        !matchesFile(join(frozen, 'freeze.json'), receipt.run.freezeSha256) ||
        !matchesFile(join(frozen, 'plan.json'), receipt.planSha256)) return false;
    const draft = join(bundlePath, 'plan.json');
    if (pathType(draft) !== 'missing' && !matchesFile(draft, receipt.planSha256)) return false;
    readCaptures(join(bundlePath, 'captures'), receipt.rawSha256);
    return true;
  } catch {
    return false;
  }
}

function archiveBundle(bundlePath: string, pending: string, run: ReturnType<typeof verified>) {
  const { summary, receipt, receiptSha256 } = run;
  const kept = (reason: string) => ({ ...summary, archive: { status: 'KEPT_PENDING', reason, bundlePath } });
  if (pathType(pending) !== 'directory') return kept('OUTSIDE_PENDING');
  const pendingRoot = realpathSync(pending);
  if (realpathSync(dirname(bundlePath)) !== pendingRoot) {
    return kept('OUTSIDE_PENDING');
  }
  const source = join(pendingRoot, basename(bundlePath));
  if (pathType(source) !== 'directory') return kept('BUNDLE_CHANGED');
  const ineligible = verifiedArchiveReason(receipt.evaluation);
  if (ineligible) return kept(ineligible);
  const runDirectory = realpathSync(summary.runDirectory);
  const runRelative = relative(source, runDirectory);
  if (runRelative !== '..' && !runRelative.startsWith(`..${sep}`) && !isAbsolute(runRelative)) {
    return kept('RUN_INSIDE_BUNDLE');
  }
  if (!matchesRun(source, receipt)) return kept('BUNDLE_CHANGED');

  const archiveRoot = join(dirname(pendingRoot), 'archive');
  const entry = join(archiveRoot, summary.runId);
  const archivePath = join(entry, 'bundle');
  const archiveReceiptPath = join(entry, 'archive.json');
  const reportPath = join(runDirectory, 'report.md');
  const receiptPath = join(runDirectory, 'receipt.json');
  // These fields identify a staged move. The bundle's presence commits the archive.
  const moveIdentity = {
    schemaVersion: 1, sourceBundlePath: source, archivePath, runId: summary.runId,
    runDirectory, reportPath, receiptPath, receiptSha256,
  };
  try {
    if (archiveRoot === pendingRoot) throw new Error('Archive root is the pending directory');
    if (pathType(archiveRoot) === 'missing') mkdirSync(archiveRoot, { mode: 0o700 });
    requireDirectory(archiveRoot);
    if (pathType(entry) === 'missing') {
      mkdirSync(entry, { mode: 0o700 });
      writeJson(archiveReceiptPath, {
        ...moveIdentity, preparedAt: new Date().toISOString(),
        freezeSha256: receipt.run.freezeSha256, planSha256: receipt.planSha256,
        evidenceLevel: summary.evidenceLevel, method: summary.method, gain: summary.gain,
        suite: receipt.suite, candidate: receipt.candidate, verificationScope: summary.verificationScope,
      });
    } else {
      requireDirectory(entry);
      const files = readdirSync(entry);
      if (files.length !== 1 || files[0] !== 'archive.json') throw new Error('Archive destination is occupied');
      const { value: staged } = readJsonFile(archiveReceiptPath);
      if (typeof staged?.preparedAt !== 'string' ||
          !Object.entries(moveIdentity).every(([key, value]) => staged[key] === value)) {
        throw new Error('Existing archive receipt does not match the verified move');
      }
    }
    renameSync(source, archivePath);
  } catch (error) {
    throw new FlowError('ARCHIVE_FAILED', error instanceof Error ? error.message : 'Archive move failed', {
      bundlePath, runDirectory, reportPath, receiptPath, archivePath,
    });
  }
  return {
    ...summary, runDirectory, reportPath, receiptPath,
    archive: { status: 'ARCHIVED', archivePath, archiveReceiptPath },
  };
}

function parentArgs(flags: Map<string, string>, output: string, freezeDirectory: string) {
  const parent = flags.get('--parent');
  const reason = flags.get('--reason');
  if (parent === undefined && reason === undefined) return [];
  if (!parent || !uuid.test(parent) || !reason) {
    throw new FlowError('INVALID_ARGUMENT', '--parent <run-id> and --reason <text> must be supplied together');
  }
  const parentDirectory = join(output, parent);
  const manifest = join(parentDirectory, 'run.json');
  if (pathType(parentDirectory) !== 'directory' || pathType(manifest) !== 'file') {
    throw new FlowError('PARENT_NOT_FOUND', `Parent run not found in output directory: ${parentDirectory}`);
  }
  const { value: run } = readJsonFile(manifest);
  if (run?.schemaVersion !== 1 || run.runId !== parent) {
    throw new FlowError('INVALID_PARENT', `Parent run identity does not match: ${manifest}`);
  }
  if (run.freezeSha256 !== digest(readFileSync(join(freezeDirectory, 'freeze.json')))) {
    throw new FlowError('PARENT_FREEZE_MISMATCH', 'Parent run used a different freeze', { parentRunId: parent });
  }
  return ['--parent', parent, '--reason', reason];
}

function main([command, ...tokens]: string[]) {
  if (!command || command === 'help' || command === '--help') return { commands: usage };
  if (!Object.hasOwn(options, command)) throw new FlowError('INVALID_COMMAND', `Unknown command: ${command}`);
  const action = command as Command;
  const { flags, positionals } = parse(action, tokens);
  const [positional, archiveBundleArg] = positionals;
  const pending = absolute(flags.get('--pending') ?? defaultPending);
  const output = absolute(flags.get('--out') ?? defaultOutput);
  if (action === 'pending') return { status: 'OK', pendingDirectory: pending, bundles: listBundles(pending) };
  if (action === 'demo') return verified('demo', runEvaluator(['demo', output])).summary;
  if (action === 'verify') return verified('verify', absolute(positional!)).summary;

  const bundle = selectBundle(action === 'archive' ? archiveBundleArg : positional, pending);
  const bundlePath = bundle.path;
  const freezeDirectory = join(bundlePath, 'frozen');
  const captureDirectory = join(bundlePath, 'captures');
  if (bundle.state === 'INVALID') {
    throw new FlowError('INVALID_BUNDLE', bundle.issues.join('; '), { bundlePath });
  }
  if (action === 'archive') {
    const run = verified('archive', absolute(positional!));
    return archiveBundle(bundlePath, pending, run);
  }
  if (bundle.state === 'UNFROZEN_CAPTURES') {
    throw new FlowError('UNFROZEN_CAPTURES', 'Captures already exist without their original freeze', { bundlePath });
  }
  if (action === 'prepare') {
    if (bundle.state !== 'NEEDS_FREEZE') {
      return { status: 'ALREADY_FROZEN', bundlePath, freezeDirectory, captureDirectory };
    }
    runEvaluator(['freeze', join(bundlePath, 'plan.json'), freezeDirectory]);
    return { status: 'FROZEN', bundlePath, freezeDirectory, captureDirectory };
  }
  if (bundle.state === 'NEEDS_FREEZE') {
    throw new FlowError('FREEZE_MISSING', 'Prepare the bundle before collecting captures', { bundlePath });
  }
  if (bundle.state === 'NEEDS_CAPTURES') {
    throw new FlowError('CAPTURES_MISSING', 'No captures/ directory supplied', { bundlePath });
  }
  const replayArgs = ['replay', freezeDirectory, captureDirectory, output,
    ...parentArgs(flags, output, freezeDirectory)];
  const run = verified('eval', runEvaluator(replayArgs));
  return archiveBundle(bundlePath, pending, run);
}

try {
  process.stdout.write(JSON.stringify(main(process.argv.slice(2))) + '\n');
} catch (error) {
  const problem = error instanceof FlowError
    ? { code: error.code, message: error.message, ...error.details }
    : { code: 'FLOW_FAILED', message: error instanceof Error ? error.message : 'Unexpected flow failure' };
  process.stderr.write(JSON.stringify({ status: 'ERROR', ...problem }) + '\n');
  process.exitCode = 1;
}
