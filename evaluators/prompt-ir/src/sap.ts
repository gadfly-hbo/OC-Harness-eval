import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export type SapTarget = {
  kind: 'sap-method';
  methodId: string;
  version: number;
  publishedHash: string;
};

export type SapCandidate = { source: SapTarget; isolated: SapTarget; versionBody: string };
type RecordValue = Record<string, unknown>;
type Finding = { status: 'PASS' | 'FAIL' | 'UNKNOWN'; reason: string; evidence: number[] };

export type SapInspection = {
  find: Finding;
  read: Finding;
  readIndex: number | null;
  verifiedReadIndex: number | null;
  targetExposureIndices: number[];
  otherReadIndices: number[];
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha = /^[0-9a-f]{64}$/;
const fields = ['conditions', 'logic', 'judgment', 'limits'];
const semanticTool = 'read_semantic_context';
const semanticResult = 'optracall.semantic-context-result';
const obj = (value: unknown): value is RecordValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const hash = (value: unknown): value is string => typeof value === 'string' && sha.test(value);
const isId = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
const version = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const date = (value: unknown): boolean => typeof value === 'string' && Number.isFinite(Date.parse(value));

function parseObject(text: unknown): RecordValue | null {
  if (typeof text !== 'string') return null;
  try {
    const value: unknown = JSON.parse(text, (_key: string, item: unknown) => {
      if (typeof item === 'number' && !Number.isFinite(item)) throw new SyntaxError('Non-finite JSON number');
      return item;
    });
    return obj(value) ? value : null;
  } catch {
    return null;
  }
}

function isTarget(value: unknown): value is SapTarget {
  return obj(value) && value.kind === 'sap-method' && isId(value.methodId)
    && version(value.version) && hash(value.publishedHash);
}

function matchesTarget(value: unknown, target: SapTarget): boolean {
  return isTarget(value) && value.methodId === target.methodId && value.version === target.version
    && value.publishedHash === target.publishedHash;
}

function matchesVersion(value: unknown, target: SapTarget): boolean {
  return obj(value) && value.kind === 'sap-method' && value.methodId === target.methodId
    && value.version === target.version
    && (value.publishedHash == null || value.publishedHash === target.publishedHash);
}

// OptraCall Metric Factory hashes the validated definition, not the serialized version file.
function bodyMatches(text: unknown, target: SapTarget): boolean {
  const body = parseObject(text);
  if (!body || body.schemaVersion !== 1 || body.methodId !== target.methodId
    || body.version !== target.version || body.contentSha256 !== target.publishedHash
    || !isId(body.requestId) || !date(body.savedAt)) return false;
  const { origin, title, content, sources, relation } = body;
  if ((origin !== 'ir' && origin !== 'other') || !nonempty(title) || !obj(content)
    || Object.keys(content).length !== fields.length || !fields.every(key => typeof content[key] === 'string')
    || !fields.some(key => nonempty(content[key])) || !Array.isArray(sources)) return false;
  if (!sources.every(source => obj(source) && Object.keys(source).length === 5
    && typeof source.type === 'string' && ['session', 'memory', 'report', 'method', 'manual'].includes(source.type)
    && nonempty(source.label) && nonempty(source.ref) && (source.version === null || nonempty(source.version))
    && (source.sha256 === null || hash(source.sha256)))) return false;
  if (origin === 'ir' && !sources.some(source => source.type === 'session' && hash(source.sha256))) return false;
  if (relation !== null && (!obj(relation) || Object.keys(relation).length !== 3
    || typeof relation.kind !== 'string' || !['revision', 'derived', 'correction'].includes(relation.kind)
    || !obj(relation.target) || Object.keys(relation.target).length !== 2
    || !isId(relation.target.methodId) || !version(relation.target.version) || !nonempty(relation.reason))) return false;
  const computed = createHash('sha256').update(JSON.stringify({ origin, title, content, sources, relation })).digest('hex');
  return computed === target.publishedHash;
}

export function validateSapCandidate(value: unknown): asserts value is SapCandidate {
  if (!obj(value) || !isTarget(value.source) || !isTarget(value.isolated)
    || value.source.version !== value.isolated.version || value.source.publishedHash !== value.isolated.publishedHash
    || !bodyMatches(value.versionBody, value.source)) {
    throw new Error('SAP 候选来源版本、发布哈希、正文或隔离身份映射不一致');
  }
}

function finding(status: Finding['status'], reason: string, ...evidence: number[]): Finding {
  return { status, reason, evidence };
}

function containsMarker(value: unknown, markers: string[]): boolean {
  const pending = [value];
  const seen = new Set<object>();
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === 'string' && markers.some(marker => current.includes(marker))) return true;
    if (Array.isArray(current) || obj(current)) {
      if (seen.has(current)) continue;
      seen.add(current);
      for (const child of Object.values(current)) pending.push(child);
    }
  }
  return false;
}

