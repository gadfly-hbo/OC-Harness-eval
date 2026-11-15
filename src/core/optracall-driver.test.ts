import assert from "node:assert/strict";
import { test } from "node:test";

import { OptraCallClient, OptraCallHostFault, OptraCallHttpError, type FetchLike } from "./optracall-driver.ts";

interface Call { method: string; path: string; headers: Record<string, string>; body?: any }

function fakeHost(handler: (call: Call) => { status: number; body: unknown }): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const call: Call = { method: init?.method ?? "GET", path: url.pathname, headers, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const { status, body } = handler(call);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, calls };
}

test("客户端带上产品要求的协议头，非 2xx 映射为 HttpError", async () => {
  const { fetchImpl, calls } = fakeHost(call => {
    if (call.path === "/api/health") return { status: 200, body: { status: "ready", sdkVersion: "1.4.0" } };
    if (call.path === "/api/projects" && call.method === "POST") return { status: 409, body: { code: "configuration_required", message: "请先配置" } };
    return { status: 404, body: { code: "not_found" } };
  });
  const client = new OptraCallClient(4175, fetchImpl);
  const health = await client.health();
  assert.equal(health.sdkVersion, "1.4.0");
  await assert.rejects(() => client.createProject("p", "cfg"), (error: unknown) => error instanceof OptraCallHttpError && error.status === 409 && error.code === "configuration_required");
  assert.equal(calls[0]!.headers["x-optracall-client"], "1");
  assert.equal(calls[1]!.headers.origin, "http://127.0.0.1:4175");
});

test("waitTerminal 轮询到本轮终态即返回", async () => {
  let polls = 0;
  const { fetchImpl } = fakeHost(call => {
    if (call.path.endsWith("/messages")) return { status: 202, body: { requestId: "r1", status: "running" } };
    polls += 1;
    const status = polls < 2 ? "running" : "completed";
    return { status: 200, body: { project: { id: "p1", rootPath: "/x", tasks: [{ id: "t1", sessionDirectory: "/s", lastRun: { id: "r1", status, startedAt: "2026-11-15T00:00:00.000Z" } }] } } };
  });
  const client = new OptraCallClient(1, fetchImpl);
  const result = await client.waitTerminal("p1", "t1", "r1", { pollMs: 1, hostExited: new Promise(() => {}) });
  assert.equal(result.timedOut, false);
  assert.equal(result.lastRun?.status, "completed");
});

test("waitTerminal 超时先 stop 再返回 timedOut", async () => {
  const stops: string[] = [];
  const { fetchImpl } = fakeHost(call => {
    if (call.path.endsWith("/stop")) { stops.push(call.path); return { status: 200, body: { stopped: true } }; }
    return { status: 200, body: { project: { id: "p1", rootPath: "/x", tasks: [{ id: "t1", sessionDirectory: "/s", lastRun: { id: "r1", status: "running", startedAt: "2026-11-15T00:00:00.000Z" } }] } } };
  });
  const client = new OptraCallClient(1, fetchImpl);
  const result = await client.waitTerminal("p1", "t1", "r1", { pollMs: 1, timeoutMs: 5, hostExited: new Promise(() => {}) });
  assert.equal(result.timedOut, true);
  assert.equal(stops.length, 1);
});

test("Host 退出使 waitTerminal 抛 HostFault", async () => {
  const { fetchImpl } = fakeHost(() => ({ status: 200, body: { project: { id: "p1", rootPath: "/x", tasks: [{ id: "t1", sessionDirectory: "/s", lastRun: { id: "r1", status: "running", startedAt: "2026-11-15T00:00:00.000Z" } }] } } }));
  const client = new OptraCallClient(1, fetchImpl);
  const exited = Promise.reject(new OptraCallHostFault("OPTRACALL_HOST_EXITED"));
  exited.catch(() => {});
  await assert.rejects(() => client.waitTerminal("p1", "t1", "r1", { pollMs: 1, hostExited: exited }), /OPTRACALL_HOST_EXITED/);
});

test("网络不可达映射为 HostFault", async () => {
  const fetchImpl: FetchLike = async () => { throw new Error("connect ECONNREFUSED"); };
  const client = new OptraCallClient(1, fetchImpl);
  await assert.rejects(() => client.health(), (error: unknown) => error instanceof OptraCallHostFault && /OPTRACALL_HOST_UNREACHABLE/.test(error.message));
});