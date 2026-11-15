import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateNegativeControl,
  formatNegativeControlReport,
  stripBehavioralContract,
} from "./verify.ts";
import type { EvaluationSummary } from "./runner.ts";
import { computeAssertionItemRate, computeGainPp } from "./gain.ts";

test("stripBehavioralContract 保留 YAML frontmatter 触发契约并剥离正文行为契约", () => {
  const rawSkill = `---
name: data-analysis
description: 当用户需要分析数据、看趋势、找异常、做归因时使用本技能。
version: 1.8.0
---

# 数据分析专家

## 六段输出契约
1. 结论先行
2. 样本量声明（必须标注 N=）
3. 严禁未做因果检验时下因果结论
4. 明确责任人与截止时间
`;

  const stripped = stripBehavioralContract(rawSkill);
  assert.equal(stripped.preservedFrontmatter, true);
  assert.match(stripped.content, /name: data-analysis/);
  assert.match(stripped.content, /分析数据、看趋势/);
  assert.doesNotMatch(stripped.content, /样本量声明/);
  assert.doesNotMatch(stripped.content, /因果检验/);
  assert.ok(stripped.strippedLines < stripped.originalLines);
});

test("evaluateNegativeControl 拦截破坏版增益仍然达标（契约泄漏或无区分断言）的伪区分", () => {
  const makeFakeSummary = (basePass: number, varPass: number, activated = true): EvaluationSummary => ({
    runId: "fake",
    model: "m1",
    judgeModel: "m2",
    repeat: 1,
    judgeRepeat: 1,
    startedAt: 0,
    endedAt: 1000,
    durationSec: 10,
    status: "success",
    results: [
      {
        id: "baseline-t1-1",
        variantId: "baseline",
        variantLabel: "Baseline",
        taskId: "t1",
        attempt: 1,
        status: "success",
        startedAt: 0,
        endedAt: 1000,
        durationSec: 1,
        skillPaths: [],
        totalTokens: 100,
        totalCost: 0.001,
        toolCalls: 0,
        output: "out",
        activation: {
          status: "not_activated",
          activated: false,
          readSkillPaths: [],
          matchedKeywords: [],
          evidence: [],
        },
        assertions: {
          total: 10,
          passed: basePass,
          failed: 10 - basePass,
          allPassed: basePass === 10,
          outcomes: Array.from({ length: 10 }, (_, i) => ({
            kind: "mustMatch" as const,
            passed: i < basePass,
            detail: "d",
          })),
        },
        evidenceDir: "e",
        error: null,
      },
      {
        id: "skill-t1-1",
        variantId: "skill",
        variantLabel: "Skill",
        taskId: "t1",
        attempt: 1,
        status: "success",
        startedAt: 0,
        endedAt: 1000,
        durationSec: 1,
        skillPaths: ["/tmp/SKILL.md"],
        totalTokens: 100,
        totalCost: 0.001,
        toolCalls: 1,
        output: "out",
        activation: {
          status: activated ? "activated" : "not_activated",
          activated,
          readSkillPaths: activated ? ["/tmp/SKILL.md"] : [],
          matchedKeywords: [],
          evidence: [],
        },
        assertions: {
          total: 10,
          passed: varPass,
          failed: 10 - varPass,
          allPassed: varPass === 10,
          outcomes: Array.from({ length: 10 }, (_, i) => ({
            kind: "mustMatch" as const,
            passed: i < varPass,
            detail: "d",
          })),
        },
        evidenceDir: "e",
        error: null,
      },
    ],
    pairwise: [],
    variantSummaries: [],
    taskSummaries: [],
    disagreements: [],
    totalCost: 0,
    totalTokens: 0,
    tasks: [{ id: "t1", prompt: "合成阴性对照任务", assertions: Array.from({ length: 10 }, () => ({ kind: "mustMatch", pattern: ".+" })) }],
    suiteMeta: { suiteId: "fake-suite", suiteVersion: "1", suiteHash: "same-frozen-suite", skillVersion: "1", skillPath: "/tmp/SKILL.md" },
    integrity: { verified: true, issues: [] },
    isolation: { verified: true, issues: [] },
  });

  // 破坏版仍然拿到 +30pp 增益 → 失败（契约泄漏或断言失真）
  const leaked = evaluateNegativeControl(makeFakeSummary(3, 8, true), makeFakeSummary(3, 6, true));
  assert.equal(leaked.passed, false);
  assert.equal(leaked.status, "failed");
  assert.ok(leaked.issues.some((x) => x.includes("破坏版增益")));

  // 破坏版激活率掉到 0% → 失败（连触发契约一起破坏了，变量控制不成立）
  const unactivated = evaluateNegativeControl(
    makeFakeSummary(3, 8, true),
    makeFakeSummary(3, 3, false),
  );
  assert.equal(unactivated.passed, false);
  assert.equal(unactivated.status, "failed");
  assert.ok(unactivated.issues.some((x) => x.includes("激活率")));
});
