import { digest } from './archive.ts';
import type { ConversionScenario } from './conversion.ts';
import { captureName, fingerprint, sides, surfaces, taskInput } from './evaluate.ts';
import type { Plan } from './evaluate.ts';

type Case = Plan['cases'][number];
type Row = ConversionScenario['rows'][number];
type Decomposition = {
  decision: 'decompose';
  metric: ConversionScenario['metric'];
  operands: { period: Row['period']; channel: string; conversions: number; denominator: number }[];
  rates: { unit: '%'; before: number; after: number; intermediate: number };
  effects: { unit: 'pp'; total: number; mix: number; rate: number };
};
type Stop = { decision: 'stop'; missing: { period: Row['period']; channel: string; field: 'sessions' }[] };
type Output = { analysis: Decomposition | Stop; report: string };

const rubrics = {
  common: '解释两期统一口径、后期权重乘以前期渠道率的反事实及两个分解项的方向。数字对应实际计数，分解为描述性归因。',
  mixed: '解释按访客统一两期，不能混用后期会话作为权重，也不能推断两期会话口径的真实方向。',
  boundary: '明确指出两条基期会话数缺口，说明访客数不能替代会话数，停止两期会话口径比较及归因。',
};

const source: Case = {
  id: 'source-same-basis', family: 'original-channel-task', purpose: 'source-replay',
  question: '两期访客转化率为什么变了？', rubric: rubrics.common,
  scenario: { metric: 'visitors', rows: [
    { period: 'before', channel: 'A', conversions: 180, visitors: 6000 },
    { period: 'before', channel: 'B', conversions: 320, visitors: 4000 },
    { period: 'after', channel: 'A', conversions: 320, visitors: 8000 },
    { period: 'after', channel: 'B', conversions: 130, visitors: 2000 },
  ] },
};

const unified: Case = {
  id: 'unified-visitors', family: source.family, purpose: 'source-replay',
  question: '两期访客转化率为什么变了？后期新增了会话字段。',
  rubric: `${rubrics.common} ${rubrics.mixed}`,
  scenario: { metric: 'visitors', rows: [
    ...source.scenario.rows.slice(0, 2),
    { period: 'after', channel: 'A', conversions: 300, visitors: 6000, sessions: 6500 },
    { period: 'after', channel: 'B', conversions: 150, visitors: 1500, sessions: 3500 },
  ] },
};

const missing: Case = {
  id: 'missing-sessions', family: 'missing-session-inputs', purpose: 'boundary',
  question: '比较两期会话转化率并分析变化原因。', rubric: rubrics.boundary,
  scenario: { metric: 'sessions', rows: [
    { period: 'before', channel: 'search', conversions: 72, visitors: 1200 },
    { period: 'before', channel: 'social', conversions: 32, visitors: 800 },
    { period: 'after', channel: 'search', conversions: 78, visitors: 1400, sessions: 1750 },
    { period: 'after', channel: 'social', conversions: 41, visitors: 600, sessions: 660 },
  ] },
};

const migration: Case = {
  id: 'migration-session-mix', family: 'stable-session-conversion', purpose: 'migration',
  question: '两期会话转化率看起来一样。拆解渠道组合及渠道内表现有何变化？', rubric: rubrics.common,
  scenario: { metric: 'sessions', rows: [
    { period: 'before', channel: 'paid', conversions: 120, sessions: 4000 },
    { period: 'before', channel: 'direct', conversions: 180, sessions: 2000 },
    { period: 'after', channel: 'paid', conversions: 75, sessions: 3000 },
    { period: 'after', channel: 'direct', conversions: 225, sessions: 3000 },
  ] },
};

function decomposition(
  item: Case,
  rates: Omit<Decomposition['rates'], 'unit'>,
  effects: Omit<Decomposition['effects'], 'unit'>,
): Decomposition {
  const { metric, rows } = item.scenario;
  return {
    decision: 'decompose', metric,
    operands: rows.map(({ period, channel, conversions, [metric]: denominator }) => {
      if (!denominator) throw new Error(`Demo decomposition lacks a denominator: ${item.id}/${period}/${channel}`);
      return { period, channel, conversions, denominator };
    }),
    rates: { unit: '%', ...rates }, effects: { unit: 'pp', ...effects },
  };
}

