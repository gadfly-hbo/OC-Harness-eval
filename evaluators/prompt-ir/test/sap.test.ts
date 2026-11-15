import assert from 'node:assert/strict';
import test from 'node:test';
import { decodePiBranch, inspectSap, validateSapCandidate } from '../src/sap.ts';

const source = {
  kind: 'sap-method' as const,
  methodId: '11111111-1111-4111-8111-111111111111',
  version: 1,
  publishedHash: '690ee22fdf0f75827d4f70b1d402f11c43be5782fc590d206e9330c0127d35ad',
};
const isolated = { ...source, methodId: '22222222-2222-4222-8222-222222222222' };
const body = {
  schemaVersion: 1,
  methodId: source.methodId,
  version: 1,
  origin: 'other',
  title: 'Sample conversion method',
  content: {
    conditions: 'Comparable inputs',
    logic: 'Use visitor weights',
    judgment: 'Separate mix and rates',
    limits: 'Stop without common denominator',
  },
  sources: [],
  relation: null,
  savedAt: '2026-11-10T00:00:00Z',
  contentSha256: source.publishedHash,
  requestId: '33333333-3333-4333-8333-333333333333',
};
const candidate = { source, isolated, versionBody: JSON.stringify(body) };
const tool = 'read_semantic_context';
const query = { action: 'find', kinds: ['sap-method'], query: 'conversion' };
const isolatedBody = { ...body, methodId: isolated.methodId };
const call = (callId: string, args: unknown, name = tool) => ({ kind: 'tool_call', callId, name, args });
const response = (callId: string, action: string, target: unknown, methodBody: unknown, name = tool) => ({
  kind: 'tool_result', callId, name,
  result: {
    schemaVersion: 1,
    type: 'optracall.semantic-context-result',
    action, state: 'available',
    items: [{
      target, state: 'available', sha256: isolated.publishedHash,
      body: methodBody === null ? null : JSON.stringify(methodBody),
    }],
  },
});
const find = [call('find', query), response('find', 'find', isolated, null)] as const;
const read = [call('read', { action: 'read', target: isolated }), response('read', 'read', isolated, isolatedBody)] as const;

test('the exact isolated find and read preserve the original version identity and event evidence', () => {
  validateSapCandidate(candidate);
  const result = inspectSap([...find, ...read], candidate);
  assert.equal(result.find.status, 'PASS');
  assert.equal(result.read.status, 'PASS');
  assert.equal(result.readIndex, 3);
  assert.equal(result.verifiedReadIndex, 3);
  assert.deepEqual(result.find.evidence, [0, 1]);
  assert.deepEqual(result.read.evidence, [0, 1, 2, 3]);
  assert.deepEqual(result.targetExposureIndices, [1, 2, 3]);
});

const timestamp = '2026-11-10T00:00:00Z';
const header = { type: 'session', version: 3, id: 'independent-session', timestamp, cwd: '/isolated/project' };
const entry = (id: string, parentId: string | null, message: unknown) => ({
  type: 'message', id, parentId, timestamp, message,
});
const jsonl = (...rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

test('Pi replay follows only the declared leaf and retains original line numbers and exact final text', () => {
  const native = jsonl(
    header,
    entry('prompt', null, { role: 'user', content: 'Investigate' }),
    entry('sibling', 'prompt', { role: 'toolResult', toolName: tool, toolCallId: 'unrelated', content: [], details: { isolated } }),
    entry('find', 'prompt', { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: tool, arguments: query }] }),
    entry('find-result', 'find', {
      role: 'toolResult', toolName: tool, toolCallId: 'c1', isError: false,
      content: [{ type: 'text', text: JSON.stringify(response('c1', 'find', isolated, null).result) }],
      details: response('c1', 'find', isolated, null).result,
    }),
    entry('answer', 'find-result', {
      role: 'assistant', stopReason: 'stop', provider: 'offline-provider', model: 'offline-model',
      content: [{ type: 'text', text: 'Answer' }, { type: 'text', text: '\n' }],
    }),
    entry('later-sibling', 'prompt', { role: 'assistant', content: [{ type: 'text', text: 'Wrong branch' }] }),
  );
  const decoded = decodePiBranch(native, 'answer');
  assert.equal(decoded.sessionId, 'independent-session');
  assert.equal(decoded.cwd, '/isolated/project');
  assert.deepEqual(decoded.events.map(event => event.sourceLine), [4, 5]);
  assert.equal(decoded.assistantText, 'Answer\n');
  assert.deepEqual(decoded.assistantIdentity, { provider: 'offline-provider', model: 'offline-model' });
  assert.equal(inspectSap(decoded.events, candidate).find.status, 'PASS');
});