function resultDetails(value: unknown): RecordValue | null {
  if (!obj(value) || value.isError === true) return null;
  const details = obj(value.details) ? value.details : value;
  if (value.role === 'toolResult') {
    const blocks = rows(value.content).filter(block => block.type === 'text');
    const visible = blocks.length === 1 ? parseObject(blocks[0].text) : null;
    if ((details.type === semanticResult || details.type === 'optracall.semantic-graph-result')
      && !isDeepStrictEqual(visible, details)) return null;
    if (value.toolName === 'read_sap_method_source' && obj(details.original)
      && (!visible || !isDeepStrictEqual(visible.readerMetadata, details.original)
        || !isDeepStrictEqual(parseObject(visible.material), details.original))) return null;
  }
  return details;
}

function rows(value: unknown): RecordValue[] {
  return Array.isArray(value) ? value.filter(obj) : [];
}

function fullBody(row: RecordValue): boolean {
  if (!nonempty(row.body)) return false;
  if (row.range == null) return true;
  return obj(row.range) && row.range.start === 0 && row.range.end === row.body.length && row.range.total === row.body.length;
}

function isOtherRead(call: RecordValue, tool: string, details: RecordValue, targets: SapTarget[]): boolean {
  if (tool === 'read_sap_method_source' && call.action === 'read-method' && obj(details.original)
    && details.original.type === semanticResult && details.original.action === 'read') {
    return rows(details.original.items).some(item => item.state === 'available' && fullBody(item)
      && targets.some(target => matchesVersion(item.target, target) && item.sha256 === target.publishedHash && bodyMatches(item.body, target)));
  }
  if (tool === semanticTool && call.action === 'trace' && details.type === semanticResult && details.action === 'trace') {
    return rows(details.items).some(item => item.state === 'available' && fullBody(item)
      && targets.some(target => matchesVersion(item.target, target) && item.sha256 === target.publishedHash && bodyMatches(item.body, target)));
  }
  if (tool === semanticTool && call.action === 'graph' && call.operation === 'source'
    && details.type === 'optracall.semantic-graph-result' && details.operation === 'source') {
    return rows(details.sources).some(item => item.sourceHandle === call.sourceHandle && fullBody(item)
      && targets.some(target => matchesVersion(item.ref, target) && bodyMatches(item.body, target)));
  }
  return false;
}

