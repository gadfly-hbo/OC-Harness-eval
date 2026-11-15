import { canonical, digest } from './archive.ts';
import { scoreConversion, validateScenario } from './conversion.ts';
import type { Assertion, ConversionScenario } from './conversion.ts';
import { decodePiBranch, inspectSap, validateSapCandidate } from './sap.ts';
import type { SapCandidate, SapTarget } from './sap.ts';

export const sides = ['method', 'baseline', 'treatment'] as const;
export const surfaces = ['workspace', 'summary', 'memory', 'history', 'reference'] as const;

type Side = typeof sides[number];
type Status = Assertion['status'];
type Termination = 'COMPLETED' | 'TIMEOUT' | 'FAILED' | 'CANCELLED' | 'NOT_RUN' | 'INVALID_CAPTURE';
type Purpose = 'source-replay' | 'migration' | 'boundary';
type Gain = 'IMPROVED' | 'REGRESSED' | 'TIED' | 'UNKNOWN';

type Case = {
  id: string;
  family: string;
  purpose: Purpose;
  question: string;
  scenario: ConversionScenario;
  rubric: string;
};

export type Plan = {
  schemaVersion: 1;
  suite: { id: string; version: string };
  evidenceLevel: 'SYNTHETIC_REPLAY' | 'RECORDED_REPLAY';
  candidate: SapCandidate;
  reviewer: string;
  settings: {
    sdk: string;
    model: { provider: string; id: string; parameters: Record<string, unknown> };
    promptHash: string;
    contextHash: string;
    skills: { id: string; sha256: string }[];
    tools: { id: string; sha256: string }[];
    budgetMs: number;
  };
  cases: Case[];
};

const terminations = ['COMPLETED', 'TIMEOUT', 'FAILED', 'CANCELLED'];
const purposes = ['source-replay', 'migration', 'boundary'];
const hashPattern = /^[a-f0-9]{64}$/;
const idPattern = /^[a-z0-9][a-z0-9-]{0,79}$/;
const reviewStatuses = ['PASS', 'FAIL', 'UNKNOWN'];

function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function matches(pattern: RegExp, value: unknown): value is string {
  return typeof value === 'string' && pattern.test(value);
}

function oneOf(allowed: string[], value: unknown): value is string {
  return typeof value === 'string' && allowed.includes(value);
}

function identities(value: unknown): boolean {
  return Array.isArray(value) && value.every(item => {
    const entry = record(item);
    return nonempty(entry?.id) && matches(hashPattern, entry?.sha256);
  }) && new Set(value.map(item => item.id)).size === value.length;
}

export function taskInput(item: Case) {
  return { caseId: item.id, question: item.question, scenario: item.scenario };
}

export function fingerprint(value: unknown) {
  return digest(canonical(value));
}

export function captureName(id: string, side: Side) {
  return `${id}.${side}.json`;
}

function comparable(scenario: ConversionScenario): boolean {
  const channels = new Set(scenario.rows.map(row => row.channel));
  return ['before', 'after'].every(period => [...channels].every(channel =>
    scenario.rows.some(row => row.channel === channel && row.period === period &&
      (row[scenario.metric] ?? 0) > 0),
  ));
}

export function validatePlan(value: unknown): asserts value is Plan {
  const plan = record(value);
  const suite = record(plan?.suite);
  const settings = record(plan?.settings);
  const model = record(settings?.model);
  if (plan?.schemaVersion !== 1 || !matches(idPattern, suite?.id) ||
      !nonempty(suite?.version) || !nonempty(plan.reviewer) ||
      (plan.evidenceLevel !== 'SYNTHETIC_REPLAY' && plan.evidenceLevel !== 'RECORDED_REPLAY')) {
    throw new Error('Invalid plan identity, schema, reviewer or evidence level');
  }
  if (!nonempty(settings?.sdk) || !nonempty(model?.provider) || !nonempty(model?.id) ||
      !record(model?.parameters) || !matches(hashPattern, settings?.promptHash) ||
      !matches(hashPattern, settings?.contextHash) || !identities(settings?.skills) ||
      !identities(settings?.tools) || !Number.isSafeInteger(settings?.budgetMs) ||
      Number(settings?.budgetMs) <= 0) {
    throw new Error('Invalid fixed execution settings');
  }
  validateSapCandidate(plan.candidate);
  if (!Array.isArray(plan.cases) || plan.cases.length === 0) throw new Error('Empty suite');
  const seen = new Set<string>();
  for (const value of plan.cases) {
    const item = record(value);
    if (!matches(idPattern, item?.id) || seen.has(item.id) ||
        !matches(idPattern, item.family) || !oneOf(purposes, item.purpose) ||
        !nonempty(item.question) || !nonempty(item.rubric)) {
      throw new Error('Invalid or duplicate case metadata');
    }
    validateScenario(item.scenario);
    if ((item.purpose === 'boundary') === comparable(item.scenario)) {
      throw new Error(`Case purpose does not match the comparable inputs: ${item.id}`);
    }
    seen.add(item.id);
  }
}