test('Pi replay reports no final answer when the branch ends at an error, follow-up or another tool request', () => {
  const prompt = entry('prompt', null, { role: 'user', content: 'Investigate' });
  const answer = entry('answer', 'prompt', {
    role: 'assistant', stopReason: 'stop', provider: 'offline-provider', model: 'offline-model',
    content: [{ type: 'text', text: 'Earlier answer' }],
  });
  const native = jsonl(header, prompt, answer,
    entry('follow-up', 'answer', { role: 'user', content: 'Investigate again' }),
    entry('error', 'follow-up', {
      role: 'assistant', stopReason: 'error',
      content: [{ type: 'text', text: 'Interrupted answer' }],
    }),
    entry('another-tool', 'follow-up', {
      role: 'assistant', stopReason: 'toolUse',
      content: [{ type: 'toolCall', id: 'last-call', name: 'bash', arguments: {} }],
    }),
  );
  for (const leaf of ['follow-up', 'error', 'another-tool']) {
    const decoded = decodePiBranch(native, leaf);
    assert.equal(decoded.assistantText, null, leaf);
    assert.equal(decoded.assistantIdentity, null, leaf);
  }
  assert.deepEqual(decodePiBranch(native, 'another-tool').events.map(event => event.sourceLine), [6]);
});

test('an exact read observed before a find has independent evidence but does not prove the formal sequence', () => {
  const observed = inspectSap([...read, ...find], candidate);
  assert.equal(observed.find.status, 'PASS');
  assert.equal(observed.read.status, 'UNKNOWN');
  assert.equal(observed.readIndex, null);
  assert.equal(observed.verifiedReadIndex, 1);
});

test('a body with correct metadata but changed business logic fails digest verification', () => {
  const changedBody = { ...isolatedBody, content: { ...body.content, logic: 'Use session weights' } };
  const observed = inspectSap([...find, read[0], response('read', 'read', isolated, changedBody)], candidate);
  assert.equal(observed.find.status, 'PASS');
  assert.equal(observed.read.status, 'FAIL');
  assert.equal(observed.verifiedReadIndex, null);
});

test('a returned body without a recorded receipt checksum leaves the read unknown', () => {
  const missingChecksum = response('read', 'read', isolated, isolatedBody);
  Reflect.deleteProperty(missingChecksum.result.items[0], 'sha256');
  const observed = inspectSap([...find, read[0], missingChecksum], candidate);
  assert.equal(observed.read.status, 'UNKNOWN');
  assert.equal(observed.verifiedReadIndex, null);
});

test('a reused call ID cannot establish a formal read from ambiguous raw evidence', () => {
  const observed = inspectSap([...find, read[0], read[0], read[1]], candidate);
  assert.equal(observed.read.status, 'UNKNOWN');
  assert.equal(observed.verifiedReadIndex, null);
});

test('native details without matching model-visible content do not establish a formal find', () => {
  const recorded = {
    ...find[1],
    result: {
      role: 'toolResult',
      isError: false,
      content: [{ type: 'text', text: 'Directory unavailable' }],
      details: find[1].result,
    },
  };
  const observed = inspectSap([find[0], recorded, ...read], candidate);
  assert.equal(observed.find.status, 'UNKNOWN');
  assert.equal(observed.read.status, 'UNKNOWN');
  assert.equal(observed.verifiedReadIndex, 3);
  assert.deepEqual(observed.targetExposureIndices, [1, 2, 3]);
});

test('a verified extraction-source read is recorded separately and cannot substitute for the ordinary SAP sequence', () => {
  const sourceTool = 'read_sap_method_source';
  const observed = inspectSap([
    call('other', { action: 'read-method', input: { target: source } }, sourceTool),
    {
      kind: 'tool_result', callId: 'other', name: sourceTool,
      result: { isError: false, details: { original: response('other', 'read', source, body).result } },
    },
  ], candidate);
  assert.deepEqual(observed.otherReadIndices, [1]);
  assert.equal(observed.read.status, 'UNKNOWN');
  assert.equal(observed.verifiedReadIndex, null);
});

test('Pi replay rejects incomplete JSONL, unsupported header, a missing parent, a cycle and duplicate entries', () => {
  const message = { role: 'user', content: 'Example' };
  assert.throws(() => decodePiBranch(jsonl(header, entry('a', null, message)).trimEnd(), 'a'));
  assert.throws(() => decodePiBranch(jsonl({ ...header, version: 2 }, entry('a', null, message)), 'a'));
  assert.throws(() => decodePiBranch(jsonl(header, entry('a', 'missing', message)), 'a'));
  assert.throws(() => decodePiBranch(jsonl(header, entry('a', 'b', message), entry('b', 'a', message)), 'a'));
  assert.throws(() => decodePiBranch(jsonl(header, entry('a', null, message), entry('a', null, message)), 'a'));
});

test('Pi replay rejects numeric overflow before evidence can be reserialized as null', () => {
  const data = jsonl(header, entry('call', null, {
    role: 'assistant', stopReason: 'toolUse',
    content: [{ type: 'toolCall', id: 'call-id', name: 'bash', arguments: { weight: 'replace-with-number' } }],
  })).replace('"replace-with-number"', '1e400');
  assert.throws(() => decodePiBranch(data, 'call'));
});
