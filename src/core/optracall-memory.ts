/**
 * OptraCall memory 测评：记忆 Fixture 注入 + 记忆使用行为取证。
 *
 * 唯一变量是 read_case_sources（M6 跨事项经验）能力有无，由 Host flag 承载。
 * Fixture 直写**评测 dataRoot** 的 Case SQLite（cases + operation_receipts +
 * case_decision_revisions），不碰真实产品数据；read_case_sources 的 find/read
 * 直接读 case_decision_revisions，故注入判断卡片即可被 Agent 查读。
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { PiEvent } from "./pi.ts";
import type { ActivationResult } from "./activation.ts";

export interface MemoryFixture {
  caseTitle: string;
  caseStatus?: "pending" | "analyzing" | "awaiting_confirmation" | "observing";
  judgment: { kind: "hypothesis" | "strategy"; title: string; statement: string };
}

export interface SeededMemory {
  caseStoreId: string;
  caseId: string;
  recordId: string;
  revision: number;
  title: string;
}

const CASE_DB = "decision-cases.sqlite3";

/**
 * 与 OptraCall upgradeDecisionSchema 一致的 v2 迁移（判断卡片表）。
 * Case 存储初始化在 v1，判断表在首次判断写入时才懒迁移；Fixture 直注入须先迁移。
 * 仅用于新建空评测库（无业务数据），不触碰真实产品数据。
 */
function ensureDecisionSchema(db: DatabaseSync): void {
  const version = (db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined)?.user_version ?? 0;
  if (version >= 2) return;
  db.exec(`
    CREATE TEMP TABLE m5_old_events AS SELECT * FROM work_events;
    CREATE TEMP TABLE m5_old_receipts AS SELECT * FROM operation_receipts;
    DROP TABLE work_events;
    CREATE TABLE operation_receipts_m5 (
     operation_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('case_create','case_update','case_close','case_reopen','case_note','project_link','project_unlink','project_work_save','project_work_note','artifact_save','artifact_unlink','project_create_link','task_context_prepare','case_decision_save','case_strategy_choice')),
     request_sha256 TEXT NOT NULL, case_id TEXT REFERENCES cases(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED, project_id TEXT,
     phase TEXT NOT NULL CHECK(phase IN ('prepared','project_created','completed','needs_review')), result_json TEXT,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL, CHECK(phase!='completed' OR result_json IS NOT NULL)
    );
    INSERT INTO operation_receipts_m5 SELECT * FROM operation_receipts;
    DROP TABLE operation_receipts;
    ALTER TABLE operation_receipts_m5 RENAME TO operation_receipts;
    CREATE TABLE work_events (
     id TEXT PRIMARY KEY, subject_type TEXT NOT NULL CHECK(subject_type IN ('case','project')), subject_id TEXT NOT NULL,
     revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>0), event_type TEXT NOT NULL CHECK(event_type IN ('case_created','case_updated','case_closed','case_reopened','project_linked','project_unlinked','artifact_linked','artifact_updated','artifact_unlinked','note_added','project_work_updated','project_work_note_added','case_strategy_choice')),
     operation_id TEXT NOT NULL REFERENCES operation_receipts(operation_id) ON DELETE RESTRICT, actor_kind TEXT NOT NULL CHECK(actor_kind IN ('user','host')),
     origin_case_id TEXT REFERENCES cases(id) ON DELETE RESTRICT, changes_json TEXT NOT NULL, note TEXT CHECK(note IS NULL OR length(note)<=10000),
     feedback_source TEXT CHECK(feedback_source IS NULL OR length(feedback_source)<=1000), occurred_at TEXT NOT NULL,
     UNIQUE(subject_type,subject_id,revision)
    );
    INSERT INTO work_events SELECT * FROM temp.m5_old_events;
    CREATE TABLE case_decision_revisions (
     record_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>0),
     case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE RESTRICT, kind TEXT NOT NULL CHECK(kind IN ('hypothesis','strategy')),
     payload_json TEXT NOT NULL, refs_json TEXT NOT NULL, origin_json TEXT NOT NULL,
     lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','archived')), created_at TEXT NOT NULL,
     operation_id TEXT NOT NULL UNIQUE REFERENCES operation_receipts(operation_id) ON DELETE RESTRICT,
     PRIMARY KEY(record_id,revision)
    );
    CREATE INDEX decisions_case_record_revision ON case_decision_revisions(case_id,record_id,revision);
    PRAGMA user_version=2;
    DROP TABLE temp.m5_old_events; DROP TABLE temp.m5_old_receipts;
  `);
}

