/**
 * OptraCall Host 驱动：经产品正常任务入口完成一次受控任务。
 *
 * 启动独立 Host 实例（临时端口、独立 dataRoot/projectsRoot），走
 * 建项目 → 建任务 → 上传资料 → 发消息（202）→ 轮询终态 的正常 HTTP 协议。
 * 不修改产品代码，不连接用户正在运行的试用服务。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface OptraCallHostHandle {
  port: number;
  pid: number;
  sdkVersion: string;
  transportVersion: string;
  /** Host 进程意外退出时 reject；正常 close 不触发。 */
  exited: Promise<Error>;
  close(): Promise<void>;
}

export class OptraCallHostFault extends Error {
  constructor(message: string) { super(message); this.name = "OptraCallHostFault"; }
}

export class OptraCallHttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message); this.name = "OptraCallHttpError"; this.status = status; this.code = code;
  }
}

/** OptraCall 要求 Node 25+；默认用当前解释器，可显式指定。 */
export function resolveOptraCallNode(explicit?: string): string {
  if (!explicit) {
    const major = Number(process.versions.node.split(".")[0]);
    if (major >= 25) return process.execPath;
    throw new Error("OPTRACALL_NODE_TOO_OLD: OptraCall Host 需要 Node.js 25+；用 --optracall-node 指定解释器");
  }
  const probe = spawnSync(explicit, ["--version"], { encoding: "utf8" });
  const major = Number(probe.stdout?.trim().replace(/^v/, "").split(".")[0]);
  if (probe.status !== 0 || !Number.isInteger(major) || major < 25) {
    throw new Error(`OPTRACALL_NODE_TOO_OLD: ${explicit} 不是 Node.js 25+`);
  }
  return explicit;
}

export async function startOptraCallHost(options: {
  codeRoot: string;
  dataRoot: string;
  projectsRoot: string;
  nodePath?: string;
  logPath: string;
  startupTimeoutMs?: number;
  /** 额外 Host 启动 flag（如 --disable-experience-learning），承载能力开关唯一变量。 */
  extraArgs?: string[];
}): Promise<OptraCallHostHandle> {
  const nodePath = options.nodePath ?? resolveOptraCallNode();
  const log = createWriteStream(options.logPath, { flags: "a" });
  const child: ChildProcess = spawn(nodePath, [
    "scripts/start-host.mjs", "--port=0",
    `--data-root=${options.dataRoot}`, `--projects-root=${options.projectsRoot}`,
    ...(options.extraArgs ?? []),
  ], { cwd: options.codeRoot, stdio: ["ignore", "pipe", "pipe"] });
  let closed = false;
  let exitError: Error | null = null;
  let rejectExited!: (error: Error) => void;
  const exited = new Promise<Error>((_, reject) => { rejectExited = reject; });
  child.on("exit", (code, signal) => {
    if (closed) return;
    exitError = new OptraCallHostFault(`OPTRACALL_HOST_EXITED: code=${code} signal=${signal}`);
    rejectExited(exitError);
  });
  child.stderr?.on("data", chunk => log.write(chunk));

  const ready = await new Promise<{ port: number; sdkVersion: string; transportVersion: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new OptraCallHostFault("OPTRACALL_HOST_START_TIMEOUT")), options.startupTimeoutMs ?? 30_000);
    const fail = (error: Error) => { clearTimeout(timer); reject(error); };
    let buffer = "";
    const onData = (chunk: Buffer) => {
      log.write(chunk);
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try {
          const value = JSON.parse(line) as { kind?: string; port?: number; sdkVersion?: string; transportVersion?: string };
          if (value.kind === "host-ready" && Number.isInteger(value.port)) {
            clearTimeout(timer);
            child.stdout?.off("data", onData);
            resolve({ port: value.port!, sdkVersion: value.sdkVersion ?? "", transportVersion: value.transportVersion ?? "" });
            return;
          }
        } catch { /* 非 JSON 启动噪声只进日志 */ }
      }
    };
    child.stdout?.on("data", onData);
    child.once("exit", () => fail(exitError ?? new OptraCallHostFault("OPTRACALL_HOST_EXITED")));
    child.once("error", error => fail(new OptraCallHostFault(`OPTRACALL_HOST_SPAWN: ${error.message}`)));
  });
  const client = new OptraCallClient(ready.port);
  await client.health();

  return {
    port: ready.port,
    pid: child.pid!,
    sdkVersion: ready.sdkVersion,
    transportVersion: ready.transportVersion,
    exited,
    async close() {
      closed = true;
      if (child.exitCode !== null || child.signalCode !== null) { log.end(); return; }
      child.kill("SIGTERM");
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); }, 10_000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
      log.end();
    },
  };
}

export interface OptraCallConfigurationInput {
  id?: string;
  name: string;
  provider: string;
  api: "openai-completions" | "anthropic-messages";
  baseUrl: string;
  model: string;
  apiKey: string;
  thinkingLevel?: string;
}

