import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCodexLogin } from "../../../src/agent-host/auth/codex-login.js";
import { JsonRpcPeer } from "../../../src/agents/codex/jsonrpc.js";
import type { CodexProcess, spawnCodexAppServer } from "../../../src/agents/codex/process.js";

interface Req { id: number; method: string; params?: unknown }

/** 가짜 app-server: 우리 → 서버 요청을 기록하고, 테스트가 응답/알림을 써 넣는다. */
function makeFakeServer() {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  const requests: Req[] = [];
  let buf = "";
  toServer.on("data", (c: Buffer) => {
    buf += c.toString();
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const msg = JSON.parse(line) as Req;
      if (msg.id !== undefined) requests.push(msg);
      if (msg.method === "initialize") fromServer.write(`${JSON.stringify({ id: msg.id, result: { userAgent: "codex", codexHome: "/tmp" } })}\n`);
      if (msg.method === "account/login/start") fromServer.write(`${JSON.stringify({ id: msg.id, result: { type: "chatgptDeviceCode", loginId: "lg_1", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGH" } })}\n`);
      if (msg.method === "account/login/cancel") fromServer.write(`${JSON.stringify({ id: msg.id, result: { status: "canceled" } })}\n`);
      nl = buf.indexOf("\n");
    }
  });
  const child = new EventEmitter() as CodexProcess["child"];
  const kill = vi.fn(async () => {});
  const peer = new JsonRpcPeer(fromServer, toServer, { logger: { info() {}, warn() {}, error() {} } });
  const proc: CodexProcess = { peer, child, kill };
  const calls: Array<Parameters<typeof spawnCodexAppServer>[0]> = [];
  const spawnFn: typeof spawnCodexAppServer = (opts) => {
    calls.push(opts);
    return proc;
  };
  const notify = (method: string, params: unknown) => fromServer.write(`${JSON.stringify({ method, params })}\n`);
  return { spawnFn, calls, requests, notify, kill, peer };
}

const quiet = { info() {}, warn() {}, error() {} };

afterEach(() => vi.useRealTimers());

describe("startCodexLogin", () => {
  it("device code 응답 → 플로우, completed(success) → done + 프로세스 종료", async () => {
    const s = makeFakeServer();
    const flow = await startCodexLogin({ id: "flw_01J8ZQ4K5N7P9R3S6T8V0W2XF1", home: "/tmp/h", binPath: "/opt/codex", spawnFn: s.spawnFn, logger: quiet });
    expect(s.calls[0]?.binPath).toBe("/opt/codex");
    expect(s.requests.map((r) => r.method)).toEqual(["initialize", "account/login/start"]);
    expect(s.requests[1]?.params).toEqual({ type: "chatgptDeviceCode" });
    expect(flow.url).toBe("https://auth.openai.com/codex/device");
    expect(flow.needsCode).toBe(false);
    expect(flow.instructions).toContain("ABCD-EFGH");
    expect(flow.status).toBe("pending");
    s.notify("account/login/completed", { loginId: "other", success: true, error: null, onboardingEntrypoint: null });
    await new Promise((r) => setTimeout(r, 10));
    expect(flow.status).toBe("pending");
    s.notify("account/login/completed", { loginId: "lg_1", success: true, error: null, onboardingEntrypoint: null });
    await vi.waitFor(() => expect(flow.status).toBe("done"));
    expect(s.kill).toHaveBeenCalled();
  });

  it("completed(success=false) → error + 메시지", async () => {
    const s = makeFakeServer();
    const flow = await startCodexLogin({ id: "flw_01J8ZQ4K5N7P9R3S6T8V0W2XF2", home: "/tmp/h", binPath: "/opt/codex", spawnFn: s.spawnFn, logger: quiet });
    s.notify("account/login/completed", { loginId: "lg_1", success: false, error: "denied", onboardingEntrypoint: null });
    await vi.waitFor(() => expect(flow.status).toBe("error"));
    expect(flow.message).toContain("denied");
    expect(s.kill).toHaveBeenCalled();
  });

  it("타임아웃이면 account/login/cancel 후 종료", async () => {
    vi.useFakeTimers();
    const s = makeFakeServer();
    const p = startCodexLogin({ id: "flw_01J8ZQ4K5N7P9R3S6T8V0W2XF3", home: "/tmp/h", binPath: "/opt/codex", spawnFn: s.spawnFn, logger: quiet, timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(5);
    const flow = await p;
    await vi.advanceTimersByTimeAsync(600);
    expect(flow.status).toBe("error");
    expect(s.requests.at(-1)?.method).toBe("account/login/cancel");
    expect(s.requests.at(-1)?.params).toEqual({ loginId: "lg_1" });
    expect(s.kill).toHaveBeenCalled();
  });
});
