/**
 * OptraCall A 族能力测评统一框架：知识/记忆类能力的「装/不装」对照。
 *
 * 每个能力由一个 Host disable flag 承载唯一变量，取证靠 native 会话里对应工具的
 * find/read 成功调用。memory（M6）与 sap-method 同机制。
 * 全部只读使用产品：Fixture 只注入评测 dataRoot，绝不写真实产品数据。
 */
import { randomUUID } from "node:crypto";
import type { PiEvent } from "./pi.ts";
import type { OptraCallClient } from "./optracall-driver.ts";

export type CapabilityId = "memory" | "sap-method";

export interface CapabilityDef {
  id: CapabilityId;
  label: string;
  /** baseline 侧 Host flag（关闭该能力）。 */
  disableFlag: string;
  /** 取证工具名（native 会话里的工具调用）。 */
  forensicTool: string;
  /** 成功使用的判据：find-or-read＝find 或 read 成功（工具整体禁用，如 memory）；
   *  read＝须成功 read 目标（共享工具仅禁某类内容，如 sap-method，find 空结果不算）。 */
  consultOn: "find-or-read" | "read";
  /** read 目标须匹配的 kind（如 sap-method）；缺省不限。 */
  readTargetKind?: string;
}

export const CAPABILITIES: Record<CapabilityId, CapabilityDef> = {
  memory: { id: "memory", label: "跨事项经验（M6）", disableFlag: "--disable-experience-learning", forensicTool: "read_case_sources", consultOn: "find-or-read" },
  "sap-method": { id: "sap-method", label: "SAP 分析方法", disableFlag: "--disable-sap-methods", forensicTool: "read_semantic_context", consultOn: "read", readTargetKind: "sap-method" },
};

export interface CapabilityUsage {
  /** 成功使用该能力（find 或 read 成功）；工具不可用时的失败尝试不算。 */
  consulted: boolean;
  findCalls: number;
  successfulFindCalls: number;
  readCalls: number;
  queries: string[];
  readTargets: Array<{ caseId: string; recordId: string; revision: number }>;
  successfulReads: number;
}

/** 通用工具取证：按能力语义统计 find/read 的成功使用。 */
export function detectCapabilityUsage(events: PiEvent[], def: CapabilityDef): CapabilityUsage {
  const usage: CapabilityUsage = { consulted: false, findCalls: 0, successfulFindCalls: 0, readCalls: 0, queries: [], readTargets: [], successfulReads: 0 };
  const pending = new Map<string, { action: string; target?: any }>();
  for (const event of events) {
    if (event.type === "tool_execution_start" && event.toolName === def.forensicTool) {
      const args = (event.args ?? {}) as { action?: string; query?: string; target?: any };
      const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
      if (args.action === "find") {
        usage.findCalls += 1;
        if (typeof args.query === "string" && args.query.trim()) usage.queries.push(args.query);
        pending.set(id, { action: "find", target: args.target });
      } else if (args.action === "read") {
        usage.readCalls += 1;
        pending.set(id, { action: "read", target: args.target });
      } else {
        pending.set(id, { action: String(args.action ?? ""), target: args.target });
      }
    } else if (event.type === "tool_execution_end") {
      const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
      const call = pending.get(id);
      pending.delete(id);
      if (!call || event.isError !== false) continue;
      if (call.action === "find") {
        usage.successfulFindCalls += 1;
      } else if (call.action === "read") {
        const target = call.target;
        if (def.readTargetKind && target?.kind !== def.readTargetKind) continue;
        usage.successfulReads += 1;
        if (target && typeof target === "object") {
          usage.readTargets.push({
            caseId: String(target.caseId ?? target.methodId ?? ""),
            recordId: String(target.recordId ?? ""),
            revision: Number(target.revision ?? target.version ?? 0),
          });
        }
      }
    }
  }
  usage.consulted = (def.consultOn === "find-or-read" && usage.successfulFindCalls > 0) || usage.successfulReads > 0;
  return usage;
}

export interface SapMethodFixture {
  title: string;
  content: { conditions: string; logic: string; judgment: string; limits: string };
}

export interface SeededSapMethod {
  methodId: string;
  version: number;
  title: string;
}

/** 经 OptraCall API 向评测方法库注入并发布合成 SAP 方法（不碰真实产品）。 */
export async function seedSapMethods(client: OptraCallClient, fixtures: SapMethodFixture[]): Promise<SeededSapMethod[]> {
  const seeded: SeededSapMethod[] = [];
  for (const fixture of fixtures) {
    const created = await client.request("POST", "/api/sap/methods", {
      requestId: randomUUID(), title: fixture.title, content: fixture.content, sources: [],
    });
    const methodId = created?.method?.id ?? created?.methodId;
    const version = created?.version?.version ?? created?.method?.latestVersion ?? 1;
    const contentSha256 = created?.version?.contentSha256 ?? created?.contentSha256;
    if (!methodId || !contentSha256) throw new Error(`OPTRACALL_SAP_SEED_FAILED: 建方法返回缺 methodId/contentSha256：${JSON.stringify(created).slice(0, 200)}`);
    await client.request("POST", `/api/sap/methods/${methodId}/publish`, { requestId: randomUUID(), version, expectedSha256: contentSha256 });
    seeded.push({ methodId, version, title: fixture.title });
  }
  return seeded;
}