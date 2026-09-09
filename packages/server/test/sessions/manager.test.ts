import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseServerEvent, type ServerEvent } from "@mam/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeAdapter, type FakeAdapterOptions } from "../../src/agents/fake/index.js";
import {
  AgentUnavailableError,
  ApprovalAlreadyResolvedError,
  ApprovalNotFoundError,
  InvalidRequestError,
  SessionBusyError,
  SessionClosedError,
} from "../../src/errors.js";
import { SessionManager, type SessionManagerOptions } from "../../src/sessions/manager.js";

const silent = { info() {}, warn() {}, error() {} };

async function setup(opts: { adapter?: FakeAdapterOptions; manager?: Partial<SessionManagerOptions>; dataDir?: string } = {}) {
  const dataDir = opts.dataDir ?? (await mkdtemp(join(tmpdir(), "mam-mgr-")));
  const adapter = new FakeAdapter(opts.adapter);
  const manager = await SessionManager.open({ dataDir, adapters: { claude: adapter }, logger: silent, ...opts.manager });
  return { dataDir, adapter, manager };
}

type Pred = (e: ServerEvent) => boolean;

async function collect(manager: SessionManager, id: string, since = 0) {
  const events: ServerEvent[] = [];
  const waiters: Array<{ pred: Pred; resolve: () => void }> = [];
  const unsubscribe = await manager.subscribe(id, since, (e) => {
    parseServerEvent(e); // 모든 팬아웃 이벤트가 프로토콜 스키마를 만족해야 한다
    events.push(e);
    for (const w of waiters.splice(0)) {
      if (events.some(w.pred)) w.resolve();
      else waiters.push(w);
    }
  });
  const waitFor = (pred: Pred): Promise<void> =>
    events.some(pred) ? Promise.resolve() : new Promise((resolve) => waiters.push({ pred, resolve }));
  return { events, waitFor, unsubscribe };
}

const seqs = (events: ServerEvent[]) => events.map((e) => e.seq);
const contiguous = (events: ServerEvent[], from: number) =>
  seqs(events).every((s, i) => s === from + i);
const isType = (type: ServerEvent["type"]) => (e: ServerEvent) => e.type === type;
const isStatus = (status: string, reason?: string) => (e: ServerEvent) =>
  e.type === "session.status" && e.status === status && (reason === undefined || e.reason === reason);

afterEach(() => vi.useRealTimers());