function sameTarget(value: unknown, target: SapTarget): boolean {
  const ref = record(value);
  return ref?.kind === target.kind && ref.methodId === target.methodId &&
    ref.version === target.version && ref.publishedHash === target.publishedHash;
}

function aggregate(items: Status[]): Status {
  if (items.includes('FAIL')) return 'FAIL';
  return items.length > 0 && items.every(item => item === 'PASS') ? 'PASS' : 'UNKNOWN';
}

function reviewOutput(plan: Plan, item: Case, output: unknown,
  review: Record<string, unknown> | undefined): Assertion {
  const report = record(output)?.report;
  if (!nonempty(report) || review?.reviewer !== plan.reviewer ||
      review.outputHash !== fingerprint(output) || review.rubricHash !== fingerprint(item.rubric) ||
      !nonempty(review.reason) ||
      !oneOf(reviewStatuses, review.status)) {
    return { id: 'report-review', status: 'UNKNOWN', reason: '缺少与输出绑定的独立评阅' };
  }
  return { id: 'report-review', status: review.status as Status, reason: review.reason };
}

function isolationIssues(plan: Plan, item: Case, side: Side, input: Record<string, unknown>) {
  const issues: string[] = [];
  if (input.taskHash !== fingerprint(taskInput(item))) issues.push('TASK_HASH_MISMATCH');
  if (input.settingsHash !== fingerprint(plan.settings)) issues.push('SETTINGS_HASH_MISMATCH');
  if (!nonempty(input.sessionId) || !nonempty(input.workspaceId)) issues.push('MISSING_EXECUTION_ID');
  const isolation = record(input.isolation);
  const checks = record(isolation?.checks);
  if (isolation?.freshSession !== true) issues.push('FRESH_SESSION_UNVERIFIED');
  for (const surface of surfaces) {
    const check = record(checks?.[surface]);
    if (check?.state === 'leak') issues.push(`LEAK_${surface.toUpperCase()}`);
    else if (check?.state !== 'clean' || !nonempty(check.evidence)) {
      issues.push(`UNVERIFIED_${surface.toUpperCase()}`);
    }
  }
  if (side === 'method') {
    if (!sameTarget(input.methodSubject, plan.candidate.source)) issues.push('METHOD_SUBJECT_MISMATCH');
  } else if (side === 'baseline' ? isolation?.catalogTarget !== null
    : !sameTarget(isolation?.catalogTarget, plan.candidate.isolated)) {
    issues.push('CATALOG_TARGET_MISMATCH');
  }
  return issues;
}

