import assert from 'node:assert/strict';
import test from 'node:test';
import { scoreConversion, validateScenario } from '../src/conversion.ts';
import type { ConversionScenario } from '../src/conversion.ts';

const bPrime: ConversionScenario = {
  metric: 'visitors',
  rows: [
    { period: 'before', channel: 'A', conversions: 180, visitors: 6000 },
    { period: 'before', channel: 'B', conversions: 320, visitors: 4000 },
    { period: 'after', channel: 'A', conversions: 300, visitors: 6000, sessions: 6500 },
    { period: 'after', channel: 'B', conversions: 150, visitors: 1500, sessions: 3500 },
  ],
};

const correct = {
  decision: 'decompose',
  metric: 'visitors',
  operands: [
    { period: 'before', channel: 'A', conversions: 180, denominator: 6000 },
    { period: 'before', channel: 'B', conversions: 320, denominator: 4000 },
    { period: 'after', channel: 'A', conversions: 300, denominator: 6000 },
    { period: 'after', channel: 'B', conversions: 150, denominator: 1500 },
  ],
  rates: { unit: '%', before: 5, after: 6, intermediate: 4 },
  effects: { unit: 'pp', total: 1, mix: -1, rate: 2 },
};

test('访客口径的正确分解通过所有关键断言', () => {
  const results = scoreConversion(bPrime, correct);
  assert.ok(results.length > 0);
  assert.deepEqual(results.filter(({ status }) => status !== 'PASS'), []);
});

const sessionScenario: ConversionScenario = { ...bPrime, metric: 'sessions' };
const stop = {
  decision: 'stop',
  missing: [
    { period: 'before', channel: 'A', field: 'sessions' },
    { period: 'before', channel: 'B', field: 'sessions' },
  ],
};

test('缺基期会话数时能说明具体缺口，并停止归因', () => {
  assert.deepEqual(scoreConversion(sessionScenario, stop).map(({ id, status }) => [id, status]), [
    ['applicability', 'PASS'],
  ]);
});

function statuses(scenario: ConversionScenario, outcome: unknown) {
  return Object.fromEntries(scoreConversion(scenario, outcome).map(({ id, status }) => [id, status]));
}

test('错用会话数作为访客权重，即使闭合到 +1.00 个百分点也失败', () => {
  const incorrect = {
    ...correct,
    operands: [
      ...correct.operands.slice(0, 2),
      { ...correct.operands[2], denominator: 6500 },
      { ...correct.operands[3], denominator: 3500 },
    ],
    rates: { unit: '%', before: 5, after: 6, intermediate: 4.75 },
    effects: { unit: 'pp', total: 1, mix: -0.25, rate: 1.25 },
  };
  assert.deepEqual(statuses(bPrime, incorrect), {
    applicability: 'PASS',
    metric: 'PASS',
    operands: 'FAIL',
    rates: 'FAIL',
    effects: 'FAIL',
    closure: 'PASS',
  });
});

test('比例与百分率、百分点是等价数值表示', () => {
  const ratio = {
    ...correct,
    rates: { unit: 'ratio', before: 0.05, after: 0.06, intermediate: 0.04 },
    effects: { unit: 'ratio', total: 0.01, mix: -0.01, rate: 0.02 },
  };
  assert.ok(scoreConversion(bPrime, ratio).every(({ status }) => status === 'PASS'));
});

test('分解项把百分率误标为百分点单位失败', () => {
  const wrongUnit = { ...correct, effects: { ...correct.effects, unit: '%' } };
  assert.equal(statuses(bPrime, wrongUnit).effects, 'FAIL');
});

test('显式错误的分解项符号导致分解项及闭合失败', () => {
  const wrongSign = { ...correct, effects: { ...correct.effects, mix: 1 } };
  assert.equal(statuses(bPrime, wrongSign).effects, 'FAIL');
  assert.equal(statuses(bPrime, wrongSign).closure, 'FAIL');
});

test('没有操作数或中间率不能仅凭正确总变动通过', () => {
  const incomplete = {
    ...correct,
    operands: correct.operands.slice(0, 3),
    rates: { ...correct.rates, intermediate: null },
  };
  assert.equal(statuses(bPrime, incomplete).operands, 'UNKNOWN');
  assert.equal(statuses(bPrime, incomplete).rates, 'UNKNOWN');
  assert.equal(statuses(bPrime, incomplete).closure, 'UNKNOWN');
  assert.deepEqual(statuses(bPrime, undefined), { applicability: 'UNKNOWN' });
});

test('缺可比字段时，错报缺口或仍声称归因失败，证据不全待定', () => {
  assert.equal(statuses(sessionScenario, correct).applicability, 'FAIL');
  assert.equal(statuses(sessionScenario, { ...stop, effects: correct.effects }).applicability, 'FAIL');
  assert.equal(statuses(sessionScenario, { ...stop, attribution: '渠道导致' }).applicability, 'FAIL');
  assert.equal(statuses(sessionScenario, { ...stop, missing: [{ ...stop.missing[0], field: 'visitors' }] }).applicability, 'FAIL');
  assert.equal(statuses(sessionScenario, { ...stop, missing: stop.missing.slice(0, 1) }).applicability, 'UNKNOWN');
});

test('新增渠道缺基期行时需要明确指出该行', () => {
  const partial = { ...bPrime, rows: bPrime.rows.slice(1) };
  const missing = [{ period: 'before', channel: 'A', field: 'row' }];
  assert.equal(statuses(partial, { decision: 'stop', missing }).applicability, 'PASS');
});

test('无效或重复的源数据行在评分前被拒绝', () => {
  assert.doesNotThrow(() => validateScenario(bPrime));
  assert.throws(() => validateScenario({ ...bPrime, rows: [...bPrime.rows, bPrime.rows[0]] }), /重复/);
  assert.throws(() => validateScenario({ ...bPrime, rows: [{ ...bPrime.rows[0], visitors: -1 }] }), /非负整数/);
});
