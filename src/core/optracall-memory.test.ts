import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { detectMemoryUsage, memoryToActivation, seedMemoryFixtures } from "./optracall-memory.ts";
import type { PiEvent } from "./pi.ts";

test("detectMemoryUsage 取证 find/read 行为与成功读取", () => {
  const events: PiEvent[] = [
    { type: "tool_execution_start", toolName: "read_case_sources", toolCallId: "f1", args: { action: "find", query: "缺货" } },
    { type: "tool_execution_end", toolCallId: "f1", isError: false },
    { type: "tool_execution_start", toolName: "read_case_sources", toolCallId: "r1", args: { action: "read", target: { type: "case-decision", caseId: "c1", recordId: "rec1", revision: 1 } } },
    { type: "tool_execution_end", toolCallId: "r1", isError: false },
    { type: "tool_execution_start", toolName: "read", toolCallId: "x1", args: { path: "data.csv" } },
    { type: "tool_execution_end", toolCallId: "x1", isError: false },
  ];
  const usage = detectMemoryUsage(events);
  assert.equal(usage.consulted, true);
  assert.equal(usage.findCalls, 1);
  assert.equal(usage.successfulFindCalls, 1);
  assert.equal(usage.readCalls, 1);
  assert.equal(usage.successfulReads, 1);
  assert.deepEqual(usage.queries, ["缺货"]);
  assert.deepEqual(usage.readTargets, [{ caseId: "c1", recordId: "rec1", revision: 1 }]);
});

test("未调用记忆工具 → consulted=false；读取失败不计成功", () => {
  assert.equal(detectMemoryUsage([]).consulted, false);
  const events: PiEvent[] = [
    { type: "tool_execution_start", toolName: "read_case_sources", toolCallId: "r1", args: { action: "read", target: { caseId: "c1", recordId: "rec1", revision: 1 } } },
    { type: "tool_execution_end", toolCallId: "r1", isError: true },
  ];
  const usage = detectMemoryUsage(events);
  assert.equal(usage.consulted, false);
  assert.equal(usage.readCalls, 1);
  assert.equal(usage.successfulReads, 0);
  assert.deepEqual(usage.readTargets, []);
});

test("memoryToActivation 把 consulted 映射为激活", () => {
  const activated = memoryToActivation({ consulted: true, findCalls: 1, successfulFindCalls: 1, readCalls: 1, queries: ["q"], readTargets: [{ caseId: "c1", recordId: "r1", revision: 1 }], successfulReads: 1 });
  assert.equal(activated.activated, true);
  assert.equal(activated.status, "activated");
  assert.deepEqual(activated.readSkillPaths, ["c1/r1@1"]);
  const not = memoryToActivation({ consulted: false, findCalls: 0, successfulFindCalls: 0, readCalls: 0, queries: [], readTargets: [], successfulReads: 0 });
  assert.equal(not.activated, false);
  assert.equal(not.status, "not_activated");
});

function makeCaseDb(dataRoot: string): void {
  const db = new DatabaseSync(join(dataRoot, "decision-cases.sqlite3"));
  db.exec(`
    CREATE TABLE store_metadata (store_id TEXT PRIMARY KEY, initialized_at TEXT NOT NULL);
    CREATE TABLE cases (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', judgement TEXT NOT NULL DEFAULT '',
      next_step TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, close_reason TEXT, closed_at TEXT,
      revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE operation_receipts (
      operation_id TEXT PRIMARY KEY, kind TEXT NOT NULL, request_sha256 TEXT NOT NULL, case_id TEXT, project_id TEXT,
      phase TEXT NOT NULL, result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE case_decision_revisions (
      record_id TEXT NOT NULL, revision INTEGER NOT NULL, case_id TEXT NOT NULL, kind TEXT NOT NULL,
      payload_json TEXT NOT NULL, refs_json TEXT NOT NULL, origin_json TEXT NOT NULL, lifecycle TEXT NOT NULL,
      created_at TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE, PRIMARY KEY(record_id,revision));
    INSERT INTO store_metadata (store_id, initialized_at) VALUES ('store-1', '2026-11-16T00:00:00.000Z');
    PRAGMA user_version=2;
  `);
  db.close();
}

test("seedMemoryFixtures 注入判断卡片，可被 find 的 SQL 读到", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "optracall-memory-"));
  try {
    makeCaseDb(dataRoot);
    const seeded = seedMemoryFixtures(dataRoot, [
      { caseTitle: "缺货事项", judgment: { kind: "hypothesis", title: "执行路径待核", statement: "已有权限仍可能没有实际执行。" } },
    ]);
    assert.equal(seeded.length, 1);
    assert.equal(seeded[0]!.caseStoreId, "store-1");
    assert.equal(seeded[0]!.title, "执行路径待核");
    // 用 read_case_sources find 的同款 SQL 验证可读到。
    const db = new DatabaseSync(join(dataRoot, "decision-cases.sqlite3"));
    const rows = db.prepare(`SELECT json_extract(r.payload_json,'$.payload.title') AS title, r.lifecycle
      FROM case_decision_revisions r JOIN cases c ON c.id=r.case_id
      WHERE NOT EXISTS (SELECT 1 FROM case_decision_revisions newer WHERE newer.record_id=r.record_id AND newer.revision>r.revision)
        AND r.lifecycle='active' AND instr(lower(c.title || ' ' || json_extract(r.payload_json,'$.payload.title')),lower(?))>0`).all("缺货") as Array<{ title: string; lifecycle: string }>;
    db.close();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.title, "执行路径待核");
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("存储未初始化时报错", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "optracall-memory-empty-"));
  try {
    assert.throws(() => seedMemoryFixtures(dataRoot, []), /OPTRACALL_MEMORY_STORE_MISSING/);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("v1 空库自动迁移到 v2 后注入成功", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "optracall-memory-v1-"));
  try {
    const db = new DatabaseSync(join(dataRoot, "decision-cases.sqlite3"));
    db.exec(`
      CREATE TABLE store_metadata (store_id TEXT PRIMARY KEY, initialized_at TEXT NOT NULL);
      CREATE TABLE cases (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', judgement TEXT NOT NULL DEFAULT '', next_step TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, close_reason TEXT, closed_at TEXT, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE operation_receipts (operation_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('case_create','case_note')), request_sha256 TEXT NOT NULL, case_id TEXT, project_id TEXT, phase TEXT NOT NULL, result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE work_events (id TEXT PRIMARY KEY, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, revision INTEGER NOT NULL, event_type TEXT NOT NULL, operation_id TEXT NOT NULL, actor_kind TEXT NOT NULL, origin_case_id TEXT, changes_json TEXT NOT NULL, note TEXT, feedback_source TEXT, occurred_at TEXT NOT NULL);
      INSERT INTO store_metadata VALUES ('store-v1','2026-11-16T00:00:00.000Z');
      PRAGMA user_version=1;
    `);
    db.close();
    const seeded = seedMemoryFixtures(dataRoot, [{ caseTitle: "迁移事项", judgment: { kind: "strategy", title: "策略甲", statement: "先核补货记录。" } }]);
    assert.equal(seeded.length, 1);
    const verify = new DatabaseSync(join(dataRoot, "decision-cases.sqlite3"));
    const version = (verify.prepare("PRAGMA user_version").get() as any).user_version;
    const count = (verify.prepare("SELECT COUNT(*) AS n FROM case_decision_revisions").get() as any).n;
    verify.close();
    assert.equal(version, 2);
    assert.equal(count, 1);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});