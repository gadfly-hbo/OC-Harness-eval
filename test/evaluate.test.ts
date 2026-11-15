import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluate, fingerprint, validatePlan } from '../src/evaluate.ts';
import { demoPlan, demoCaptures } from '../src/demo.ts';

test('offline control: correct v1-shaped synthetic method, wrong-but-closing baseline and one boundary', () => {
  validatePlan(demoPlan);
  const result = evaluate(demoPlan, demoCaptures(demoPlan));
  assert.equal(result.method.correctness, 'PASS');
  assert.equal(result.method.applicability, 'PASS');
  const paired = result.cases.find(item => item.id === 'unified-visitors')!;
  assert.equal(paired.baseline.businessAnswer, 'FAIL');
  assert.equal(paired.treatment.businessAnswer, 'PASS');
  assert.equal(paired.treatment.reuse.status, 'PASS');
  assert.equal(paired.gain, 'IMPROVED');
  const boundary = result.cases.find(item => item.id === 'missing-sessions')!;
  assert.equal(boundary.treatment.applicability, 'PASS');
  assert.equal(boundary.treatment.businessAnswer, 'UNKNOWN');
  assert.equal(boundary.gain, 'TIED');
});

function amend(captures: Map<string, Buffer>, name: string, change: (input: any) => void) {
  const input = JSON.parse(captures.get(name)!.toString());
  change(input);
  captures.set(name, Buffer.from(JSON.stringify(input)));
}

test('does not attribute an initial calculation to a later read, and credits a separately bound recheck', () => {
  const captures = demoCaptures(demoPlan);
  const original = evaluate(demoPlan, captures).cases.find(item => item.id === 'migration-session-mix')!;
  assert.equal(original.treatment.reuse.stage, 'recheck');
  assert.equal(original.treatment.reuse.status, 'PASS');
  amend(captures, 'migration-session-mix.treatment.json', input => {
    input.review.adoption = { ...input.review.adoption, stage: 'initial', eventIndex: 0,
      eventHash: fingerprint(input.events[0]) };
  });
  const changed = evaluate(demoPlan, captures).cases.find(item => item.id === 'migration-session-mix')!;
  assert.equal(changed.treatment.sap?.read.status, 'PASS');
  assert.equal(changed.treatment.reuse.status, 'UNKNOWN');
  assert.equal(changed.treatment.businessAnswer, 'PASS');
});

test('find without a read, and a read without evidence of adoption, cannot establish reuse', () => {
  const captures = demoCaptures(demoPlan);
  amend(captures, 'source-same-basis.treatment.json', input => {
    input.events = input.events.slice(0, 2);
    delete input.review.adoption;
  });
  amend(captures, 'unified-visitors.treatment.json', input => { delete input.review.adoption; });
  const result = evaluate(demoPlan, captures);
  const findOnly = result.cases.find(item => item.id === 'source-same-basis')!.treatment;
  assert.equal(findOnly.sap?.find.status, 'PASS');
  assert.equal(findOnly.sap?.read.status, 'UNKNOWN');
  assert.equal(findOnly.reuse.status, 'UNKNOWN');
  const readOnly = result.cases.find(item => item.id === 'unified-visitors')!.treatment;
  assert.equal(readOnly.sap?.read.status, 'PASS');
  assert.equal(readOnly.reuse.status, 'UNKNOWN');
  assert.equal(result.method.correctness, 'PASS');
});

test('leak, identity drift, invalid capture, timeout, cancellation and missing records stay distinct', () => {
  const captures = demoCaptures(demoPlan);
  amend(captures, 'source-same-basis.baseline.json', input => {
    input.isolation.checks.memory = { state: 'leak', evidence: 'target visible in retained memory' };
  });
  amend(captures, 'unified-visitors.treatment.json', input => { input.termination = 'TIMEOUT'; });
  amend(captures, 'migration-session-mix.treatment.json', input => { input.settingsHash = 'changed'; });
  amend(captures, 'missing-sessions.treatment.json', input => { input.termination = 'CANCELLED'; });
  captures.delete('source-same-basis.method.json');
  captures.set('missing-sessions.baseline.json', Buffer.from('{broken'));
  captures.set('unplanned.json', Buffer.from('unexpected'));
  const result = evaluate(demoPlan, captures);
  assert.equal(result.gain.comparablePairs, 0);
  assert.equal(result.gain.observedDelta, null);
  assert.equal(result.method.correctness, 'UNKNOWN');
  assert.equal(result.terminations.treatment.TIMEOUT, 1);
  assert.equal(result.terminations.treatment.CANCELLED, 1);
  assert.equal(result.terminations.method.NOT_RUN, 1);
  assert.equal(result.terminations.baseline.INVALID_CAPTURE, 1);
  assert.deepEqual(result.unplannedFiles, ['unplanned.json']);
  assert.ok(result.cases.find(item => item.id === 'source-same-basis')!.pairIssues.includes('baseline:LEAK_MEMORY'));
  assert.ok(result.cases.find(item => item.id === 'migration-session-mix')!.pairIssues.includes('treatment:SETTINGS_HASH_MISMATCH'));
});

test('a disallowed attribution in the report fails applicability even with a valid stop record', () => {
  const captures = demoCaptures(demoPlan);
  amend(captures, 'missing-sessions.method.json', input => {
    input.review.status = 'FAIL';
    input.review.reason = 'The report attributes the change despite incomparable evidence';
  });
  const result = evaluate(demoPlan, captures);
  assert.equal(result.method.applicability, 'FAIL');
  assert.equal(result.cases.find(item => item.id === 'missing-sessions')!.method.businessAnswer, 'UNKNOWN');
});

