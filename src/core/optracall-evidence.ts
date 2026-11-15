/**
 * OptraCall 取证：native 会话 JSONL → 指标与事件流；项目终态 → 证据落盘。
 *
 * native JSONL 是权威原始证据（整份拷贝留痕）；events.json 另存与受控会话
 * 同形的 PiEvent 流，供激活取证、评委匿名计数与离线复核复用。
 * 聊天最终文本只是过程记录；计分载体是冻结交付路径的采集快照。
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { emptyMetrics, type PiEvent, type PiRunMetrics } from "./pi.ts";

export interface NativeUsageBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  sdkCostTotal: number;
}

export interface NativeSessionParse {
  sessionId: string | null;
  entryCount: number;
  metrics: PiRunMetrics;
  events: PiEvent[];
  usage: NativeUsageBreakdown;
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } =>
      typeof block === "object" && block !== null && (block as { type?: string }).type === "text" && typeof (block as { text?: unknown }).text === "string")
    .map(block => block.text).join("\n").trim();
}

/** 解析 Pi SDK v3 native 会话 JSONL。cwd 用于把相对读取路径归一为绝对路径。 */
export function parseNativeSession(text: string, cwd: string): NativeSessionParse {
  const metrics = emptyMetrics();
  const events: PiEvent[] = [];
  const usage: NativeUsageBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, sdkCostTotal: 0 };
  const pendingReads = new Map<string, string>();
  let sessionId: string | null = null;
  let entryCount = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    entryCount += 1;
    if (entry?.type === "session") { sessionId = typeof entry.id === "string" ? entry.id : null; continue; }
    if (entry?.type !== "message" || !entry.message) continue;
    const message = entry.message;
    if (message.role === "assistant") {
      events.push({ type: "message_end", message });
      const usageValue = message.usage;
      if (usageValue && typeof usageValue === "object") {
        metrics.totalTokens += typeof usageValue.totalTokens === "number" ? usageValue.totalTokens : 0;
        metrics.totalCost += typeof usageValue.cost?.total === "number" ? usageValue.cost.total : 0;
        usage.input += typeof usageValue.input === "number" ? usageValue.input : 0;
        usage.output += typeof usageValue.output === "number" ? usageValue.output : 0;
        usage.cacheRead += typeof usageValue.cacheRead === "number" ? usageValue.cacheRead : 0;
        usage.cacheWrite += typeof usageValue.cacheWrite === "number" ? usageValue.cacheWrite : 0;
        usage.totalTokens += typeof usageValue.totalTokens === "number" ? usageValue.totalTokens : 0;
        usage.sdkCostTotal += typeof usageValue.cost?.total === "number" ? usageValue.cost.total : 0;
      }
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block?.type !== "toolCall") continue;
          metrics.toolCalls += 1;
          metrics.toolNames.push(String(block.name ?? "unknown"));
          events.push({ type: "tool_execution_start", toolName: block.name, args: block.arguments, toolCallId: block.id });
          if (block.name === "read" && typeof block.arguments?.path === "string" && typeof block.id === "string") {
            pendingReads.set(block.id, resolve(cwd, block.arguments.path));
          }
        }
        const textOut = extractText(message.content);
        if (textOut) metrics.output = textOut;
      }
    } else if (message.role === "toolResult") {
      const id = typeof message.toolCallId === "string" ? message.toolCallId : "";
      events.push({ type: "tool_execution_end", toolCallId: id, toolName: message.toolName, isError: message.isError === true });
      const path = pendingReads.get(id);
      pendingReads.delete(id);
      if (path && message.isError === false) metrics.readPaths.push(path);
    }
  }
  return { sessionId, entryCount, metrics, events, usage };
}

export interface CaseEvidenceOptions {
  caseDir: string;
  projectDir: string;
  dataRoot: string;
  projectId: string;
  taskId: string;
  requestId: string;
  sessionFile: string | null;
  hostPort: number;
  lastRun: unknown;
}

export interface CaseEvidence {
  nativeSession: { path: string; sha256: string; bytes: number } | null;
  usage: { totalTokens: number; sdkCostTotal: number };
  copiedFiles: number;
  skippedLargeFiles: string[];
}

const MAX_COPY_BYTES = 8 * 1024 * 1024;

function walkFiles(root: string, base = root): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) out.push(...walkFiles(path, base));
    else if (entry.isFile()) out.push(relative(base, path));
  }
  return out;
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** 终态后只读采集：020/060 内容入 workspace，010 与全树哈希留痕，native 会话整份拷贝。 */
export function collectCaseEvidence(options: CaseEvidenceOptions): CaseEvidence {
  const optracallDir = join(options.caseDir, "optracall");
  mkdirSync(optracallDir, { recursive: true });
  const workspace = join(options.caseDir, "workspace");
  mkdirSync(workspace, { recursive: true });

  const tree: Array<{ path: string; bytes: number; sha256: string; copied: boolean }> = [];
  const skippedLargeFiles: string[] = [];
  let copiedFiles = 0;
  for (const directory of ["010_draw", "020_clean", "060_reports"]) {
    for (const rel of walkFiles(join(options.projectDir, directory)).sort()) {
      const from = join(options.projectDir, directory, rel);
      const stat = lstatSync(from);
      const record = { path: `${directory}/${rel}`, bytes: stat.size, sha256: hashFile(from), copied: false };
      // 010 是冻结输入，只留哈希；020/060 是分析与交付，拷贝内容（超大文件只留哈希）。
      if (directory !== "010_draw" && stat.size <= MAX_COPY_BYTES && stat.nlink === 1) {
        const to = join(workspace, directory, rel);
        mkdirSync(join(to, ".."), { recursive: true });
        copyFileSync(from, to);
        record.copied = true;
        copiedFiles += 1;
      } else if (directory !== "010_draw" && stat.size > MAX_COPY_BYTES) {
        skippedLargeFiles.push(record.path);
      }
      tree.push(record);
    }
  }
  writeFileSync(join(optracallDir, "project-tree.json"), JSON.stringify(tree, null, 2), "utf8");

  let nativeSession: CaseEvidence["nativeSession"] = null;
  let usage = { totalTokens: 0, sdkCostTotal: 0 };
  if (options.sessionFile && existsSync(options.sessionFile)) {
    const bytes = readFileSync(options.sessionFile);
    const target = join(optracallDir, "native-session.jsonl");
    writeFileSync(target, bytes, { flag: "wx" });
    nativeSession = { path: options.sessionFile, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
    const parsed = parseNativeSession(bytes.toString("utf8"), join(options.projectDir, "020_clean"));
    usage = { totalTokens: parsed.metrics.totalTokens, sdkCostTotal: parsed.metrics.totalCost };
  }
  const metadata = join(options.dataRoot, "projects", options.projectId, "project.json");
  if (existsSync(metadata)) copyFileSync(metadata, join(optracallDir, "project.json"));
  writeFileSync(join(optracallDir, "case.json"), JSON.stringify({
    projectId: options.projectId, taskId: options.taskId, requestId: options.requestId,
    sessionFile: options.sessionFile, hostPort: options.hostPort, lastRun: options.lastRun,
    projectDir: options.projectDir, dataRoot: options.dataRoot,
  }, null, 2), "utf8");
  writeFileSync(join(optracallDir, "usage.json"), JSON.stringify({
    ...usage, cashBill: "unknown",
    note: "tokens 与 SDK cost 来自 native 会话；保守等价费用由执行层按冻结费率另计；现金账单未知。",
  }, null, 2), "utf8");
  return { nativeSession, usage, copiedFiles, skippedLargeFiles };
}