function assessReuse(
  events: unknown[],
  sap: ReturnType<typeof inspectSap>,
  review: Record<string, unknown> | undefined,
  analysis: unknown,
  business: Status,
  isComparable: boolean,
  trustedReview: boolean,
) {
  const unknown = (reason: string) => ({ status: 'UNKNOWN' as Status, stage: null, reason, evidence: [] as number[] });
  if (sap.readIndex === null) return unknown('正式查读未得到完整验证');
  const adoption = record(review?.adoption);
  if (!trustedReview || !adoption || !nonempty(adoption.reason) ||
      !oneOf(reviewStatuses, adoption.status)) return unknown('缺少独立采用证据');
  const { stage, disposition, eventIndex } = adoption;
  if (typeof eventIndex !== 'number' || !Number.isSafeInteger(eventIndex) ||
      eventIndex < 0 || eventIndex >= events.length) return unknown('采用事件不可定位');
  const event = record(events[eventIndex]);
  if (!event || adoption.eventHash !== fingerprint(event)) return unknown('评阅与采用证据未绑定');
  if (eventIndex <= sap.readIndex) return unknown('所引用动作先于目标版本的正式读取');
  if (!oneOf(['initial', 'recheck', 'report', 'boundary'], stage) ||
      !oneOf(['adopted', 'adapted', 'combined', 'partial', 'rejected'], disposition)) {
    return unknown('采用阶段或方式未确定');
  }
  if (stage === 'initial' && events.slice(0, eventIndex).some(entry => record(entry)?.kind === 'calculation')) {
    return unknown('所引用初算之前已有计算证据');
  }
  let proof = event;
  if (event.kind === 'tool_result') {
    const sameCall = events.filter(entry => record(entry)?.callId === event.callId);
    const call = record(sameCall[0]);
    const native = record(event.result);
    const details = record(native?.details);
    if (event.name === 'read_semantic_context' || !nonempty(event.callId) ||
        sameCall.length !== 2 || call?.kind !== 'tool_call' || call.name !== event.name ||
        !record(call.args) || adoption.callHash !== fingerprint(call) ||
        events.indexOf(sameCall[0]) <= sap.readIndex || native?.isError !== false ||
        details?.type !== 'ir-eval.analysis-proof') {
      return unknown('原生回执没有与读取后实际调用绑定的分析证据');
    }
    if (stage === 'initial' && events.slice(0, events.indexOf(sameCall[0])).some(entry => {
      const earlier = record(entry);
      return earlier?.kind === 'tool_call' && earlier.name !== 'read_semantic_context';
    })) return unknown('原生轨迹有更早的工具调用，初算时序未证实');
    proof = details;
  }
  const expectedKind = stage === 'report' ? 'report_basis' :
    stage === 'boundary' ? 'boundary_decision' : 'calculation';
  if (proof.kind !== expectedKind || (expectedKind === 'calculation' && proof.phase !== stage)) {
    return unknown('采用阶段与证据事件不一致');
  }
  if (analysis == null || proof.analysis == null || fingerprint(proof.analysis) !== fingerprint(analysis)) {
    return unknown('采用事件未保留与报告一致的实际分析');
  }
  const expectedUse = isComparable
    ? disposition !== 'rejected' && stage !== 'boundary'
    : disposition === 'rejected' && stage === 'boundary';
  const status: Status = !expectedUse || business === 'FAIL' || adoption.status === 'FAIL'
    ? 'FAIL' : aggregate([business, adoption.status as Status]);
  return { status, stage: String(stage), disposition: String(disposition), reason: adoption.reason,
    evidence: [sap.readIndex, eventIndex] };
}