const referenceOutputs: Record<string, Output> = {
  [source.id]: {
    analysis: decomposition(source, { before: 5, after: 4.5, intermediate: 4 }, { total: -0.5, mix: -1, rate: 0.5 }),
    report: '两期均按访客计算，整体从 5.00% 降至 4.50%。后期 A/B 访客权重为 80%/20%，与基期渠道率 3.00%/8.00% 加权得到 4.00%。渠道结构变化对应 −1.00 个百分点，渠道内转化率变化对应 +0.50 个百分点，合计 −0.50 个百分点。',
  },
  [unified.id]: {
    analysis: decomposition(unified, { before: 5, after: 6, intermediate: 4 }, { total: 1, mix: -1, rate: 2 }),
    report: '按访客统一两期，整体从 5.00% 升至 6.00%。后期 A/B 访客为 6,000/1,500，得到 80%/20% 权重；与基期渠道率 3.00%/8.00% 加权得到 4.00%。渠道结构变化对应 −1.00 个百分点，渠道内变化对应 +2.00 个百分点，合计 +1.00 个百分点。缺少基期会话数，无法判断会话口径的两期变化方向。',
  },
  [missing.id]: {
    analysis: { decision: 'stop', missing: [
      { period: 'before', channel: 'search', field: 'sessions' },
      { period: 'before', channel: 'social', field: 'sessions' },
    ] },
    report: '搜索和社交渠道均缺少基期会话数。访客数不能替代会话数，无法比较两期会话转化率或判断变化方向。补齐两渠道基期会话数并核实口径后才能做分解。',
  },
  [migration.id]: {
    analysis: decomposition(migration, { before: 5, after: 5, intermediate: 6 }, { total: 0, mix: 1, rate: -1 }),
    report: '按会话计算，两期整体均为 5.00%。后期 paid/direct 会话权重均为 50%，与基期渠道率 3.00%/9.00% 加权得到 6.00%。结构变化对应 +1.00 个百分点，渠道内变化对应 −1.00 个百分点，两项抵消。',
  },
};

const wrongBaseline: Output = {
  analysis: {
    decision: 'decompose', metric: 'visitors',
    operands: [
      { period: 'before', channel: 'A', conversions: 180, denominator: 6000 },
      { period: 'before', channel: 'B', conversions: 320, denominator: 4000 },
      { period: 'after', channel: 'A', conversions: 300, denominator: 6500 },
      { period: 'after', channel: 'B', conversions: 150, denominator: 3500 },
    ],
    rates: { unit: '%', before: 5, after: 6, intermediate: 4.75 },
    effects: { unit: 'pp', total: 1, mix: -0.25, rate: 1.25 },
  },
  report: '两期访客转化率从 5.00% 升至 6.00%。后期按 A/B 会话数 6,500/3,500 取权重，与基期访客渠道率加权得到 4.75%。结构和渠道内变化分别为 −0.25 和 +1.25 个百分点，合计 +1.00 个百分点。',
};

const definition = {
  origin: 'ir', title: '渠道转化率变动拆解（离线合成替身）',
  content: {
    conditions: '适用于两期渠道覆盖可核对、转化定义相同且存在统一分母的比较。',
    logic: '用同一分母计算两期总体率，以后期渠道权重乘以前期各渠道率，得到反事实中间率。',
    judgment: '中间率减基期率为结构项，后期率减中间率为渠道内项。以百分点核对两项和总变化。',
    limits: '不能混用访客和会话。缺必要分母或对照渠道行时停止归因，明确缺口。统计拆解不证明因果。',
  },
  sources: [{
    type: 'session', label: '合成源任务回放', ref: 'fixture://source-same-basis', version: null,
    sha256: fingerprint({ input: taskInput(source), output: referenceOutputs[source.id] }),
  }],
  relation: null,
};

const target = {
  kind: 'sap-method' as const, methodId: '5af6fc40-df2b-487c-9b14-bfcd580ae6c3', version: 1,
  publishedHash: digest(JSON.stringify(definition)),
};

const versionBody = {
  schemaVersion: 1, methodId: target.methodId, version: target.version, ...definition,
  contentSha256: target.publishedHash, requestId: 'd9879a65-5981-43ce-8986-2bc485314e66',
  savedAt: '2026-11-10T00:00:00.000Z',
};

export const demoPlan: Plan = {
  schemaVersion: 1,
  suite: { id: 'channel-conversion-offline', version: '1.0.0' },
  evidenceLevel: 'SYNTHETIC_REPLAY',
  candidate: {
    source: target, isolated: { ...target, methodId: 'c8046843-20ea-4cf0-abfa-c2f05049f6bd' },
    versionBody: JSON.stringify(versionBody),
  },
  reviewer: 'synthetic-reference-review-v1',
  settings: {
    sdk: 'offline-replay-no-sdk',
    model: { provider: 'offline-fixture', id: 'deterministic-captures-v1', parameters: {} },
    promptHash: digest('使用同一业务口径分析任务。结合授权材料并明确局限。'),
    contextHash: fingerprint({ memory: [], history: [], summary: '' }),
    skills: [{ id: 'data-analysis-demo', sha256: digest('synthetic data analysis skill identity v1') }],
    tools: [
      { id: 'read_semantic_context', sha256: digest('synthetic SAP catalog capture contract v1') },
      { id: 'calculation-demo', sha256: digest('synthetic calculation capture contract v1') },
    ],
    budgetMs: 360_000,
  },
  cases: [source, unified, missing, migration],
};

