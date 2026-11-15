import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { collectCaseEvidence, parseNativeSession } from "./optracall-evidence.ts";
import { extractToolCalls } from "./evidence.ts";

function nativeJsonl(cwd: string): string {
  const lines = [
    { type: "session", version: 3, id: "sess-1", timestamp: "2026-11-15T00:00:00.000Z", cwd },
    { type: "message", id: "m1", parentId: null, timestamp: "2026-11-15T00:00:01.000Z", message: {
      role: "assistant", content: [
        { type: "text", text: "我先读资料。" },
        { type: "toolCall", id: "t1", name: "read", arguments: { path: "data.csv" } },
      ], usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, totalTokens: 17, cost: { total: 0.001 } }, stopReason: "toolUse",
    } },
    { type: "message", id: "m2", parentId: "m1", timestamp: "2026-11-15T00:00:02.000Z", message: {
      role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "a,b\n1,2\n" }], isError: false,
    } },
    { type: "message", id: "m3", parentId: "m2", timestamp: "2026-11-15T00:00:03.000Z", message: {
      role: "assistant", content: [{ type: "text", text: "最终结论：上升 12%。" }],
      usage: { input: 20, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 28, cost: { total: 0.002 } }, stopReason: "stop",
    } },
  ];
  return lines.map(line => JSON.stringify(line)).join("\n") + "\n";
}

test("native JSONL 解析出最终输出、读取取证、用量与同形事件", () => {
  const cwd = "/proj/020_clean";
  const parsed = parseNativeSession(nativeJsonl(cwd), cwd);
  assert.equal(parsed.sessionId, "sess-1");
  assert.equal(parsed.metrics.output, "最终结论：上升 12%。");
  assert.deepEqual(parsed.metrics.readPaths, [join(cwd, "data.csv")]);
  assert.equal(parsed.metrics.toolCalls, 1);
  assert.equal(parsed.metrics.totalTokens, 45);
  assert.equal(parsed.usage.input, 30);
  assert.equal(parsed.usage.output, 13);
  assert.equal(parsed.usage.cacheRead, 2);
  assert.ok(Math.abs(parsed.usage.sdkCostTotal - 0.003) < 1e-9);
  // 事件流可被评委匿名计数复用。
  const calls = extractToolCalls(parsed.events);
  assert.deepEqual(calls, [{ tool: "read", isError: false }]);
  assert.ok(parsed.events.some(event => event.type === "message_end"));
});

test("读取失败不计入 readPaths", () => {
  const cwd = "/proj/020_clean";
  const text = [
    { type: "session", version: 3, id: "s", timestamp: "2026-11-15T00:00:00.000Z", cwd },
    { type: "message", id: "m1", parentId: null, timestamp: "2026-11-15T00:00:01.000Z", message: {
      role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "x.csv" } }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } }, stopReason: "toolUse" } },
    { type: "message", id: "m2", parentId: "m1", timestamp: "2026-11-15T00:00:02.000Z", message: {
      role: "toolResult", toolCallId: "t1", toolName: "read", content: [], isError: true } },
  ].map(line => JSON.stringify(line)).join("\n") + "\n";
  assert.deepEqual(parseNativeSession(text, cwd).metrics.readPaths, []);
});

test("终态采集：020/060 入 workspace，010 只留哈希，native 整份拷贝", () => {
  const root = mkdtempSync(join(tmpdir(), "optracall-evidence-"));
  try {
    const projectDir = join(root, "projects", "p1");
    const dataRoot = join(root, "data");
    const caseDir = join(root, "case");
    const write = (path: string, content: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, content); };
    write(join(projectDir, "010_draw", "raw.csv"), "original\n");
    write(join(projectDir, "020_clean", "data.csv"), "a,b\n1,2\n");
    write(join(projectDir, "060_reports", "analysis.md"), "# 报告\n上升 12%\n");
    const sessionFile = join(dataRoot, "projects", "p1", "tasks", "t1", "sessions", "s.jsonl");
    write(sessionFile, nativeJsonl(join(projectDir, "020_clean")));
    write(join(dataRoot, "projects", "p1", "project.json"), JSON.stringify({ id: "p1" }));

    const evidence = collectCaseEvidence({
      caseDir, projectDir, dataRoot, projectId: "p1", taskId: "t1", requestId: "r1",
      sessionFile, hostPort: 1234, lastRun: { id: "r1", status: "completed" },
    });
    assert.ok(existsSync(join(caseDir, "workspace", "020_clean", "data.csv")));
    assert.ok(existsSync(join(caseDir, "workspace", "060_reports", "analysis.md")));
    assert.ok(!existsSync(join(caseDir, "workspace", "010_draw", "raw.csv")));
    assert.ok(existsSync(join(caseDir, "optracall", "native-session.jsonl")));
    assert.ok(existsSync(join(caseDir, "optracall", "project.json")));
    assert.equal(evidence.usage.totalTokens, 45);
    const tree = JSON.parse(readFileSync(join(caseDir, "optracall", "project-tree.json"), "utf8"));
    const raw = tree.find((item: any) => item.path === "010_draw/raw.csv");
    assert.equal(raw.copied, false);
    assert.match(raw.sha256, /^[a-f0-9]{64}$/);
    const usage = JSON.parse(readFileSync(join(caseDir, "optracall", "usage.json"), "utf8"));
    assert.equal(usage.cashBill, "unknown");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});