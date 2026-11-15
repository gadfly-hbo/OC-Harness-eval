export interface ConversionScenario {
  metric: 'visitors' | 'sessions';
  rows: Array<{
    period: 'before' | 'after';
    channel: string;
    conversions: number;
    visitors?: number;
    sessions?: number;
  }>;
}

export interface Assertion {
  id: string;
  status: 'PASS' | 'FAIL' | 'UNKNOWN';
  reason: string;
}

type Row = ConversionScenario['rows'][number];
type Period = Row['period'];
type Metric = ConversionScenario['metric'];
type RecordValue = Record<string, unknown>;

const periods = ['before', 'after'] as const;
const metrics = ['visitors', 'sessions'] as const;
// Two decimal places in percentage points are sufficient for the business report.
const tolerance = 0.005 + 1e-10;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPeriod(value: unknown): value is Period {
  return value === 'before' || value === 'after';
}

function rowKey(period: Period, channel: string): string {
  return JSON.stringify([period, channel]);
}

export function validateScenario(value: unknown): asserts value is ConversionScenario {
  if (!isRecord(value) || (value.metric !== 'visitors' && value.metric !== 'sessions') ||
      !Array.isArray(value.rows) || value.rows.length === 0) {
    throw new Error('转化率场景需要固定分母口径和至少一条数据行');
  }
  const seen = new Set<string>();
  for (const row of value.rows) {
    if (!isRecord(row) || !isPeriod(row.period) || typeof row.channel !== 'string' || !row.channel.trim() ||
        !isCount(row.conversions) || metrics.some((field) => row[field] !== undefined && !isCount(row[field]))) {
      throw new Error('转化率数据行需要有效期间、渠道及非负整数计数');
    }
    const key = rowKey(row.period, row.channel);
    if (seen.has(key)) throw new Error(`转化率数据行重复：${key}`);
    seen.add(key);
  }
}

function assertion(id: string, status: Assertion['status'], reason: string): Assertion {
  return { id, status, reason };
}

function scoreOperands(rows: Row[], metric: Metric, operands: unknown): Assertion {
  if (operands == null) return assertion('operands', 'UNKNOWN', '没有实际计算操作数');
  if (!Array.isArray(operands)) return assertion('operands', 'FAIL', '计算操作数必须是逐期、逐渠道记录');

  const expected = new Map(rows.map((row) => [rowKey(row.period, row.channel), row]));
  const seen = new Set<string>();
  let incomplete = false;
  for (const operand of operands) {
    if (!isRecord(operand) || !isPeriod(operand.period) || typeof operand.channel !== 'string') {
      return assertion('operands', 'FAIL', '计算操作数的期间或渠道无效');
    }
    const key = rowKey(operand.period, operand.channel);
    const row = expected.get(key);
    if (!row || seen.has(key)) return assertion('operands', 'FAIL', `出现额外或重复的操作数 ${key}`);
    seen.add(key);
    for (const [field, count] of [['conversions', row.conversions], ['denominator', row[metric]]] as const) {
      if (operand[field] == null) {
        incomplete = true;
      } else if (operand[field] !== count) {
        return assertion('operands', 'FAIL', `${key} 的 ${field} 应为 ${count}，实际为 ${JSON.stringify(operand[field])}`);
      }
    }
  }
  return incomplete || seen.size < expected.size
    ? assertion('operands', 'UNKNOWN', '实际操作数未覆盖全部期间和渠道')
    : assertion('operands', 'PASS', `各期各渠道的转化数和 ${metric} 分母均与输入一致`);
}

function scoreValues(
  id: string,
  raw: unknown,
  expected: Record<string, number>,
  unit: '%' | 'pp',
): { result: Assertion; values?: Record<string, number> } {
  if (raw == null) return { result: assertion(id, 'UNKNOWN', '没有数值记录') };
  if (!isRecord(raw) || (raw.unit != null && raw.unit !== unit && raw.unit !== 'ratio')) {
    return { result: assertion(id, 'FAIL', `数值结构无效或单位不是 ${unit} 或 ratio`) };
  }
  if (raw.unit == null) return { result: assertion(id, 'UNKNOWN', '没有数值单位') };

  const values: Record<string, number> = {};
  const differences: string[] = [];
  for (const [key, expectedValue] of Object.entries(expected)) {
    const value = raw[key];
    if (value == null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { result: assertion(id, 'FAIL', `${key} 不是有限数值`) };
    }
    const actual = raw.unit === 'ratio' ? value * 100 : value;
    values[key] = actual;
    if (Math.abs(actual - expectedValue) > tolerance) {
      differences.push(`${key} 应为 ${expectedValue.toFixed(4)} ${unit}，实际为 ${actual} ${unit}`);
    }
  }
  const complete = Object.keys(values).length === Object.keys(expected).length;
  if (differences.length > 0) return { result: assertion(id, 'FAIL', differences.join('；')), values: complete ? values : undefined };
  if (!complete) return { result: assertion(id, 'UNKNOWN', '数值记录缺少必要字段') };
  return { result: assertion(id, 'PASS', `与独立复算一致，单位换算至 ${unit}`), values };
}

