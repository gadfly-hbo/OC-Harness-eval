/**
 * OptraCall 复合执行层。
 *
 * subject 侧经 OptraCall 正常任务入口运行；judge 侧复用现有受控 Pi 会话与账本。
 * 实现 EvaluationExecution 接口，runner 的冻结、配对、断言、盲评、结论全部不变。
 * Host 级故障（进程退出、环境漂移、证据持久化失败）停批；单样本终态失败记失败继续。
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { CONTROLLED_BUDGET_POLICY, type NativeModelLimitsByRole } from "./controlled-budget.ts";
import { createControlledExecution, type EvaluationExecution } from "./execution.ts";
import { emptyMetrics, type PiRunOptions, type PiRunResult } from "./pi.ts";
import { verifyOptraCallEnvironments, type OptraCallEnvironments, type OptraCallSide } from "./optracall-env.ts";
import { OptraCallClient, OptraCallHostFault, startOptraCallHost, newRequestId, type FetchLike, type OptraCallConfigurationInput, type OptraCallHostHandle } from "./optracall-driver.ts";
import { collectCaseEvidence, parseNativeSession } from "./optracall-evidence.ts";
import { seedMemoryFixtures, type MemoryFixture } from "./optracall-memory.ts";
import { CAPABILITIES, detectCapabilityUsage, seedSapMethods, type CapabilityId, type SapMethodFixture } from "./optracall-capabilities.ts";
import type { BudgetSnapshot } from "./controlled-budget.ts";

export interface OptraCallTemplateFile {
  name: string;
  directory: "010_draw" | "020_clean";
  bytes: Buffer;
}

export interface OptraCallExecutionOptions {
  mode: "real" | "simulated";
  runRoot: string;
  envs: OptraCallEnvironments;
  model: string;
  judgeModel: string;
  nativeLimits: NativeModelLimitsByRole;
  judgePlannedSessions: number;
  home?: string | undefined;
  configuration: OptraCallConfigurationInput;
  templateFor: (taskId: string) => OptraCallTemplateFile[];
  nodePath?: string | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  /** 离线测试注入；真实运行用默认 Host 启动与受控评委。 */
  hostFactory?: typeof startOptraCallHost;
  judgeExecution?: EvaluationExecution;
  fetchImpl?: FetchLike;
  /** 能力开关模式：两侧 codeRoot 全等，唯一变量是 Host 启动 flag（按 variantId 分侧）。 */
  capabilityToggle?: { baselineArgs: string[]; treatmentArgs: string[] };
  /** 能力 id（memory/sap-method）；缺省 memory。决定取证工具与 Fixture 注入方式。 */
  capabilityId?: CapabilityId;
  /** 通用能力 Fixture（按 capabilityId 解释）；处理侧注入，baseline 不注入。 */
  capabilityFixtures?: Array<Record<string, unknown>>;
  /** memory 测评 Fixture（兼容旧入口；等价 capabilityId=memory + capabilityFixtures）。 */
  memoryFixtures?: MemoryFixture[];
}

interface SideState {
  host: OptraCallHostHandle | null;
  client: OptraCallClient | null;
  configurationId: string | null;
}

const BACKEND = "optracall-host-eval-roots";