test('cross-case session or workspace reuse makes affected pairs indeterminate', () => {
  const captures = demoCaptures(demoPlan);
  const existing = JSON.parse(captures.get('source-same-basis.baseline.json')!.toString());
  amend(captures, 'unified-visitors.treatment.json', input => {
    input.sessionId = existing.sessionId;
    input.workspaceId = existing.workspaceId;
  });
  const result = evaluate(demoPlan, captures);
  const source = result.cases.find(item => item.id === 'source-same-basis')!;
  const unified = result.cases.find(item => item.id === 'unified-visitors')!;
  assert.equal(source.gain, 'UNKNOWN');
  assert.equal(unified.gain, 'UNKNOWN');
  assert.equal(unified.treatment.reuse.status, 'UNKNOWN');
  assert.ok(unified.pairIssues.includes('treatment:REUSED_SESSION'));
  assert.ok(unified.pairIssues.includes('treatment:REUSED_WORKSPACE'));
  assert.equal(result.gain.status, 'UNKNOWN');
  assert.equal(result.gain.comparableFamilies, 2);
});

test('a second calculation cannot be attributed as initial after a verified read', () => {
  const captures = demoCaptures(demoPlan);
  amend(captures, 'unified-visitors.treatment.json', input => {
    input.events.unshift(input.events[input.review.adoption.eventIndex]);
    input.review.adoption.eventIndex++;
  });
  const attempt = evaluate(demoPlan, captures).cases.find(item => item.id === 'unified-visitors')!.treatment;
  assert.equal(attempt.sap?.read.status, 'PASS');
  assert.equal(attempt.reuse.status, 'UNKNOWN');
});

test('an out-of-range JSON number invalidates only its capture', () => {
  const captures = demoCaptures(demoPlan);
  const name = 'source-same-basis.baseline.json';
  const bytes = captures.get(name)!.toString().replace('"before": 5', '"before": 1e400');
  assert.match(bytes, /1e400/);
  captures.set(name, Buffer.from(bytes));
  const result = evaluate(demoPlan, captures);
  assert.equal(result.terminations.baseline.INVALID_CAPTURE, 1);
  assert.equal(result.terminations.baseline.COMPLETED, 3);
  assert.equal(result.gain.status, 'UNKNOWN');
});

test('recorded SAP evidence is audited and unrelated tools cannot prove method reuse', () => {
  const plan = { ...demoPlan, evidenceLevel: 'RECORDED_REPLAY' as const };
  const captures = demoCaptures(demoPlan);
  const name = 'unified-visitors.treatment.json';
  amend(captures, name, input => {
    const timestamp = '2026-11-10T12:00:00.000Z';
    const entries: Record<string, unknown>[] = [
      { type: 'session', version: 3, id: input.sessionId, timestamp, cwd: '/synthetic/workspace' },
    ];
    let parentId: string | null = null;
    const add = (message: unknown) => {
      const id = 'entry-' + entries.length;
      entries.push({ type: 'message', id, parentId, timestamp, message });
      parentId = id;
    };
    for (const event of input.events) {
      if (event.kind === 'tool_call') add({ role: 'assistant', stopReason: 'toolUse',
        content: [{ type: 'toolCall', id: event.callId, name: event.name, arguments: event.args }] });
      if (event.kind === 'tool_result') add({ role: 'toolResult', toolName: event.name, toolCallId: event.callId,
        isError: false, details: event.result.details, content: [
          { type: 'text', text: JSON.stringify(event.result.details) },
        ] });
    }
    const args = { path: 'unrelated.txt' };
    add({ role: 'assistant', stopReason: 'toolUse',
      content: [{ type: 'toolCall', id: 'unrelated', name: 'read', arguments: args }] });
    const message = { role: 'toolResult', toolName: 'read', toolCallId: 'unrelated', isError: false,
      content: [{ type: 'text', text: 'unrelated content' }] };
    add(message);
    input.review.adoption.eventIndex = 5;
    input.review.adoption.eventHash = fingerprint({
      kind: 'tool_result', callId: 'unrelated', name: 'read', result: message, sourceLine: 7,
    });
    input.review.adoption.callHash = fingerprint({
      kind: 'tool_call', callId: 'unrelated', name: 'read', args, sourceLine: 6,
    });
    add({ role: 'assistant', stopReason: 'stop', provider: plan.settings.model.provider,
      model: plan.settings.model.id, content: [{ type: 'text', text: input.output.report }] });
    input.native = { leafId: parentId, jsonl: entries.map(entry => JSON.stringify(entry)).join('\n') + '\n' };
  });
  const result = evaluate(plan, captures);
  const pair = result.cases.find(item => item.id === 'unified-visitors')!;
  assert.equal(pair.treatment.sap?.read.status, 'PASS');
  assert.equal(pair.treatment.businessAnswer, 'PASS');
  assert.equal(pair.treatment.reuse.status, 'UNKNOWN');
  assert.deepEqual(pair.treatment.nativeEventLines, [2, 3, 4, 5, 6, 7]);
  assert.equal(pair.gain, 'UNKNOWN');
  assert.ok(pair.pairIssues.includes('HOST_ISOLATION_NOT_INDEPENDENTLY_VERIFIED'));
});