const demoPlanHash = fingerprint(demoPlan);

function sapEvents(plan: Plan, includeTarget: boolean): Record<string, unknown>[] {
  const { isolated } = plan.candidate;
  const name = 'read_semantic_context';
  const item = { target: isolated, state: 'available', sha256: isolated.publishedHash, title: definition.title };
  const call = (action: 'find' | 'read', args: Record<string, unknown>) => ({
    kind: 'tool_call', name, callId: action, args: { action, ...args },
  });
  const result = (action: 'find' | 'read', items: unknown[]) => ({
    kind: 'tool_result', name, callId: action,
    result: { isError: false, details: { type: 'optracall.semantic-context-result', schemaVersion: 1, action,
      state: items.length ? 'available' : 'empty', items } },
  });
  const events = [
    call('find', { kinds: ['sap-method'], query: '转化率' }),
    result('find', includeTarget ? [{ ...item, body: null }] : []),
  ];
  if (includeTarget) {
    const body = JSON.stringify({ ...versionBody, methodId: isolated.methodId });
    events.push(call('read', { target: isolated }), result('read', [{ ...item, body }]));
  }
  return events;
}

export function demoCaptures(plan: Plan): Map<string, Buffer> {
  if (fingerprint(plan) !== demoPlanHash) throw new Error('Demo captures require the unchanged synthetic demo plan');
  const captures = new Map<string, Buffer>();
  const settingsHash = fingerprint(plan.settings);
  for (const item of plan.cases) {
    for (const side of sides) {
      const id = `${item.id}-${side}`;
      const wrong = item.id === unified.id && side === 'baseline';
      const output = wrong ? wrongBaseline : referenceOutputs[item.id];
      const lateRead = item.id === migration.id && side === 'treatment';
      const stage = output.analysis.decision === 'stop' ? 'boundary' : lateRead ? 'recheck' : 'initial';
      const events = side === 'method' ? [] : sapEvents(plan, side === 'treatment');
      if (lateRead) events.unshift({ kind: 'calculation', phase: 'initial', analysis: output.analysis });
      const event = stage === 'boundary'
        ? { kind: 'boundary_decision', analysis: output.analysis }
        : { kind: 'calculation', phase: stage, analysis: output.analysis };
      const eventIndex = events.push(event) - 1;
      const capture = {
        schemaVersion: 1, caseId: item.id, side, termination: 'COMPLETED', reason: '合成回放记录为自然完成',
        sessionId: `demo-session-${id}`, workspaceId: `demo-workspace-${id}`,
        taskHash: fingerprint(taskInput(item)), settingsHash,
        ...(side === 'method' ? { methodSubject: plan.candidate.source } : {}),
        isolation: {
          freshSession: true,
          catalogTarget: side === 'treatment' ? plan.candidate.isolated : null,
          checks: Object.fromEntries(surfaces.map(surface => [surface, {
            state: 'clean', evidence: `fixture://${id}/isolation/${surface}`,
          }])),
        },
        skills: { visible: ['data-analysis-demo'], read: [], executed: [] },
        usage: null,
        output, events,
        review: {
          reviewer: plan.reviewer, outputHash: fingerprint(output), rubricHash: fingerprint(item.rubric),
          status: wrong ? 'FAIL' : 'PASS',
          reason: wrong ? '报告以会话权重解释访客转化率，口径混用。' : '合成评阅核对报告与固定口径、输入缺口或推演结论一致。',
          ...(side === 'method' && item.purpose === 'source-replay' ? { fidelity: 'PASS' } : {}),
          ...(side === 'treatment' ? { adoption: {
            status: 'PASS', stage, eventIndex, eventHash: fingerprint(event),
            disposition: stage === 'boundary' ? 'rejected' : 'adopted',
            reason: stage === 'recheck' ? '读取后用相同口径复核原计算。'
              : stage === 'boundary' ? '读取后按方法边界停止归因。' : '读取后按方法计算结构项与渠道内项。',
          } } : {}),
        },
      };
      captures.set(captureName(item.id, side), Buffer.from(`${JSON.stringify(capture, null, 2)}\n`));
    }
  }
  return captures;
}