export function createOptraCallExecution(options: OptraCallExecutionOptions): EvaluationExecution {
  const { envs, runRoot } = options;
  const judge = options.judgeExecution ?? createControlledExecution({
    runRoot, home: options.home, model: options.model, judgeModel: options.judgeModel,
    plannedSessions: options.judgePlannedSessions, nativeLimits: options.nativeLimits, signal: options.signal,
  });
  const hostFactory = options.hostFactory ?? startOptraCallHost;
  const sides: Record<OptraCallSide, SideState> = {
    baseline: { host: null, client: null, configurationId: null },
    skill: { host: null, client: null, configurationId: null },
  };
  const usedSessions = new Set<string>();
  const seededSides = new Set<OptraCallSide>();
  const ledgerPath = join(runRoot, "optracall-ledger.jsonl");
  let subjectStopped: string | null = null;
  let finalized = false;
  const ledgerRows: unknown[] = [];

  const stop = (reason: string): PiRunResult => {
    subjectStopped ??= reason;
    return {
      exitCode: null, metrics: emptyMetrics(), events: [], stderr: reason, timedOut: false,
      isolation: { verified: false, issues: [reason], backend: BACKEND },
    };
  };

  const appendLedger = (row: unknown) => {
    ledgerRows.push(row);
    try { appendFileSync(ledgerPath, JSON.stringify(row) + "\n", { mode: 0o600 }); }
    catch { throw new OptraCallHostFault("OPTRACALL_LEDGER_PERSISTENCE_FAILED"); }
  };

  const ensureHost = async (side: OptraCallSide): Promise<SideState> => {
    const state = sides[side];
    if (state.host && state.client && state.configurationId) return state;
    const env = envs[side];
    const drift = verifyOptraCallEnvironments(envs);
    if (drift.length) throw new OptraCallHostFault(`OPTRACALL_ENV_DRIFT: ${drift.join("；")}`);
    const host = await hostFactory({
      codeRoot: env.codeRoot, dataRoot: env.dataRoot, projectsRoot: env.projectsRoot,
      nodePath: options.nodePath, logPath: join(runRoot, `optracall-host-${side}.log`),
      extraArgs: options.capabilityToggle
        ? (side === "baseline" ? options.capabilityToggle.baselineArgs : options.capabilityToggle.treatmentArgs)
        : undefined,
    });
    const client = new OptraCallClient(host.port, options.fetchImpl);
    const configuration = await client.putConfiguration(options.configuration);
    state.host = host; state.client = client; state.configurationId = configuration.id;
    return state;
  };

  const runSubject = async (request: PiRunOptions): Promise<PiRunResult> => {
    const capability = options.capabilityToggle;
    const side: OptraCallSide = capability
      ? (request.variantId === "baseline" ? "baseline" : "skill")
      : ((request.skillPaths?.length ?? 0) > 0 ? "skill" : "baseline");
    const env = envs[side];
    if (!capability) {
      const expectedSkillPaths = side === "skill" ? [env.skillPath!] : [];
      if (JSON.stringify(request.skillPaths ?? []) !== JSON.stringify(expectedSkillPaths)) {
        return stop("OPTRACALL_SKILL_IDENTITY_MISMATCH");
      }
    }
    const caseDir = dirname(request.workspaceRoot);
    const state = await ensureHost(side);
    const capId: CapabilityId = options.capabilityId ?? "memory";
    const fixtures = options.capabilityFixtures ?? options.memoryFixtures ?? [];
    if (capability && side === "skill" && fixtures.length && !seededSides.has(side)) {
      if (capId === "sap-method") {
        await seedSapMethods(state.client!, fixtures as unknown as SapMethodFixture[]);
      } else {
        await state.client!.initializeCaseStore();
        seedMemoryFixtures(env.dataRoot, fixtures as unknown as MemoryFixture[]);
      }
      seededSides.add(side);
    }
    const client = state.client!;
    const projectId = (await client.createProject(`eval-${request.sessionId}`, state.configurationId!)).id;
    const task = await client.createTask(projectId, request.sessionId, state.configurationId!);
    for (const file of options.templateFor(request.taskId ?? "")) {
      await client.uploadFile(projectId, file.name, file.bytes, file.directory);
    }
    const requestId = newRequestId();
    const startedAt = Date.now();
    await client.sendMessage(projectId, task.id, request.prompt, requestId);
    const { lastRun, timedOut } = await client.waitTerminal(projectId, task.id, requestId, {
      timeoutMs: options.timeoutMs, signal: options.signal, hostExited: state.host!.exited,
    });
    const project = await client.getProject(projectId);
    const finalTask = project.tasks.find(item => item.id === task.id)!;
    const projectDir = project.rootPath;
    const evidence = collectCaseEvidence({
      caseDir, projectDir, dataRoot: env.dataRoot, projectId, taskId: task.id, requestId,
      sessionFile: finalTask.sessionFile ?? null, hostPort: state.host!.port, lastRun,
    });
    const nativeText = evidence.nativeSession
      ? readFileSync(join(caseDir, "optracall", "native-session.jsonl"), "utf8")
      : "";
    const parsed = parseNativeSession(nativeText, join(projectDir, "020_clean"));
    const memoryUsage = capability ? detectCapabilityUsage(parsed.events, CAPABILITIES[options.capabilityId ?? "memory"]) : undefined;
    if (memoryUsage) {
      writeFileSync(join(caseDir, "optracall", "memory.json"), JSON.stringify(memoryUsage, null, 2), "utf8");
    }

    // 边界核验：项目与会话必须落在本侧评测根内；运行后环境身份不得漂移。
    const issues: string[] = [];
    if (!projectDir.startsWith(env.projectsRoot + sep)) issues.push("项目目录越出评测 projectsRoot");
    if (finalTask.sessionFile && !finalTask.sessionFile.startsWith(env.dataRoot + sep)) issues.push("会话文件越出评测 dataRoot");
    const drift = verifyOptraCallEnvironments(envs);
    if (drift.length) issues.push(...drift.map(item => `环境漂移：${item}`));
    const isolation = { verified: issues.length === 0, issues, backend: BACKEND };

    const completed = lastRun?.status === "completed" && !timedOut;
    const exitCode = completed ? 0 : 1;
    const stderr = completed ? "" : `OptraCall 任务终态 ${lastRun?.status ?? "missing"}${timedOut ? "（超时）" : ""}`;
    const policy = CONTROLLED_BUDGET_POLICY.models.subject;
    const conservativeEquivalentNanoUsd = options.model === policy.model
      ? (parsed.usage.input + parsed.usage.cacheRead + parsed.usage.cacheWrite) * policy.inputNanoUsdPerToken + parsed.usage.output * policy.outputNanoUsdPerToken
      : null;
    appendLedger({
      sessionId: request.sessionId, side, projectId, taskId: task.id, requestId,
      status: lastRun?.status ?? "missing", timedOut, durationMs: Date.now() - startedAt,
      usage: parsed.usage, conservativeEquivalentNanoUsd,
      nativeSession: evidence.nativeSession, isolationVerified: isolation.verified,
    });
    if (drift.length) { subjectStopped ??= `OPTRACALL_ENV_DRIFT: ${drift.join("；")}`; }
    return { exitCode, metrics: parsed.metrics, events: parsed.events, stderr, timedOut, isolation, ...(memoryUsage ? { memoryUsage } : {}) };
  };

  return {
    mode: options.mode,
    isStopped: () => subjectStopped !== null || judge.isStopped(),
    snapshot(): BudgetSnapshot {
      const base = judge.snapshot();
      if (subjectStopped !== null) return { ...base, state: "stopped", stoppedReason: subjectStopped };
      return base;
    },
    async run(role, request: PiRunOptions): Promise<PiRunResult> {
      if (subjectStopped !== null) return stop(subjectStopped);
      if (finalized) return stop("OPTRACALL_EXECUTION_FINALIZED");
      if (role === "judge") return judge.run("judge", request);
      if (role !== "subject") return stop("OPTRACALL_INVALID_ROLE");
      if (typeof request.sessionId !== "string" || usedSessions.has(request.sessionId)) return stop("OPTRACALL_INVALID_SESSION_ID");
      usedSessions.add(request.sessionId);
      try {
        return await runSubject(request);
      } catch (error) {
        const reason = error instanceof OptraCallHostFault ? error.message
          : error instanceof Error ? `OPTRACALL_SUBJECT_FAILED: ${error.message}` : "OPTRACALL_SUBJECT_FAILED";
        return stop(reason);
      }
    },
    async finalize() {
      if (finalized) return;
      finalized = true;
      for (const side of ["baseline", "skill"] as const) {
        try { await sides[side].host?.close(); } catch { /* 收尾失败另记 */ }
      }
      const drift = verifyOptraCallEnvironments(envs);
      try {
        writeFileSync(join(runRoot, "optracall-execution.json"), JSON.stringify({
          schemaVersion: 1, backend: BACKEND, mode: options.mode,
          subjectStopped, sessions: ledgerRows, finalEnvDrift: drift,
        }, null, 2), { flag: "wx" });
      } catch { subjectStopped ??= "OPTRACALL_EXECUTION_RECORD_FAILED"; }
      judge.finalize?.();
    },
  };
}