function scoreClosure(rates?: Record<string, number>, effects?: Record<string, number>): Assertion {
  if (!rates || !effects) return assertion('closure', 'UNKNOWN', '缺少检查分解闭合所需的数值');
  const differences = [
    effects.total - (rates.after - rates.before),
    effects.mix - (rates.intermediate - rates.before),
    effects.rate - (rates.after - rates.intermediate),
    effects.total - effects.mix - effects.rate,
  ];
  return differences.every((difference) => Math.abs(difference) <= 3 * tolerance)
    ? assertion('closure', 'PASS', '总变动和分解项与所报转化率闭合')
    : assertion('closure', 'FAIL', '分解项与所报转化率或总变动不闭合');
}

function missingInputs(rows: Row[], metric: Metric): Set<string> {
  const missing = new Set<string>();
  const input = new Map(rows.map((row) => [rowKey(row.period, row.channel), row]));
  for (const channel of new Set(rows.map((row) => row.channel))) {
    for (const period of periods) {
      const row = input.get(rowKey(period, channel));
      if (!row?.[metric]) missing.add(JSON.stringify([period, channel, row ? metric : 'row']));
    }
  }
  return missing;
}

function scoreStop(outcome: RecordValue, missing: Set<string>): Assertion {
  if (outcome.rates != null || outcome.effects != null || outcome.attribution != null ||
      (outcome.decision != null && outcome.decision !== 'stop')) {
    return assertion('applicability', 'FAIL', '缺少可比数据时仍然分解或归因');
  }
  if (outcome.decision == null || outcome.missing == null) {
    return assertion('applicability', 'UNKNOWN', '没有完整的停止决定和输入缺口记录');
  }
  if (!Array.isArray(outcome.missing)) return assertion('applicability', 'FAIL', '输入缺口必须逐条记录');
  const reported = new Set<string>();
  for (const item of outcome.missing) {
    if (!isRecord(item)) return assertion('applicability', 'FAIL', '输入缺口记录无效');
    const key = JSON.stringify([item.period, item.channel, item.field]);
    if (!missing.has(key) || reported.has(key)) {
      return assertion('applicability', 'FAIL', `输入缺口错误或重复：${key}`);
    }
    reported.add(key);
  }
  if (reported.size !== missing.size) {
    return assertion('applicability', 'UNKNOWN', '输入缺口记录未覆盖全部不可比数据');
  }
  return assertion('applicability', 'PASS', '指出了全部可比数据缺口并停止归因');
}

export function scoreConversion(scenario: ConversionScenario, outcome: unknown): Assertion[] {
  if (outcome == null) return [assertion('applicability', 'UNKNOWN', '没有可评的业务输出')];
  if (!isRecord(outcome)) return [assertion('applicability', 'FAIL', '业务输出不是对象')];
  const { metric, rows } = scenario;
  const missing = missingInputs(rows, metric);
  if (missing.size > 0) return [scoreStop(outcome, missing)];
  const before = rows.filter((row) => row.period === 'before');
  const after = rows.filter((row) => row.period === 'after');
  const beforeByChannel = new Map(before.map((row) => [row.channel, row]));
  if (outcome.decision !== 'decompose') {
    return [assertion('applicability', outcome.decision == null ? 'UNKNOWN' : 'FAIL', '可比输入需要分解')];
  }

  const denominator = (group: Row[]) => group.reduce((sum, row) => sum + row[metric]!, 0);
  const rate = (group: Row[]) => 100 * group.reduce((sum, row) => sum + row.conversions, 0) / denominator(group);
  const baselineRate = rate(before);
  const currentRate = rate(after);
  const afterTotal = denominator(after);
  const intermediate = 100 * after.reduce((sum, row) => {
    const baseline = beforeByChannel.get(row.channel)!;
    return sum + (row[metric]! / afterTotal) * (baseline.conversions / baseline[metric]!);
  }, 0);
  const rates = scoreValues('rates', outcome.rates, { before: baselineRate, after: currentRate, intermediate }, '%');
  const effects = scoreValues('effects', outcome.effects, {
    total: currentRate - baselineRate,
    mix: intermediate - baselineRate,
    rate: currentRate - intermediate,
  }, 'pp');
  const metricStatus = outcome.metric == null ? 'UNKNOWN' : outcome.metric === metric ? 'PASS' : 'FAIL';
  return [
    assertion('applicability', 'PASS', '口径一致且渠道数据可比，应执行分解'),
    assertion('metric', metricStatus, `固定口径为 ${metric}，输出口径为 ${outcome.metric == null ? '未提供' : JSON.stringify(outcome.metric)}`),
    scoreOperands(rows, metric, outcome.operands),
    rates.result,
    effects.result,
    scoreClosure(rates.values, effects.values),
  ];
}
