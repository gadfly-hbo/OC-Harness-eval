import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { demoCaptures, demoPlan } from '../src/demo.ts';

const flowEntry = fileURLToPath(new URL('../src/flow.ts', import.meta.url));
const evalEntry = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function invoke(entry: string, args: string[]) {
  return spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8' });
}

function flow(...args: string[]) {
  const result = invoke(flowEntry, args);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function replay(fixture: ReturnType<typeof makeFixture>) {
  const result = invoke(evalEntry, ['replay', join(fixture.bundle, 'frozen'), fixture.captures, fixture.output]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function makeFixture(
  t: { after: (cleanup: () => void) => void },
  level: 'RECORDED_REPLAY' | 'SYNTHETIC_REPLAY' = 'RECORDED_REPLAY',
  outsidePending = false,
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ir-eval-bundle-archive-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pending = join(root, 'pending');
  const archive = join(root, 'archive');
  const output = join(root, 'runs');
  const bundle = join(outsidePending ? root : pending, '归档案例 v1');
  const captures = join(bundle, 'captures');
  mkdirSync(pending);
  mkdirSync(archive);
  mkdirSync(bundle);
  const plan = { ...demoPlan, evidenceLevel: level };
  writeFileSync(join(bundle, 'plan.json'), JSON.stringify(plan));
  assert.equal(flow('prepare', bundle).status, 'FROZEN');
  mkdirSync(captures);
  for (const [name, bytes] of demoCaptures(demoPlan)) {
    if (level === 'SYNTHETIC_REPLAY' || name.endsWith('.method.json')) {
      writeFileSync(join(captures, name), bytes);
      continue;
    }
    // Exercise the recorded replay parser entirely offline with a Pi-shaped fixture.
    const capture = JSON.parse(bytes.toString('utf8'));
    const timestamp = '2026-11-10T00:00:00.000Z';
    const session = { type: 'session', version: 3, id: capture.sessionId, timestamp, cwd: captures };
    const finalMessage = {
      type: 'message', id: 'assistant-final', parentId: null, timestamp,
      message: {
        role: 'assistant', stopReason: 'stop',
        provider: plan.settings.model.provider, model: plan.settings.model.id,
        content: [{ type: 'text', text: capture.output.report }],
      },
    };
    capture.native = { leafId: finalMessage.id,
      jsonl: [session, finalMessage].map(entry => JSON.stringify(entry)).join('\n') + '\n' };
    writeFileSync(join(captures, name), JSON.stringify(capture));
  }
  return { pending, archive, output, bundle, captures };
}

function runBundle(fixture: ReturnType<typeof makeFixture>) {
  return flow('eval', fixture.bundle, '--pending', fixture.pending, '--out', fixture.output);
}

function assertKept(
  fixture: ReturnType<typeof makeFixture>,
  result: ReturnType<typeof flow>,
  reason: string,
) {
  assert.equal(result.status, 'VERIFIED');
  assert.equal(result.archive?.status, 'KEPT_PENDING');
  assert.equal(result.archive.reason, reason);
  assert.ok(existsSync(fixture.bundle));
  assert.deepEqual(readdirSync(fixture.archive), []);
  assert.ok(existsSync(result.reportPath));
}

function failReview(captures: string, name: string) {
  const path = join(captures, name);
  const capture = JSON.parse(readFileSync(path, 'utf8'));
  capture.review.status = 'FAIL';
  writeFileSync(path, JSON.stringify(capture));
}

test('automatically moves the complete verified package and preserves the auditable run', t => {
  const fixture = makeFixture(t);
  const extra = Buffer.from('Notes alongside the plan and captures.\n');
  writeFileSync(join(fixture.bundle, 'notes.md'), extra);
  const captureName = 'unified-visitors.baseline.json';
  const capture = readFileSync(join(fixture.captures, captureName));
  const result = runBundle(fixture);
  assert.equal(result.status, 'VERIFIED');
  assert.equal(result.archive?.status, 'ARCHIVED');
  const archivePath = join(fixture.archive, result.runId, 'bundle');
  assert.equal(result.archive.archivePath, archivePath);
  assert.equal(result.archive.archiveReceiptPath, join(fixture.archive, result.runId, 'archive.json'));
  const archiveReceipt = JSON.parse(readFileSync(result.archive.archiveReceiptPath, 'utf8'));
  assert.equal(archiveReceipt.runId, result.runId);
  assert.equal(archiveReceipt.receiptSha256,
    createHash('sha256').update(readFileSync(result.receiptPath)).digest('hex'));
  assert.equal(existsSync(fixture.bundle), false);
  assert.deepEqual(readdirSync(fixture.pending), []);
  assert.deepEqual(readFileSync(join(archivePath, 'notes.md')), extra);
  assert.deepEqual(readFileSync(join(archivePath, 'captures', captureName)), capture);
  assert.ok(existsSync(join(archivePath, 'frozen', 'freeze.json')));
  const receipt = JSON.parse(readFileSync(result.receiptPath, 'utf8'));
  const scenario = receipt.evaluation.cases.find((entry: { id: string }) => entry.id === 'unified-visitors');
  assert.equal(scenario.baseline.task, 'FAIL');
  assert.equal(scenario.treatment.task, 'PASS');
  assert.equal(scenario.treatment.reuse.status, 'UNKNOWN');
  assert.equal(result.gain.status, 'UNKNOWN');
  assert.equal(flow('verify', result.runDirectory).status, 'VERIFIED');
});

test('a passing synthetic replay stays in pending', t => {
  const fixture = makeFixture(t, 'SYNTHETIC_REPLAY');
  const result = runBundle(fixture);
  assert.equal(result.method.correctness, 'PASS');
  assertKept(fixture, result, 'SYNTHETIC_REPLAY');
});

test('a missing capture stays in pending, with the missing result preserved after a later pass', t => {
  const fixture = makeFixture(t);
  const file = join(fixture.captures, 'unified-visitors.baseline.json');
  const bytes = readFileSync(file);
  rmSync(file);
  const incomplete = runBundle(fixture);
  assertKept(fixture, incomplete, 'INCOMPLETE_RUN');
  assert.equal(incomplete.terminations.baseline.NOT_RUN, 1);
  writeFileSync(file, bytes);
  const complete = runBundle(fixture);
  assert.equal(complete.archive?.status, 'ARCHIVED');
  assert.equal(flow('verify', incomplete.runDirectory).terminations.baseline.NOT_RUN, 1);
});

test('failed method review and failed treatment delivery each block archive', async t => {
  await t.test('method failure', subtest => {
    const fixture = makeFixture(subtest);
    failReview(fixture.captures, 'source-same-basis.method.json');
    const result = runBundle(fixture);
    assert.equal(result.method.correctness, 'FAIL');
    assertKept(fixture, result, 'METHOD_GATE_NOT_PASSED');
  });

  await t.test('treatment failure', subtest => {
    const fixture = makeFixture(subtest);
    failReview(fixture.captures, 'source-same-basis.treatment.json');
    const result = runBundle(fixture);
    assert.equal(result.method.correctness, 'PASS');
    assertKept(fixture, result, 'TREATMENT_TASK_NOT_PASSED');
  });
});

test('manual archive only moves the same capture bytes as the verified replay', t => {
  const fixture = makeFixture(t);
  const run = replay(fixture);
  assert.equal(flow('verify', run).status, 'VERIFIED');
  assert.ok(existsSync(fixture.bundle));
  const file = join(fixture.captures, 'unified-visitors.baseline.json');
  const original = readFileSync(file);
  appendFileSync(file, '\n');
  const blocked = flow('archive', run, fixture.bundle, '--pending', fixture.pending);
  assertKept(fixture, blocked, 'BUNDLE_CHANGED');
  writeFileSync(file, original);
  const result = flow('archive', run, fixture.bundle, '--pending', fixture.pending);
  assert.equal(result.archive?.status, 'ARCHIVED');
  assert.equal(existsSync(fixture.bundle), false);
  assert.equal(flow('verify', run).status, 'VERIFIED');
});

test('a passing explicit bundle outside pending is left where it is', t => {
  const fixture = makeFixture(t, 'RECORDED_REPLAY', true);
  assertKept(fixture, runBundle(fixture), 'OUTSIDE_PENDING');
});

test('a mismatched attempt identity blocks archive even with a complete run', t => {
  const fixture = makeFixture(t);
  const path = join(fixture.captures, 'source-same-basis.baseline.json');
  const capture = JSON.parse(readFileSync(path, 'utf8'));
  capture.settingsHash = 'different settings';
  writeFileSync(path, JSON.stringify(capture));
  const result = runBundle(fixture);
  assert.equal(result.method.correctness, 'PASS');
  assert.equal(result.terminations.baseline.COMPLETED, 4);
  assertKept(fixture, result, 'ATTEMPT_IDENTITY_UNVERIFIED');
});

test('an output alias inside the bundle keeps canonical evidence links after archive', t => {
  const fixture = makeFixture(t);
  mkdirSync(fixture.output);
  const alias = join(fixture.bundle, 'external-runs');
  symlinkSync(fixture.output, alias);
  const result = flow('eval', fixture.bundle, '--pending', fixture.pending, '--out', alias);
  assert.equal(result.archive?.status, 'ARCHIVED');
  assert.equal(existsSync(fixture.bundle), false);
  assert.equal(result.runDirectory, join(fixture.output, result.runId));
  assert.equal(result.reportPath, join(result.runDirectory, 'report.md'));
  assert.equal(result.receiptPath, join(result.runDirectory, 'receipt.json'));
  assert.ok(existsSync(result.reportPath));
  const archiveReceipt = JSON.parse(readFileSync(result.archive.archiveReceiptPath, 'utf8'));
  assert.equal(archiveReceipt.runDirectory, result.runDirectory);
  assert.equal(archiveReceipt.reportPath, result.reportPath);
  assert.equal(archiveReceipt.receiptPath, result.receiptPath);
  assert.equal(flow('verify', result.runDirectory).status, 'VERIFIED');
});

test('retries a matching prepared archive entry after interruption before the move', t => {
  const fixture = makeFixture(t);
  const run = replay(fixture);
  const result = flow('verify', run);
  const entry = join(fixture.archive, result.runId);
  const archivePath = join(entry, 'bundle');
  const archiveReceiptPath = join(entry, 'archive.json');
  const receiptSha256 = createHash('sha256').update(readFileSync(result.receiptPath)).digest('hex');
  mkdirSync(entry);
  writeFileSync(archiveReceiptPath, JSON.stringify({
    schemaVersion: 1, preparedAt: '2026-11-10T00:00:00.000Z',
    sourceBundlePath: fixture.bundle, archivePath, runId: result.runId, receiptSha256,
    runDirectory: run, reportPath: join(run, 'report.md'), receiptPath: join(run, 'receipt.json'),
  }));
  assert.equal(existsSync(archivePath), false);
  const retried = flow('archive', run, fixture.bundle, '--pending', fixture.pending);
  assert.equal(retried.archive?.status, 'ARCHIVED');
  assert.equal(retried.archive.archivePath, archivePath);
  assert.equal(retried.archive.archiveReceiptPath, archiveReceiptPath);
  assert.equal(existsSync(fixture.bundle), false);
  assert.ok(existsSync(join(archivePath, 'frozen', 'freeze.json')));
  assert.equal(flow('verify', result.runDirectory).status, 'VERIFIED');
});

test('archive collisions keep the package and identify the already verified run', t => {
  const fixture = makeFixture(t);
  const run = replay(fixture);
  const runId = JSON.parse(readFileSync(join(run, 'run.json'), 'utf8')).runId;
  const occupied = join(fixture.archive, runId);
  mkdirSync(occupied);
  const sentinel = join(occupied, 'keep.txt');
  writeFileSync(sentinel, 'existing archive');
  const result = invoke(flowEntry, ['archive', run, fixture.bundle, '--pending', fixture.pending]);
  assert.notEqual(result.status, 0);
  const error = JSON.parse(result.stderr);
  assert.equal(error.code, 'ARCHIVE_FAILED');
  assert.equal(error.runDirectory, run);
  assert.equal(error.reportPath, join(run, 'report.md'));
  assert.equal(readFileSync(sentinel, 'utf8'), 'existing archive');
  assert.ok(existsSync(fixture.bundle));
});
