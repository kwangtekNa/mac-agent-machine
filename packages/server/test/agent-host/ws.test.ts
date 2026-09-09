import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseServerEvent, type ServerEvent, type Session } from "@mam/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startAgentHost, type AgentHostHandle } from "../../src/agent-host/server.js";
import { FakeAdapter } from "../../src/agents/fake/index.js";
import { H, makeFixture, type Fixture } from "./helpers.js";

let fx: Fixture;
let host: AgentHostHandle;
let sock: string;

beforeEach(async () => {
  fx = await makeFixture();
  sock = join(fx.tmp, "a.sock");
  await writeFile(sock, ""); // stale 소켓 파일
  host = await startAgentHost({ socketPath: sock, dataDir: join(fx.home, ".mam"), adapters: { claude: new FakeAdapter() }, workspaceRoot: fx.workspaceRoot });
});

afterEach(async () => {
  await host.close();
  await fx.cleanup();
});

type Pred = (e: ServerEvent) => boolean;

function connect(id: string, since?: number, headers: Record<string, string> = H) {
  const url = `ws+unix://${sock}:/api/v1/sessions/${id}/ws${since === undefined ? "" : `?since=${since}`}`;
  const ws = new WebSocket(url, { headers });
  const events: ServerEvent[] = [];
  const waiters: Array<{ pred: Pred; resolve: (e: ServerEvent) => void }> = [];
  ws.on("message", (data) => {
    events.push(parseServerEvent(JSON.parse(data.toString())));
    for (const w of waiters.splice(0)) {
      const hit = events.find(w.pred);
      if (hit) w.resolve(hit);
      else waiters.push(w);
    }
  });
  const waitFor = (pred: Pred, timeoutMs = 5000): Promise<ServerEvent> => {
    const hit = events.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("waitFor timeout")), timeoutMs);
      waiters.push({ pred, resolve: (e) => (clearTimeout(t), resolve(e)) });
    });
  };
  const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
  const send = (m: unknown) => ws.send(JSON.stringify(m));
  return { ws, events, waitFor, closed, send };
}

// NOTE: 실제 host 는 process 사용자의 홈을 샌드박스로 쓰므로 세션은 manager 로 직접 만든다.
async function createSession(): Promise<Session> {
  return host.manager.create({ agent: "claude", cwd: fx.app });
}

function seqs(events: ServerEvent[]): number[] {
  return events.filter((e) => e.seq > 0).map((e) => e.seq);
}

function isIncreasing(nums: number[]): boolean {
  return nums.every((n, i) => i === 0 || n > nums[i - 1]!);
}

describe("agent-host websocket", () => {
  it("listens on a 0600 unix socket after removing the stale file", async () => {
    expect((await stat(sock)).mode & 0o777).toBe(0o600);
    const res = await host.app.inject({ method: "GET", url: "/healthz" });
    expect(res.json().ok).toBe(true);
  });

  it("closes with 4004 for an unknown session", async () => {
    expect(await connect("ses_missing").closed).toBe(4004);
  });

  it("snapshot → turn → approval → completion with monotonic seq; two clients see the same stream", async () => {
    const { id } = await createSession();
    const a = connect(id);
    const b = connect(id);
    const snap = await a.waitFor((e) => e.type === "session.snapshot");
    expect(a.events[0]).toBe(snap);
    expect(snap).toMatchObject({ seq: 0, sessionId: id, items: [], pendingApprovals: [], replayFrom: 0, truncated: false });
    await b.waitFor((e) => e.type === "session.snapshot");

    a.send({ type: "turn.start", text: "run tests" });
    await a.waitFor((e) => e.type === "item.started" && e.item.kind === "user_message");
    await a.waitFor((e) => e.type === "item.delta");
    const req = await a.waitFor((e) => e.type === "approval.requested");
    if (req.type !== "approval.requested") throw new Error("unreachable");

    // 바쁜 세션에 turn.start → recoverable error, 연결 유지
    a.send({ type: "turn.start", text: "again" });
    const busy = await a.waitFor((e) => e.type === "error");
    expect(busy).toMatchObject({ seq: 0, message: "session is busy", recoverable: true });

    b.send({ type: "approval.respond", approvalId: req.approval.approvalId, optionId: "allow" });
    await a.waitFor((e) => e.type === "approval.resolved");
    const done = await a.waitFor((e) => e.type === "turn.completed");
    await a.waitFor((e) => e.type === "session.status" && e.status === "idle" && e.seq > done.seq);
    await b.waitFor((e) => e.type === "session.status" && e.status === "idle" && e.seq > done.seq);

    expect(isIncreasing(seqs(a.events))).toBe(true);
    expect(seqs(b.events)).toEqual(seqs(a.events));

    // since 재접속: 놓친 이벤트만 재생
    const mid = seqs(a.events)[3]!;
    const c = connect(id, mid);
    const csnap = await c.waitFor((e) => e.type === "session.snapshot");
    if (csnap.type !== "session.snapshot") throw new Error("unreachable");
    expect(csnap.replayFrom).toBe(mid);
    expect(csnap.items.every((i) => i.seq > mid)).toBe(true);
    await c.waitFor((e) => e.type === "session.status" && e.status === "idle" && e.seq > done.seq);
    expect(seqs(c.events)).toEqual(seqs(a.events).filter((s) => s > mid));
    for (const ws of [a.ws, b.ws, c.ws]) ws.close();
  });

  it("invalid JSON yields a recoverable error event and the connection stays open", async () => {
    const { id } = await createSession();
    const c = connect(id);
    await c.waitFor((e) => e.type === "session.snapshot");
    c.ws.send("not json");
    expect(await c.waitFor((e) => e.type === "error")).toMatchObject({ seq: 0, recoverable: true });
    c.send({ type: "bogus" });
    await c.waitFor((e) => e.type === "error" && e.message.startsWith("invalid message"));
    c.send({ type: "ping" });
    expect(await c.waitFor((e) => e.type === "pong")).toMatchObject({ seq: 0, sessionId: id });
    c.send({ type: "session.setMode", mode: "plan" });
    await c.waitFor((e) => e.type === "session.status" && e.mode === "plan");
    c.ws.close();
    expect(await c.closed).toBe(1005);
  });
});
