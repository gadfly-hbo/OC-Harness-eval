import assert from "node:assert/strict";
import { test } from "node:test";

import { CAPABILITIES, detectCapabilityUsage } from "./optracall-capabilities.ts";
import type { PiEvent } from "./pi.ts";

test("注册表含两个 A 族能力，flag/工具/语义正确", () => {
  assert.deepEqual(Object.keys(CAPABILITIES).sort(), ["memory", "sap-method"]);
  assert.equal(CAPABILITIES.memory.disableFlag, "--disable-experience-learning");
  assert.equal(CAPABILITIES.memory.forensicTool, "read_case_sources");
  assert.equal(CAPABILITIES.memory.consultOn, "find-or-read");
  assert.equal(CAPABILITIES["sap-method"].disableFlag, "--disable-sap-methods");
  assert.equal(CAPABILITIES["sap-method"].consultOn, "read");
  assert.equal(CAPABILITIES["sap-method"].readTargetKind, "sap-method");
});

test("memory：find 成功即算使用（工具整体禁用）", () => {
  const events: PiEvent[] = [
    { type: "tool_execution_start", toolName: "read_case_sources", toolCallId: "f1", args: { action: "find", query: "缺货" } },
    { type: "tool_execution_end", toolCallId: "f1", isError: false },
  ];
  assert.equal(detectCapabilityUsage(events, CAPABILITIES.memory).consulted, true);
});

test("sap-method：仅 find 成功不算使用，须读到 sap-method 目标", () => {
  const findOnly: PiEvent[] = [
    { type: "tool_execution_start", toolName: "read_semantic_context", toolCallId: "f1", args: { action: "find", query: "转化率", kinds: ["sap-method"] } },
    { type: "tool_execution_end", toolCallId: "f1", isError: false },
  ];
  assert.equal(detectCapabilityUsage(findOnly, CAPABILITIES["sap-method"]).consulted, false);

  const withRead: PiEvent[] = [
    ...findOnly,
    { type: "tool_execution_start", toolName: "read_semantic_context", toolCallId: "r1", args: { action: "read", target: { kind: "sap-method", methodId: "m1", version: 1 } } },
    { type: "tool_execution_end", toolCallId: "r1", isError: false },
  ];
  const usage = detectCapabilityUsage(withRead, CAPABILITIES["sap-method"]);
  assert.equal(usage.consulted, true);
  assert.equal(usage.successfulReads, 1);
  assert.deepEqual(usage.readTargets, [{ caseId: "m1", recordId: "", revision: 1 }]);
});

test("sap-method：读到非 sap-method 目标不计入", () => {
  const events: PiEvent[] = [
    { type: "tool_execution_start", toolName: "read_semantic_context", toolCallId: "r1", args: { action: "read", target: { kind: "enterprise", methodId: "e1" } } },
    { type: "tool_execution_end", toolCallId: "r1", isError: false },
  ];
  const usage = detectCapabilityUsage(events, CAPABILITIES["sap-method"]);
  assert.equal(usage.consulted, false);
  assert.equal(usage.successfulReads, 0);
});

test("基线工具失败尝试不算成功使用", () => {
  const events: PiEvent[] = [
    { type: "tool_execution_start", toolName: "read_case_sources", toolCallId: "f1", args: { action: "find", query: "x" } },
    { type: "tool_execution_end", toolCallId: "f1", isError: true },
  ];
  assert.equal(detectCapabilityUsage(events, CAPABILITIES.memory).consulted, false);
});