export interface OptraCallProjectRun {
  id: string;
  status: "running" | "completed" | "cancelled" | "failed" | "interrupted";
  startedAt: string;
  settledAt?: string;
  diagnostic?: unknown;
}

interface ProjectRecord { id: string; rootPath: string; tasks: Array<{ id: string; lastRun?: OptraCallProjectRun; sessionFile?: string; sessionDirectory: string }> }

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class OptraCallClient {
  readonly port: number;
  private readonly fetchImpl: FetchLike;
  constructor(port: number, fetchImpl?: FetchLike) {
    this.port = port;
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async request(method: string, path: string, body?: unknown): Promise<any> {
    let response: Response;
    try {
      response = await this.fetchImpl(`http://127.0.0.1:${this.port}${path}`, {
        method,
        headers: {
          "x-optracall-client": "1",
          origin: `http://127.0.0.1:${this.port}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new OptraCallHostFault(`OPTRACALL_HOST_UNREACHABLE: ${(error as Error).message}`);
    }
    const text = await response.text();
    let value: any = null;
    try { value = text ? JSON.parse(text) : null; } catch { /* 非 JSON 错误体 */ }
    if (!response.ok) {
      throw new OptraCallHttpError(response.status, String(value?.code ?? "unknown"), String(value?.message ?? text.slice(0, 300)));
    }
    return value;
  }

  health(): Promise<{ status: string; sdkVersion?: string }> { return this.request("GET", "/api/health"); }

  async putConfiguration(input: OptraCallConfigurationInput): Promise<{ id: string; revision: number; provider: string; model: string; baseUrl: string; api: string; thinkingLevel?: string }> {
    const { configuration } = await this.request("PUT", "/api/configuration", input);
    return configuration;
  }

  async createProject(name: string, configurationId: string): Promise<ProjectRecord> {
    const { project } = await this.request("POST", "/api/projects", { name, configurationId });
    return project;
  }

  async createTask(projectId: string, name: string, configurationId: string): Promise<ProjectRecord["tasks"][number]> {
    const { task } = await this.request("POST", `/api/projects/${projectId}/tasks`, { name, configurationId });
    return task;
  }

  async uploadFile(projectId: string, name: string, bytes: Buffer, directory: "010_draw" | "020_clean"): Promise<{ path: string; sha256: string }> {
    const { file } = await this.request("POST", `/api/projects/${projectId}/files/upload`, { name, content: bytes.toString("base64"), directory });
    return file;
  }

  async getProject(projectId: string): Promise<ProjectRecord> {
    const { project } = await this.request("GET", `/api/projects/${projectId}`);
    return project;
  }

  async sendMessage(projectId: string, taskId: string, text: string, requestId: string, caseContext?: { caseId: string; caseRevision: number; projectWorkRevision: number; selectedReferenceIds: string[] }): Promise<void> {
    await this.request("POST", `/api/projects/${projectId}/tasks/${taskId}/messages`, { requestId, text, ...(caseContext ? { caseContext } : {}) });
  }

  async stopTask(projectId: string, taskId: string): Promise<void> {
    await this.request("POST", `/api/projects/${projectId}/tasks/${taskId}/stop`, {});
  }

  /** 初始化 Case 存储（memory Fixture 注入前须先建库）。 */
  async initializeCaseStore(): Promise<void> {
    await this.request("POST", "/api/cases/storage/initialize", {});
  }

  /** 轮询任务 lastRun 直到本轮终态；超时先 stop 再返回 timedOut。Host 退出抛 HostFault。 */
  async waitTerminal(projectId: string, taskId: string, requestId: string, options: {
    timeoutMs?: number;
    pollMs?: number;
    signal?: AbortSignal;
    hostExited: Promise<Error>;
  }): Promise<{ lastRun: OptraCallProjectRun | null; timedOut: boolean }> {
    const startedAt = Date.now();
    const pollMs = options.pollMs ?? 500;
    for (;;) {
      if (options.signal?.aborted) {
        await this.stopTask(projectId, taskId).catch(() => {});
        throw new OptraCallHostFault("OPTRACALL_INTERRUPTED");
      }
      const project = await this.getProject(projectId);
      const task = project.tasks.find(item => item.id === taskId);
      if (!task) throw new OptraCallHostFault("OPTRACALL_TASK_MISSING");
      if (task.lastRun?.id === requestId && task.lastRun.status !== "running") {
        return { lastRun: task.lastRun, timedOut: false };
      }
      if (options.timeoutMs !== undefined && Date.now() - startedAt >= options.timeoutMs) {
        await this.stopTask(projectId, taskId).catch(() => {});
        return { lastRun: task.lastRun ?? null, timedOut: true };
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, pollMs);
        options.hostExited.then(
          () => {},
          error => { clearTimeout(timer); reject(error instanceof Error ? error : new OptraCallHostFault(String(error))); },
        );
      });
    }
  }
}

export function newRequestId(): string {
  return randomUUID();
}