describe("SessionManager", () => {
  it("create → turn → approval → complete emits the expected sequence with contiguous seq", async () => {
    const { dataDir, manager, adapter } = await setup();
    const session = await manager.create({ agent: "claude", cwd: dataDir, title: "테스트" });
    expect(session.status).toBe("idle");
    expect(session.lastSeq).toBe(1);
    expect(session.nativeId).toBe(adapter.sessions[0]!.nativeId);

    const c = await collect(manager, session.id);
    expect(c.events.map((e) => e.type)).toEqual(["session.status"]);

    await manager.startTurn(session.id, { text: "안녕" });
    await c.waitFor(isType("approval.requested"));
    expect(manager.get(session.id)!.status).toBe("waiting_approval");
    const [approval] = manager.pendingApprovals(session.id);
    expect(approval!.kind).toBe("command");
    expect(manager.get(session.id)!.pendingApprovals).toBe(1);

    await manager.respondApproval(session.id, approval!.approvalId, "allow_session");
    await c.waitFor(isStatus("idle"));
    await c.waitFor(isType("turn.completed"));

    expect(c.events.map((e) => e.type)).toEqual([
      "session.status", // idle (create)
      "session.status", // running
      "item.started", // user_message
      "item.started", // assistant_message
      "item.delta",
      "item.delta",
      "item.delta",
      "item.completed", // assistant_message
      "item.started", // tool_call
      "item.started", // approval item
      "approval.requested",
      "session.status", // waiting_approval
      "approval.resolved",
      "session.status", // running
      "item.completed", // approval item
      "item.completed", // tool_call
      "item.started", // turn_summary
      "turn.completed",
      "session.status", // idle
    ]);
    expect(contiguous(c.events, 1)).toBe(true);
    expect(c.events.every((e) => e.sessionId === session.id)).toBe(true);
    expect(c.events.filter(isType("session.status")).map((e) => (e as { status: string }).status)).toEqual([
      "idle", "running", "waiting_approval", "running", "idle",
    ]);

    const detail = await manager.detail(session.id);
    expect(detail.truncated).toBe(false);
    expect(detail.items.map((i) => i.kind)).toEqual([
      "user_message", "assistant_message", "tool_call", "approval", "turn_summary",
    ]);
    const assistant = detail.items[1]!;
    expect(assistant.kind === "assistant_message" && assistant.payload.text).toBe("안녕하세요. 요청하신 명령을 실행하겠습니다.");
    const tool = detail.items[2]!;
    expect(tool.status).toBe("completed");
    expect(tool.kind === "tool_call" && tool.payload.output).toBe("hi\n");
    expect(tool.seq).toBe(9); // 생성 seq 를 유지한다
    const apr = detail.items[3]!;
    expect(apr.kind === "approval" && apr.payload.resolution?.optionId).toBe("allow_session");
    expect(detail.session.preview).toBe("안녕하세요. 요청하신 명령을 실행하겠습니다.");
    expect(detail.session.pendingApprovals).toBe(0);
    expect(detail.session.lastSeq).toBe(19);
    await manager.shutdown();
  });

  it("fans out to two subscribers and replays `since` from ring buffer and from file", async () => {
    const { dataDir, manager } = await setup({ adapter: { autoApprove: true }, manager: { ringBufferSize: 4 } });
    const s = await manager.create({ agent: "claude", cwd: dataDir });
    const a = await collect(manager, s.id);
    const b = await collect(manager, s.id);
    await manager.startTurn(s.id, { text: "hi" });
    await a.waitFor(isType("turn.completed"));
    await b.waitFor(isType("turn.completed"));
    await a.waitFor(isStatus("idle"));
    expect(seqs(b.events)).toEqual(seqs(a.events));
    expect(a.events.some(isType("approval.requested"))).toBe(false);
    const last = manager.get(s.id)!.lastSeq;

    const fromRing = await collect(manager, s.id, last - 2); // 링버퍼(4개) 안
    expect(seqs(fromRing.events)).toEqual([last - 1, last]);
    const fromFile = await collect(manager, s.id, 2); // 링버퍼 밖 → 파일
    expect(seqs(fromFile.events)).toEqual(seqs(a.events).filter((n) => n > 2));
    expect(contiguous(fromFile.events, 3)).toBe(true);
    await manager.shutdown();
  });

  it("approval: first response wins, second is rejected, unknown id is not found", async () => {
    const { dataDir, manager } = await setup();
    const s = await manager.create({ agent: "claude", cwd: dataDir });
    const c = await collect(manager, s.id);
    await manager.startTurn(s.id, { text: "go" });
    await c.waitFor(isType("approval.requested"));
    const id = manager.pendingApprovals(s.id)[0]!.approvalId;
    await expect(manager.respondApproval(s.id, id, "nope")).rejects.toBeInstanceOf(InvalidRequestError);
    await Promise.all([
      manager.respondApproval(s.id, id, "allow"),
      expect(manager.respondApproval(s.id, id, "deny")).rejects.toBeInstanceOf(ApprovalAlreadyResolvedError),
    ]);
    await expect(manager.respondApproval(s.id, id, "allow")).rejects.toBeInstanceOf(ApprovalAlreadyResolvedError);
    await expect(manager.respondApproval(s.id, "apr_01J8ZQ4K5N7P9R3S6T8V0W2XE1", "allow")).rejects.toBeInstanceOf(ApprovalNotFoundError);
    await c.waitFor(isType("turn.completed"));
    expect(c.events.filter(isType("approval.resolved"))).toHaveLength(1);
    await manager.shutdown();
  });

  it("approval: deny fails the tool call, abort ends the turn without turn.completed", async () => {
    const { dataDir, manager } = await setup();
    const s = await manager.create({ agent: "claude", cwd: dataDir });
    const c = await collect(manager, s.id);

    await manager.startTurn(s.id, { text: "deny me" });
    await c.waitFor(isType("approval.requested"));
    await manager.respondApproval(s.id, manager.pendingApprovals(s.id)[0]!.approvalId, "deny", undefined, "위험함");
    await c.waitFor(isType("turn.completed"));
    await c.waitFor(isStatus("idle"));
    const tool = (await manager.detail(s.id)).items.find((i) => i.kind === "tool_call")!;
    expect(tool.status).toBe("failed");
    expect(tool.kind === "tool_call" && tool.payload.output).toBe("위험함");

    const firstTurnLastSeq = manager.get(s.id)!.lastSeq;
    await manager.startTurn(s.id, { text: "abort me" });
    await c.waitFor((e) => e.type === "approval.requested" && e.seq > firstTurnLastSeq);
    const before = c.events.length;
    await manager.respondApproval(s.id, manager.pendingApprovals(s.id)[0]!.approvalId, "abort");
    await c.waitFor(isStatus("idle", "aborted"));
    const tail = c.events.slice(before);
    expect(tail.some(isType("turn.completed"))).toBe(false);
    const tools = (await manager.detail(s.id)).items.filter((i) => i.kind === "tool_call");
    expect(tools.at(-1)!.status).toBe("cancelled");
    expect(manager.get(s.id)!.status).toBe("idle");
    await manager.shutdown();
  });

  it("restart: reopening the same dataDir restores sessions, detail() and continues seq", async () => {
    const { dataDir, manager } = await setup({ adapter: { autoApprove: true } });
    const s = await manager.create({ agent: "claude", cwd: dataDir, title: "재시작" });
    const c = await collect(manager, s.id);
    await manager.startTurn(s.id, { text: "first" });
    await c.waitFor(isType("turn.completed"));
    await c.waitFor(isStatus("idle"));
    const before = manager.get(s.id)!;
    await manager.shutdown();

    const second = await setup({ dataDir, adapter: { autoApprove: true } });
    const listed = second.manager.list();
    expect(listed.map((x) => x.id)).toEqual([s.id]);
    expect(listed[0]).toMatchObject({ title: "재시작", status: "idle", lastSeq: before.lastSeq, nativeId: before.nativeId });
    const detail = await second.manager.detail(s.id);
    expect(detail.items.map((i) => i.kind)).toEqual(["user_message", "assistant_message", "tool_call", "turn_summary"]);

    const c2 = await collect(second.manager, s.id, before.lastSeq - 3); // 파일 재생
    expect(seqs(c2.events)).toEqual([before.lastSeq - 2, before.lastSeq - 1, before.lastSeq]);
    await second.manager.startTurn(s.id, { text: "second" });
    await c2.waitFor(isType("turn.completed"));
    expect(contiguous(c2.events, before.lastSeq - 2)).toBe(true);
    expect(second.adapter.startCalls[0]).toMatchObject({ cwd: dataDir, mode: "ask", resumeNativeId: before.nativeId });
    await second.manager.shutdown();
  });

  it("idle timeout closes the adapter session when no subscribers; next startTurn resumes by nativeId", async () => {
    vi.useFakeTimers();
    const { dataDir, manager, adapter } = await setup({ adapter: { autoApprove: true }, manager: { idleTimeoutMs: 1_000 } });
    const s = await manager.create({ agent: "claude", cwd: dataDir });
    const c = await collect(manager, s.id);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(adapter.sessions[0]!.closed).toBe(false); // 구독자가 있으면 유지
    c.unsubscribe();
    await vi.advanceTimersByTimeAsync(999);
    expect(adapter.sessions[0]!.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(adapter.sessions[0]!.closed).toBe(true);
    expect(manager.get(s.id)!.status).toBe("idle");
    const c2 = await collect(manager, s.id);
    expect(c2.events.at(-1)).toMatchObject({ type: "session.status", status: "idle", reason: "idle_timeout" });

    await manager.startTurn(s.id, { text: "again" });
    expect(adapter.startCalls).toHaveLength(2);
    expect(adapter.startCalls[1]!.resumeNativeId).toBe(s.nativeId);
    await c2.waitFor(isType("turn.completed"));
    await manager.shutdown();
  });

  it("startTurn while running → SessionBusyError; interrupt resolves pending approvals and returns to idle", async () => {
    const { dataDir, manager } = await setup();
    const s = await manager.create({ agent: "claude", cwd: dataDir });
    const c = await collect(manager, s.id);
    await manager.startTurn(s.id, { text: "busy" });
    await expect(manager.startTurn(s.id, { text: "again" })).rejects.toBeInstanceOf(SessionBusyError);
    await c.waitFor(isType("approval.requested"));
    await expect(manager.startTurn(s.id, { text: "again" })).rejects.toBeInstanceOf(SessionBusyError);
    await manager.interrupt(s.id);
    await c.waitFor(isStatus("idle", "interrupted"));
    expect(c.events.filter(isType("approval.resolved"))).toMatchObject([{ optionId: "abort", by: "system" }]);
    expect(manager.pendingApprovals(s.id)).toEqual([]);
    const items = (await manager.detail(s.id)).items;
    expect(items.filter((i) => i.status === "cancelled").map((i) => i.kind).sort()).toEqual(["approval", "tool_call"]);
    await manager.shutdown();
  });

  it("'fail' text → error event, error status, then the next turn resumes the adapter", async () => {
    const { dataDir, manager, adapter } = await setup({ adapter: { autoApprove: true } });
    const s = await manager.create({ agent: "claude", cwd: dataDir });
    const c = await collect(manager, s.id);
    await manager.startTurn(s.id, { text: "please fail" });
    await c.waitFor(isStatus("error"));
    expect(c.events.some((e) => e.type === "error" && e.recoverable === false)).toBe(true);
    expect(manager.get(s.id)!.status).toBe("error");
    await manager.startTurn(s.id, { text: "recover" });
    await c.waitFor(isType("turn.completed"));
    expect(adapter.startCalls).toHaveLength(2);
    expect(adapter.startCalls[1]!.resumeNativeId).toBe(s.nativeId);
    await manager.shutdown();
  });

  it("create validates adapter and cwd; patch/setMode emit status with new mode; close rejects further turns", async () => {
    const { dataDir, manager, adapter } = await setup({ adapter: { autoApprove: true } });
    await expect(manager.create({ agent: "codex", cwd: dataDir })).rejects.toBeInstanceOf(AgentUnavailableError);
    await expect(manager.create({ agent: "claude", cwd: join(dataDir, "nope") })).rejects.toBeInstanceOf(InvalidRequestError);
    const s = await manager.create({ agent: "claude", cwd: dataDir });
    const c = await collect(manager, s.id);
    const patched = await manager.patch(s.id, { title: "새 제목", mode: "plan" });
    expect(patched).toMatchObject({ title: "새 제목", mode: "plan" });
    expect(c.events.at(-1)).toMatchObject({ type: "session.status", status: "idle", mode: "plan", reason: "mode_changed" });
    expect(adapter.sessions[0]!.modes).toEqual(["plan"]);
    expect(manager.list({ cwd: dataDir, status: "idle" })).toHaveLength(1);
    const closed = await manager.close(s.id);
    expect(closed.status).toBe("closed");
    expect(adapter.sessions[0]!.closed).toBe(true);
    expect(c.events.at(-1)).toMatchObject({ type: "session.status", status: "closed" });
    await expect(manager.startTurn(s.id, { text: "x" })).rejects.toBeInstanceOf(SessionClosedError);
    expect(manager.list({ status: "closed" })).toHaveLength(1);
    await manager.shutdown();
  });
});