/** 向评测 dataRoot 的 Case 存储注入合成记忆判断卡片。Host 须已初始化该存储。 */
export function seedMemoryFixtures(dataRoot: string, fixtures: MemoryFixture[]): SeededMemory[] {
  const dbPath = join(dataRoot, CASE_DB);
  if (!existsSync(dbPath)) throw new Error(`OPTRACALL_MEMORY_STORE_MISSING: ${dbPath}（Host 须先初始化 Case 存储）`);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;");
    ensureDecisionSchema(db);
    const meta = db.prepare("SELECT store_id FROM store_metadata").get() as { store_id?: string } | undefined;
    const caseStoreId = meta?.store_id;
    if (!caseStoreId) throw new Error("OPTRACALL_MEMORY_STORE_UNINITIALIZED: store_metadata 无 store_id");
    const seeded: SeededMemory[] = [];
    const now = new Date().toISOString();
    const insertCase = db.prepare("INSERT INTO cases (id,title,description,judgement,next_step,status,close_reason,closed_at,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
    const insertReceipt = db.prepare("INSERT INTO operation_receipts (operation_id,kind,request_sha256,case_id,project_id,phase,result_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)");
    const insertRevision = db.prepare("INSERT INTO case_decision_revisions (record_id,revision,case_id,kind,payload_json,refs_json,origin_json,lifecycle,created_at,operation_id) VALUES (?,?,?,?,?,?,?,?,?,?)");
    const transaction = db.prepare("BEGIN");
    transaction.run();
    try {
      for (const fixture of fixtures) {
        const caseId = randomUUID(), recordId = randomUUID(), operationId = randomUUID();
        const status = fixture.caseStatus ?? "analyzing";
        insertCase.run(caseId, fixture.caseTitle, "", "", "", status, null, null, 1, now, now);
        const payload = { payload: { title: fixture.judgment.title, statement: fixture.judgment.statement }, impactNotes: null, changeReason: null };
        const resultJson = JSON.stringify({ recordId, revision: 1, caseId, kind: fixture.judgment.kind, ...payload, lifecycle: "active" });
        const requestSha = createHash("sha256").update(resultJson).digest("hex");
        insertReceipt.run(operationId, "case_decision_save", requestSha, caseId, null, "completed", resultJson, now, now);
        const origin = { actorKind: "user", operationId, caseId, recordId };
        insertRevision.run(recordId, 1, caseId, fixture.judgment.kind, JSON.stringify(payload), "[]", JSON.stringify(origin), "active", now, operationId);
        seeded.push({ caseStoreId, caseId, recordId, revision: 1, title: fixture.judgment.title });
      }
      db.prepare("COMMIT").run();
    } catch (error) {
      db.prepare("ROLLBACK").run();
      throw error;
    }
    return seeded;
  } finally {
    db.close();
  }
}

export interface MemoryUsage {
  /** 是否成功使用记忆（find 或 read 成功）；工具不可用时的失败尝试不算。 */
  consulted: boolean;
  findCalls: number;
  successfulFindCalls: number;
  readCalls: number;
  /** find 的查询词。 */
  queries: string[];
  /** read 命中的判断卡片目标。 */
  readTargets: Array<{ caseId: string; recordId: string; revision: number }>;
  /** 读取是否成功（非 isError）。 */
  successfulReads: number;
}

/** 从 native 事件流取证 read_case_sources 的 find/read 行为。 */
export function detectMemoryUsage(events: PiEvent[]): MemoryUsage {
  const usage: MemoryUsage = { consulted: false, findCalls: 0, successfulFindCalls: 0, readCalls: 0, queries: [], readTargets: [], successfulReads: 0 };
  const pending = new Map<string, { action: string; target?: any }>();
  for (const event of events) {
    if (event.type === "tool_execution_start" && event.toolName === "read_case_sources") {
      const args = (event.args ?? {}) as { action?: string; query?: string; target?: any };
      const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
      if (args.action === "find") {
        usage.findCalls += 1;
        if (typeof args.query === "string" && args.query.trim()) usage.queries.push(args.query);
      } else if (args.action === "read") {
        usage.readCalls += 1;
      }
      pending.set(id, { action: String(args.action ?? ""), target: args.target });
    } else if (event.type === "tool_execution_end") {
      const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
      const call = pending.get(id);
      pending.delete(id);
      if (!call || event.isError !== false) continue;
      if (call.action === "find") {
        usage.successfulFindCalls += 1;
      } else if (call.action === "read") {
        usage.successfulReads += 1;
        const target = call.target;
        if (target && typeof target === "object" && typeof target.caseId === "string" && typeof target.recordId === "string") {
          usage.readTargets.push({ caseId: target.caseId, recordId: target.recordId, revision: Number(target.revision ?? 0) });
        }
      }
    }
  }
  usage.consulted = usage.successfulFindCalls > 0 || usage.successfulReads > 0;
  return usage;
}

/** 把记忆使用映射为激活结果（consulted = 激活），复用 runner 的激活率统计。 */
export function memoryToActivation(usage: MemoryUsage): ActivationResult {
  const activated = usage.consulted;
  return {
    status: activated ? "activated" : "not_activated",
    activated,
    matchedKeywords: [],
    readSkillPaths: usage.readTargets.map(target => `${target.caseId}/${target.recordId}@${target.revision}`),
    readSubPaths: [],
    evidence: usage.readTargets.map(target => ({ kind: "tool_call" as const, value: `${target.caseId}/${target.recordId}@${target.revision}`, skillPath: "read_case_sources" })),
  };
}