export function inspectSap(events: unknown[], candidate: SapCandidate): SapInspection {
  validateSapCandidate(candidate);
  const { source, isolated } = candidate;
  const title = parseObject(candidate.versionBody)!.title as string;
  const markers = [...new Set([source.methodId, isolated.methodId, source.publishedHash, title])];
  type EvidencePair = [number, number];
  const calls = new Map<string, { name: string; args: RecordValue; index: number; priorFind: EvidencePair | null }>();
  const repeatedIds = new Set<string>();
  const recordedCalls = new Set<string>();
  const recordedResults = new Set<string>();
  for (const event of events) {
    if (!obj(event) || !nonempty(event.callId)) continue;
    const seen = event.kind === 'tool_call' ? recordedCalls : event.kind === 'tool_result' ? recordedResults : null;
    if (!seen) continue;
    if (seen.has(event.callId)) repeatedIds.add(event.callId);
    seen.add(event.callId);
  }
  let latestFind: EvidencePair | null = null;
  let find = finding('UNKNOWN', '未证实正式目录命中目标版本');
  let read = finding('UNKNOWN', '未证实正式目录到正文的查读');
  let readIndex: number | null = null;
  let verifiedReadIndex: number | null = null;
  const targetExposureIndices: number[] = [];
  const otherReadIndices: number[] = [];
  for (const [index, event] of events.entries()) {
    if (!obj(event) || !nonempty(event.name) || !nonempty(event.callId)) continue;
    if (event.kind === 'tool_call') {
      if (containsMarker(event.args, markers)) targetExposureIndices.push(index);
      if (obj(event.args) && !repeatedIds.has(event.callId)) {
        calls.set(event.callId, { name: event.name, args: event.args, index, priorFind: latestFind });
      }
      continue;
    }
    if (event.kind !== 'tool_result') continue;
    if (containsMarker(event.result, markers)) targetExposureIndices.push(index);
    const call = calls.get(event.callId);
    if (!call || call.name !== event.name) continue;
    calls.delete(event.callId);
    const details = resultDetails(event.result);
    if (!details) {
      if (event.name === semanticTool && call.args.action === 'find' && find.evidence.length === 0) {
        find = finding('UNKNOWN', '目录调用失败或模型可见回执无法核验', call.index, index);
      } else if (event.name === semanticTool && call.args.action === 'read' && read.evidence.length === 0
        && containsMarker(call.args.target, markers)) {
        read = finding('UNKNOWN', '正文读取失败或模型可见回执无法核验', call.index, index);
      }
      continue;
    }
    if (isOtherRead(call.args, event.name, details, [isolated, source])) {
      otherReadIndices.push(index);
      continue;
    }
    if (event.name !== semanticTool || details.type !== semanticResult || details.schemaVersion !== 1
      || details.action !== call.args.action) continue;
    const items = [...rows(details.items), ...rows(details.unknownTime)];
    if (call.args.action === 'find') {
      const hit = items.find(item => item.state === 'available' && matchesTarget(item.target, isolated)
        && item.sha256 === isolated.publishedHash && item.body === null);
      if (hit) {
        latestFind = [call.index, index];
        if (find.status !== 'PASS') find = finding('PASS', '正式目录命中冻结的隔离方法版本', call.index, index);
      } else if (find.status === 'UNKNOWN') {
        const nearby = items.find(item => containsMarker([item.target, item.title, item.sha256], markers));
        if (nearby?.state === 'available' && isTarget(nearby.target) && hash(nearby.sha256) && nearby.body !== undefined) {
          find = finding('FAIL', '目录返回了目标相关条目，但身份或目录回执不符合冻结版本', call.index, index);
        } else {
          find = finding('UNKNOWN', '目录结果缺少冻结目标的完整命中证据', call.index, index);
        }
      }
    } else if (call.args.action === 'read') {
      const target = call.args.target;
      if (!matchesTarget(target, isolated)) {
        if (read.status === 'UNKNOWN' && containsMarker(target, markers)) {
          read = finding('FAIL', '正式读取未携带完整的隔离目标身份', call.index, index);
        }
        continue;
      }
      const item = items.find(row => matchesTarget(row.target, isolated) && row.state === 'available');
      if (!item || !fullBody(item) || !hash(item.sha256)) {
        if (read.status === 'UNKNOWN' && items.some(row => row.state === 'hash-conflict'
          || (row.state === 'available' && isTarget(row.target) && !matchesTarget(row.target, isolated)))) {
          read = finding('FAIL', '正式读取返回冲突或不同的版本身份', call.index, index);
        } else if (read.status === 'UNKNOWN') {
          read = finding('UNKNOWN', '正式读取缺少目标正文、完整范围或回执哈希', call.index, index);
        }
        continue;
      }
      if (item.sha256 !== isolated.publishedHash || !bodyMatches(item.body, isolated)) {
        if (read.status === 'UNKNOWN') read = finding('FAIL', '正式读取正文与冻结发布版本不符', call.index, index);
        continue;
      }
      verifiedReadIndex ??= index;
      const prior = call.priorFind;
      if (prior && readIndex === null) {
        readIndex = index;
        read = finding('PASS', '正式目录命中后核实了同一隔离版本的正文', ...prior, call.index, index);
      } else if (read.status === 'UNKNOWN' && readIndex === null) {
        read = finding('UNKNOWN', '正文已核实，读取调用前无正式目录命中证据', call.index, index);
      }
    }
  }
  return { find, read, readIndex, verifiedReadIndex, targetExposureIndices, otherReadIndices };
}

