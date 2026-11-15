import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

function cli(...args: string[]) {
  return spawnSync(process.execPath, ['src/cli.ts', ...args], { encoding: 'utf8' });
}

test('CLI freezes, archives, recomputes, and preserves a separate replay with partial evidence', t => {
  const output = mkdtempSync(join(tmpdir(), 'ir-eval-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const initial = cli('demo', output);
  assert.equal(initial.status, 0, initial.stderr);
  const run = initial.stdout.trim();
  const receipt = JSON.parse(readFileSync(join(run, 'receipt.json'), 'utf8'));
  assert.equal(receipt.evaluation.evidenceLevel, 'SYNTHETIC_REPLAY');
  assert.equal(receipt.evaluation.method.correctness, 'PASS');
  assert.equal(receipt.evaluation.gain.comparablePairs, 4);
  assert.equal(receipt.verificationScope.providerExecution, 'NOT_RUN');
  assert.match(readFileSync(join(run, 'report.md'), 'utf8'), /unified-visitors.*IMPROVED/);
  const check = cli('verify', run);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(JSON.parse(check.stdout).status, 'VERIFIED');

  const demoInputs = join(output, 'demo-inputs');
  const input = join(demoInputs, readdirSync(demoInputs)[0]);
  const captures = join(input, 'captures');
  const damaged = join(captures, 'unified-visitors.baseline.json');
  const raw = Buffer.from('{broken\n');
  writeFileSync(damaged, raw);
  const repeat = cli('replay', join(input, 'frozen'), captures, output,
    '--parent', receipt.run.runId, '--reason', 'fixture corruption regression');
  assert.equal(repeat.status, 0, repeat.stderr);
  const next = repeat.stdout.trim();
  assert.notEqual(run, next);
  const nextReceipt = JSON.parse(readFileSync(join(next, 'receipt.json'), 'utf8'));
  assert.equal(nextReceipt.run.parentRunId, receipt.run.runId);
  assert.equal(nextReceipt.evaluation.terminations.baseline.INVALID_CAPTURE, 1);
  assert.equal(nextReceipt.evaluation.gain.comparablePairs, 3);
  assert.deepEqual(readFileSync(join(next, 'raw', 'unified-visitors.baseline.json')), raw);
  assert.equal(cli('verify', run).status, 0);

  writeFileSync(join(next, 'raw', 'unified-visitors.baseline.json'), 'tampered');
  const invalid = cli('verify', next);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Capture hash mismatch/);
});

test('CLI preserves failure metadata when a capture cannot be archived', t => {
  const output = mkdtempSync(join(tmpdir(), 'ir-eval-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const initial = cli('demo', output);
  assert.equal(initial.status, 0, initial.stderr);
  const demoInputs = join(output, 'demo-inputs');
  const input = join(demoInputs, readdirSync(demoInputs)[0]);
  const captures = join(input, 'captures');
  symlinkSync(join(input, 'plan.json'), join(captures, 'zz-link.json'));
  const stopped = cli('replay', join(input, 'frozen'), captures, output);
  assert.notEqual(stopped.status, 0);
  assert.match(stopped.stderr, /Capture is not a regular file/);
  const directory = stopped.stderr.split('\n')[0].split('Preserved run: ')[1];
  assert.equal(JSON.parse(readFileSync(join(directory, 'interrupted.json'), 'utf8')).status, 'NOT_EVALUATED');
  assert.equal(JSON.parse(readFileSync(join(directory, 'run.json'), 'utf8')).matrix.length, 12);
  assert.ok(readdirSync(join(directory, 'raw')).length > 0);
});