function scoreAttempt(plan: Plan, item: Case, side: Side, raw: Buffer | undefined) {
  const file = captureName(item.id, side);
  const isComparable = comparable(item.scenario);
  const empty = (termination: Termination, reason: string) => ({
    termination, reason, evidence: raw ? `raw/${file}` : null,
    sessionId: null as string | null, workspaceId: null as string | null,
    issues: [] as string[], assertions: [] as Assertion[], usage: null as unknown,
    completionEvidence: 'UNVERIFIED' as 'UNVERIFIED' | 'SYNTHETIC' | 'NATIVE_STOP' | 'REVIEW_RECORD',
    task: 'UNKNOWN' as Status, businessAnswer: 'UNKNOWN' as Status, applicability: 'UNKNOWN' as Status,
    sap: null as ReturnType<typeof inspectSap> | null,
    nativeEventLines: null as (number | null)[] | null,
    skills: null as unknown,
    reuse: { status: 'UNKNOWN' as Status, stage: null as string | null, reason, evidence: [] as number[] },
  });
  if (!raw) return empty('NOT_RUN', '未找到计划项的原始档案');
  let input: Record<string, unknown> | undefined;
  try {
    input = record(JSON.parse(raw.toString('utf8'), (_key, value: unknown) => {
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Non-finite number');
      return value;
    }));
  } catch {
    return empty('INVALID_CAPTURE', '原始档案不是有效且可表示的 JSON');
  }
  if (!input || input.schemaVersion !== 1 || input.caseId !== item.id || input.side !== side ||
      !oneOf(terminations, input.termination)) {
    return empty('INVALID_CAPTURE', '档案身份或终态不符合运行矩阵');
  }
  const termination = input.termination as Termination;
  const result = empty(termination, nonempty(input.reason) ? input.reason : termination);
  result.sessionId = nonempty(input.sessionId) ? input.sessionId : null;
  result.workspaceId = nonempty(input.workspaceId) ? input.workspaceId : null;
  result.issues = isolationIssues(plan, item, side, input);
  result.usage = input.usage ?? null;
  result.skills = input.skills ?? null;
  let events: unknown[] = [];
  let assistantText: string | null = null;
  if (plan.evidenceLevel === 'RECORDED_REPLAY' && side !== 'method') {
    const native = record(input.native);
    try {
      if (!nonempty(native?.jsonl) || !nonempty(native.leafId)) throw new Error();
      const branch = decodePiBranch(native.jsonl, native.leafId);
      events = branch.events;
      result.nativeEventLines = events.map(event => {
        const line = record(event)?.sourceLine;
        return typeof line === 'number' ? line : null;
      });
      assistantText = branch.assistantText;
      if (branch.sessionId !== result.sessionId) result.issues.push('NATIVE_SESSION_ID_MISMATCH');
      if (termination === 'COMPLETED' && (!branch.assistantIdentity ||
          branch.assistantIdentity.provider !== plan.settings.model.provider ||
          branch.assistantIdentity.model !== plan.settings.model.id)) {
        result.issues.push('NATIVE_MODEL_ID_UNVERIFIED');
      }
    } catch {
      result.issues.push('NATIVE_BRANCH_UNVERIFIED');
    }
  } else if (Array.isArray(input.events)) {
    events = input.events;
  } else if (side !== 'method') {
    result.issues.push('EVENTS_UNVERIFIED');
  }
  if (side !== 'method') result.sap = inspectSap(events, plan.candidate);
  if (side === 'baseline' && result.sap?.targetExposureIndices.length) {
    result.issues.push('BASELINE_TARGET_EXPOSURE');
  }
  if (termination !== 'COMPLETED') return result;
  const output = record(input.output);
  const review = record(input.review);
  const report = reviewOutput(plan, item, output, review);
  if (plan.evidenceLevel === 'RECORDED_REPLAY' && side !== 'method' &&
      (!assistantText || assistantText !== output?.report)) {
    result.issues.push('NATIVE_REPORT_UNVERIFIED');
    result.assertions = [{ id: 'report-review', status: 'UNKNOWN', reason: '报告与原生最终消息未核验' }];
    return result;
  }
  result.completionEvidence = plan.evidenceLevel === 'SYNTHETIC_REPLAY'
    ? 'SYNTHETIC' : side === 'method' ? 'REVIEW_RECORD' : 'NATIVE_STOP';
  result.assertions = [...scoreConversion(item.scenario, output?.analysis), report];
  if (side === 'method' && item.purpose === 'source-replay') {
    const fidelity = review?.fidelity;
    result.assertions.push({
      id: 'source-fidelity',
      status: report.status === 'UNKNOWN' || !oneOf(reviewStatuses, fidelity)
        ? 'UNKNOWN' : fidelity as Status,
      reason: '独立评阅检查推演与源场景的忠实性',
    });
  }
  result.applicability = result.assertions.find(entry => entry.id === 'applicability')?.status ?? 'UNKNOWN';
  if (!isComparable) result.applicability = aggregate([result.applicability, report.status]);
  result.task = aggregate(result.assertions.map(assertion => assertion.status));
  result.businessAnswer = isComparable ? result.task : 'UNKNOWN';
  if (side === 'treatment' && result.sap) {
    try {
      result.reuse = assessReuse(events, result.sap, review, output?.analysis, result.task, isComparable,
        report.status !== 'UNKNOWN');
    } catch {
      result.reuse = { ...result.reuse, reason: '采用证据无法计算稳定指纹' };
    }
    if (result.issues.length && result.reuse.status !== 'UNKNOWN') {
      result.reuse = { ...result.reuse, status: 'UNKNOWN', reason: '执行身份或隔离证据未通过' };
    }
  }
  return result;
}

