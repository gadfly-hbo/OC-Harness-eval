import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const skill = readFileSync(new URL("../../skills/skill-eval-flow/SKILL.md", import.meta.url), "utf8");

test("技能面向 OptraCall 产品环境，唯一变量是目标 skill 是否可用", () => {
  assert.match(skill, /OptraCall 产品环境/);
  assert.match(skill, /正常任务入口/);
  assert.match(skill, /唯一变量是目标 skill 是否可用/);
  assert.match(skill, /基线侧物理移除该 skill/);
  assert.match(skill, /不跑裸 Pi/);
});

test("技能不再走 pending/archive 流程", () => {
  assert.doesNotMatch(skill, /pending\//);
  assert.doesNotMatch(skill, /archive\//);
  assert.doesNotMatch(skill, /待测评区/);
  assert.doesNotMatch(skill, /## S5/);
  assert.doesNotMatch(skill, /选择档位和消融/);
});

test("全局规则保留失败即数据与激活不等于有用", () => {
  const section = skill.split("## 全局规则")[1]?.split("## 正式测评参数")[0];
  assert.ok(section);
  assert.match(section, /失败即数据/);
  assert.match(section, /断言先于结果/);
  assert.match(section, /真实运行/);
  assert.match(section, /激活 ≠ 有用/);
});

test("技能说明非 OS 沙箱隔离边界", () => {
  const section = skill.split("## 隔离边界")[1]?.split("## S0")[0];
  assert.ok(section);
  assert.match(section, /不是 OS 沙箱/);
  assert.match(section, /独立评测根/);
  assert.match(section, /污染取证/);
  assert.match(section, /不连接、不停止、不修改用户运行中的试用服务/);
});

test("状态机为 S0-S4，eval 走 --optracall 且先预检", () => {
  for (const state of ["## S0 收集输入", "## S1 环境自检", "## S2 套件就绪", "## S3 对照评估", "## S4 解读报告"]) {
    assert.ok(skill.includes(state), state);
  }
  const s3 = skill.split("## S3 对照评估")[1]?.split("## S4")[0];
  assert.ok(s3);
  assert.match(s3, /--optracall <checkout>/);
  assert.match(s3, /--model minimax-cn\/MiniMax-M3\.1-Flash/);
  const s1 = skill.split("## S1 环境自检")[1]?.split("## S2")[0];
  assert.ok(s1);
  assert.match(s1, /preflight/);
  assert.match(s1, /Node 25\+/);
});

test("报告解读区分激活、规则纠偏胜率、增益区间与费用口径", () => {
  const section = skill.split("## S4 解读报告")[1]?.split("## 异常速查")[0];
  assert.ok(section);
  assert.match(section, /`winRate`.*`ruleAdjustedWinRate`.*`scoredJudged`/);
  assert.match(section, /`rawVerdict` 只表示匿名展示时 B 相对 A 的结果/);
  assert.match(section, /保守 95% Hoeffding 区间/);
  assert.match(section, /聊天自述只作过程记录/);
  assert.match(section, /SDK 估计、保守等价上界、现金账单未知/);
  assert.match(section, /只有证据确认候选违反要求时，才给 Skill 改写建议/);
});