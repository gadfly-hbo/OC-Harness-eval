import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { demoPlan } from '../src/demo.ts';

const entry = fileURLToPath(new URL('../src/flow.ts', import.meta.url));

function flow(...args: string[]) {
  return spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8' });
}

function success(...args: string[]) {
  const result = flow(...args);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function failure(...args: string[]) {
  const result = flow(...args);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  const resultError = JSON.parse(result.stderr);
  assert.equal(resultError.status, 'ERROR');
  return resultError;
}

function workspace(t: { after: (cleanup: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'ir-eval-flow-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function createBundle(directory: string) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'plan.json'), JSON.stringify(demoPlan));
}

test('demo verifies its run and returns machine-readable links and evidence scope', t => {
  const output = join(workspace(t), 'output with spaces');
  const result = success('demo', '--out', output);
  assert.equal(result.status, 'VERIFIED');
  assert.equal(result.mode, 'demo');
  assert.equal(result.evidenceLevel, 'SYNTHETIC_REPLAY');
  assert.equal(result.method.correctness, 'PASS');
  assert.equal(result.gain.comparablePairs, 4);
  assert.equal(result.verificationScope.providerExecution, 'NOT_RUN');
  assert.equal(result.reportPath, join(output, result.runId, 'report.md'));
  assert.equal(result.receiptPath, join(output, result.runId, 'receipt.json'));
  const check = success('verify', result.runDirectory);
  assert.deepEqual(check, { ...result, mode: 'verify' });

  writeFileSync(result.reportPath, 'edited report');
  const error = failure('verify', result.runDirectory);
  assert.equal(error.code, 'IR_EVAL_FAILED');
  assert.equal(error.runDirectory, result.runDirectory);
  assert.match(error.message, /Receipt or report differs/);
});

test('unique pending bundle is prepared before captures, and an empty capture directory remains NOT_RUN', t => {
  const directory = workspace(t);
  const pending = join(directory, 'pending');
  const bundle = join(pending, 'candidate v1');
  const output = join(directory, 'runs');
  createBundle(bundle);
  const pendingFlags = ['--pending', pending];
  const inventory = success('pending', '--json', ...pendingFlags);
  assert.equal(inventory.pendingDirectory, pending);
  assert.deepEqual(inventory.bundles.map(({ path, state }: { path: string; state: string }) =>
    ({ path, state })), [{ path: bundle, state: 'NEEDS_FREEZE' }]);

  const prepared = success('prepare', ...pendingFlags);
  assert.equal(prepared.status, 'FROZEN');
  assert.equal(prepared.freezeDirectory, join(bundle, 'frozen'));
  const frozen = readFileSync(join(bundle, 'frozen', 'freeze.json'));
  assert.equal(success('prepare', bundle).status, 'ALREADY_FROZEN');
  assert.deepEqual(readFileSync(join(bundle, 'frozen', 'freeze.json')), frozen);
  assert.equal(failure('eval', bundle, '--out', output).code, 'CAPTURES_MISSING');

  mkdirSync(join(bundle, 'captures'));
  const first = success('eval', ...pendingFlags, '--out', output);
  assert.equal(first.status, 'VERIFIED');
  assert.equal(first.terminations.method.NOT_RUN, 4);
  assert.equal(first.gain.status, 'UNKNOWN');
  assert.equal(failure('eval', bundle, '--out', output, '--parent',
    '00000000-0000-4000-8000-000000000001', '--reason', 'offline replay').code, 'PARENT_NOT_FOUND');
  const second = success('eval', bundle, '--out', output, '--parent', first.runId, '--reason', 'offline replay');
  assert.notEqual(first.runId, second.runId);
  assert.equal(JSON.parse(readFileSync(second.receiptPath, 'utf8')).run.parentRunId, first.runId);
  assert.equal(success('verify', first.runDirectory).status, 'VERIFIED');

  const other = join(directory, 'another plan');
  createBundle(other);
  writeFileSync(join(other, 'plan.json'), JSON.stringify({ ...demoPlan,
    suite: { ...demoPlan.suite, version: 'other' } }));
  success('prepare', other);
  mkdirSync(join(other, 'captures'));
  assert.equal(failure('eval', other, '--out', output, '--parent', first.runId,
    '--reason', 'offline replay').code, 'PARENT_FREEZE_MISMATCH');
});

test('ambiguous pending does not pick a bundle, while explicit paths are honored', t => {
  const directory = workspace(t);
  const pending = join(directory, 'pending');
  mkdirSync(pending);
  assert.equal(failure('prepare', '--pending', pending).code, 'NO_BUNDLE');
  const first = join(pending, 'a');
  const second = join(pending, 'b');
  createBundle(first);
  createBundle(second);
  const error = failure('prepare', '--pending', pending);
  assert.equal(error.code, 'AMBIGUOUS_BUNDLE');
  assert.deepEqual(error.bundles, [first, second]);
  assert.equal(success('prepare', first, '--pending', pending).bundlePath, first);
  assert.deepEqual(readdirSync(second), ['plan.json']);
});

test('prepare refuses to freeze after captures and refuses an incomplete existing freeze', t => {
  const bundle = join(workspace(t), 'candidate');
  createBundle(bundle);
  const captures = join(bundle, 'captures');
  mkdirSync(captures);
  writeFileSync(join(captures, 'case.baseline.json'), '{}');
  assert.equal(failure('prepare', bundle).code, 'UNFROZEN_CAPTURES');
  assert.deepEqual(readdirSync(bundle).sort(), ['captures', 'plan.json']);

  mkdirSync(join(bundle, 'frozen'));
  const error = failure('prepare', bundle);
  assert.equal(error.code, 'INVALID_BUNDLE');
  assert.match(error.message, /frozen\/plan\.json/);
});

test('a Finder metadata file in a new bundle is kept and does not block preparation', t => {
  const directory = workspace(t);
  const bundle = join(directory, 'candidate');
  createBundle(bundle);
  const captures = join(bundle, 'captures');
  mkdirSync(captures);
  writeFileSync(join(captures, '.DS_Store'), 'metadata');
  assert.equal(success('prepare', bundle).status, 'FROZEN');
  const result = success('eval', bundle, '--out', join(directory, 'runs'));
  assert.equal(readFileSync(join(result.runDirectory, 'raw', '.DS_Store'), 'utf8'), 'metadata');
  assert.deepEqual(readdirSync(captures), ['.DS_Store']);
});

test('replay errors return the original reason and preserved run path', t => {
  const directory = workspace(t);
  const bundle = join(directory, 'candidate');
  createBundle(bundle);
  success('prepare', bundle);
  mkdirSync(join(bundle, 'captures'));
  symlinkSync(join(bundle, 'plan.json'), join(bundle, 'captures', 'invalid.json'));
  const error = failure('eval', bundle, '--out', join(directory, 'runs'));
  assert.equal(error.code, 'IR_EVAL_FAILED');
  assert.match(error.message, /Capture is not a regular file/);
  assert.equal(JSON.parse(readFileSync(join(error.runDirectory, 'interrupted.json'), 'utf8')).status, 'NOT_EVALUATED');
});