export function evaluate(plan: Plan, captures: Map<string, Buffer>) {
  const attempts = plan.cases.map(item => ({
    item,
    method: scoreAttempt(plan, item, 'method', captures.get(captureName(item.id, 'method'))),
    baseline: scoreAttempt(plan, item, 'baseline', captures.get(captureName(item.id, 'baseline'))),
    treatment: scoreAttempt(plan, item, 'treatment', captures.get(captureName(item.id, 'treatment'))),
  }));
  for (const field of ['sessionId', 'workspaceId'] as const) {
    const uses = new Map<string, ReturnType<typeof scoreAttempt>[]>();
    for (const entry of attempts) {
      for (const side of sides) {
        const attempt = entry[side];
        const id = attempt[field];
        if (!id) continue;
        if (!uses.has(id)) uses.set(id, []);
        uses.get(id)!.push(attempt);
      }
    }
    for (const group of uses.values()) {
      if (group.length < 2) continue;
      for (const attempt of group) {
        attempt.issues.push(field === 'sessionId' ? 'REUSED_SESSION' : 'REUSED_WORKSPACE');
        if (attempt.reuse.status !== 'UNKNOWN') {
          attempt.reuse = { ...attempt.reuse, status: 'UNKNOWN', reason: '执行身份在矩阵中重复' };
        }
      }
    }
  }
  const caseResults = attempts.map(({ item, method, baseline, treatment }) => {
    const pairIssues = [...baseline.issues.map(issue => `baseline:${issue}`),
      ...treatment.issues.map(issue => `treatment:${issue}`)];
    if (plan.evidenceLevel === 'RECORDED_REPLAY') {
      pairIssues.push('HOST_ISOLATION_NOT_INDEPENDENTLY_VERIFIED');
    }
    let gain: Gain = 'UNKNOWN';
    let delta: number | null = null;
    if (!pairIssues.length && baseline.task !== 'UNKNOWN' && treatment.task !== 'UNKNOWN') {
      delta = Number(treatment.task === 'PASS') - Number(baseline.task === 'PASS');
      gain = delta > 0 ? 'IMPROVED' : delta < 0 ? 'REGRESSED' : 'TIED';
    }
    return { id: item.id, family: item.family, purpose: item.purpose, method, baseline, treatment,
      pairIssues, gain, delta };
  });
  const planned = new Set(plan.cases.flatMap(item => sides.map(side => captureName(item.id, side))));
  const count = (side: Side) => {
    const counts: Record<Termination, number> = {
      COMPLETED: 0, TIMEOUT: 0, FAILED: 0, CANCELLED: 0, NOT_RUN: 0, INVALID_CAPTURE: 0,
    };
    for (const item of caseResults) counts[item[side].termination]++;
    return counts;
  };
  const families = new Map<string, (number | null)[]>();
  for (const item of caseResults) {
    if (!families.has(item.family)) families.set(item.family, []);
    families.get(item.family)!.push(item.delta);
  }
  const completeFamilies = [...families.values()].filter((group): group is number[] =>
    group.every(delta => delta !== null));
  const means = completeFamilies.map(group => group.reduce((sum, value) => sum + value, 0) / group.length);
  const gate = (item: typeof caseResults[number], field: 'businessAnswer' | 'applicability') =>
    item.method.issues.length ? 'UNKNOWN' : item.method[field];
  const source = caseResults.filter(item => item.purpose === 'source-replay');
  const migration = caseResults.filter(item => item.purpose === 'migration');
  const boundary = caseResults.filter(item => item.purpose === 'boundary');
  return {
    evidenceLevel: plan.evidenceLevel,
    method: {
      correctness: aggregate([aggregate(source.map(item => gate(item, 'businessAnswer'))),
        aggregate(migration.map(item => gate(item, 'businessAnswer')))]),
      applicability: aggregate([aggregate(boundary.map(item => gate(item, 'applicability'))),
        aggregate([...source, ...migration].map(item => gate(item, 'applicability')))]),
      sourceCases: source.length, migrationCases: migration.length, boundaryCases: boundary.length,
    },
    gain: {
      status: means.length === families.size ? 'COMPLETE' : 'UNKNOWN',
      plannedPairs: caseResults.length,
      comparablePairs: caseResults.filter(item => item.delta !== null).length,
      plannedFamilies: families.size,
      comparableFamilies: means.length,
      observedDelta: means.length ? means.reduce((sum, value) => sum + value, 0) / means.length : null,
    },
    terminations: { method: count('method'), baseline: count('baseline'), treatment: count('treatment') },
    unplannedFiles: [...captures.keys()].filter(file => !planned.has(file)).sort(),
    cases: caseResults,
  };
}

export type Evaluation = ReturnType<typeof evaluate>;