type NativeEvent =
  | { kind: 'tool_call'; callId: string; name: string; args: unknown; sourceLine: number }
  | { kind: 'tool_result'; callId: string; name: string; result: RecordValue; sourceLine: number };

export function decodePiBranch(jsonl: string, leafId: string): {
  sessionId: string;
  cwd: string;
  events: NativeEvent[];
  assistantText: string | null;
  assistantIdentity: { provider: string; model: string } | null;
} {
  if (!jsonl.endsWith('\n') || !nonempty(leafId)) throw new Error('Pi 证据需要完整 JSONL 和明确的分支叶节点');
  const lines = jsonl.slice(0, -1).split('\n');
  const header = parseObject(lines[0]);
  if (!header || header.type !== 'session' || header.version !== 3 || !nonempty(header.id)
    || !date(header.timestamp) || typeof header.cwd !== 'string') throw new Error('Pi 原生会话头无效');
  type BranchEntry = { parentId: string | null; message: RecordValue | null; sourceLine: number };
  const entries = new Map<string, BranchEntry>();
  for (let index = 1; index < lines.length; index++) {
    const record = parseObject(lines[index]);
    const sourceLine = index + 1;
    if (!record || !nonempty(record.type) || record.type === 'session' || !nonempty(record.id)
      || entries.has(record.id) || !date(record.timestamp)
      || (record.parentId !== null && (!nonempty(record.parentId) || !entries.has(record.parentId)))) {
      throw new Error(`Pi 原生记录第 ${sourceLine} 行存在无效身份、重复节点或断链`);
    }
    const message = record.type === 'message' ? record.message : null;
    if (record.type === 'message' && (!obj(message) || !nonempty(message.role)
      || (!Array.isArray(message.content) && typeof message.content !== 'string'))) {
      throw new Error(`Pi 原生消息第 ${sourceLine} 行无效`);
    }
    entries.set(record.id, { parentId: record.parentId, message: obj(message) ? message : null, sourceLine });
  }
  if (!entries.has(leafId)) throw new Error('Pi 原生会话未找到指定叶节点');
  const branch: BranchEntry[] = [];
  // Every parent precedes its child in the append-only file, so a cycle fails at parsing.
  for (let cursor: string | null = leafId; cursor !== null;) {
    const entry: BranchEntry = entries.get(cursor)!;
    branch.push(entry);
    cursor = entry.parentId;
  }
  const events: NativeEvent[] = [];
  const finalMessage = branch.find(entry => entry.message !== null)?.message;
  let assistantText: string | null = null;
  let assistantIdentity: { provider: string; model: string } | null = null;
  for (const { message, sourceLine } of branch.reverse()) {
    if (!message) continue;
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      const blocks = message.content.filter(obj);
      const calls = blocks.filter(part => part.type === 'toolCall');
      for (const call of calls) {
        if (!nonempty(call.id) || !nonempty(call.name)) throw new Error(`Pi 原生工具调用第 ${sourceLine} 行无效`);
        events.push({ kind: 'tool_call', callId: call.id, name: call.name, args: call.arguments, sourceLine });
      }
      if (message === finalMessage && calls.length === 0 && message.stopReason === 'stop') {
        const text = blocks.filter(part => part.type === 'text' && typeof part.text === 'string')
          .map(part => part.text).join('');
        if (nonempty(text)) {
          assistantText = text;
          if (nonempty(message.provider) && nonempty(message.model)) {
            assistantIdentity = { provider: message.provider, model: message.model };
          }
        }
      }
    } else if (message.role === 'toolResult') {
      if (!nonempty(message.toolCallId) || !nonempty(message.toolName)) throw new Error(`Pi 原生工具回执第 ${sourceLine} 行无效`);
      events.push({ kind: 'tool_result', callId: message.toolCallId, name: message.toolName, result: message, sourceLine });
    }
  }
  return { sessionId: header.id, cwd: header.cwd, events, assistantText, assistantIdentity };
}
