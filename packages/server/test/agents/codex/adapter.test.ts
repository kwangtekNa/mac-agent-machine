import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { TimelineItemSchema } from "@mam/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexAdapter, readCodexAuth, toCodexPolicy, toSandboxPolicy } from "../../../src/agents/codex/adapter.js";
import { JsonRpcPeer } from "../../../src/agents/codex/jsonrpc.js";
import type { CodexProcess, SpawnCodexOptions } from "../../../src/agents/codex/process.js";
import type { AgentEvent } from "../../../src/agents/types.js";
import { makeTmpHome, removeTmp } from "../../helpers/tmp-home.js";

const THREAD = "thr_test_1";
const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

interface Msg { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: unknown }

/** PassThrough 위의 가짜 app-server. 클라이언트 요청에 자동 응답하고, 알림/서버요청을 스크립트대로 보낸다. */
class FakeAppServer {
  readonly toClient = new PassThrough();
  readonly fromClient = new PassThrough();
  readonly received: Msg[] = [];
  readonly child = new EventEmitter() as unknown as ChildProcess;
  spawnOpts: SpawnCodexOptions | undefined;
  killed = 0;
  private waiters: Array<{ pred: (m: Msg) => boolean; resolve: (m: Msg) => void }> = [];
  private nextId = 1000;
  private buf = "";

  constructor(private readonly threadId = THREAD) {
    this.fromClient.on("data", (c: Buffer) => {
      this.buf += c.toString();
      let i = this.buf.indexOf("\n");
      while (i >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (line.trim()) this.onLine(JSON.parse(line) as Msg);
        i = this.buf.indexOf("\n");
      }
    });
  }

  spawnFn = (opts: SpawnCodexOptions): CodexProcess => {
    this.spawnOpts = opts;
    const peer = new JsonRpcPeer(this.toClient, this.fromClient, { logger, requestTimeoutMs: 2000 });
    return { peer, child: this.child, kill: async () => { this.killed++; } };
  };

  private onLine(m: Msg): void {
    this.received.push(m);
    const idx = this.waiters.findIndex((w) => w.pred(m));
    if (idx >= 0) this.waiters.splice(idx, 1)[0]!.resolve(m);
    if (m.id !== undefined && m.method) this.autoRespond(m);
  }

  private autoRespond(m: Msg): void {
    switch (m.method) {
      case "initialize":
        this.write({ id: m.id, result: { userAgent: "codex/test" } });
        break;
      case "thread/start":
      case "thread/resume":
        this.write({ id: m.id, result: { thread: { id: this.threadId, cwd: (m.params as { cwd: string }).cwd, preview: "", modelProvider: "openai", createdAt: 0, updatedAt: 0, status: { type: "idle" }, path: "", cliVersion: "0", source: "vscode", gitInfo: null, name: null, turns: [] }, model: "gpt-5", modelProvider: "openai", cwd: "", approvalPolicy: "on-request", sandbox: { type: "readOnly" }, reasoningEffort: null } });
        break;
      case "turn/start": {
        const turnId = `turn_${m.id}`;
        this.write({ id: m.id, result: { turn: { id: turnId, status: "inProgress", items: [], error: null } } });
        this.notify("turn/started", { threadId: this.threadId, turn: { id: turnId, status: "inProgress", items: [], error: null } });
        break;
      }
      case "turn/interrupt":
        this.write({ id: m.id, result: {} });
        break;
      default:
        this.write({ id: m.id, error: { code: -32601, message: `unknown ${m.method}` } });
    }
  }

  write(obj: unknown): void {
    this.toClient.write(`${JSON.stringify(obj)}\n`);
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  /** 서버→클라이언트 요청. 같은 id 의 클라이언트 응답을 돌려준다. */
  request(method: string, params: unknown): Promise<Msg> {
    const id = this.nextId++;
    const reply = this.waitFor((m) => m.id === id && m.method === undefined);
    this.write({ id, method, params });
    return reply;
  }

  waitFor(pred: (m: Msg) => boolean, timeoutMs = 3000): Promise<Msg> {
    const found = this.received.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("waitFor timeout")), timeoutMs);
      this.waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  }

  turnId(): string {
    const req = this.received.find((m) => m.method === "turn/start");
    return `turn_${req?.id}`;
  }

  completeTurn(status = "completed"): void {
    const turnId = this.turnId();
    this.notify("thread/tokenUsage/updated", { threadId: this.threadId, turnId, tokenUsage: { total: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 15 }, last: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 15 } } });
    this.notify("turn/completed", { threadId: this.threadId, turn: { id: turnId, status, items: [], error: null } });
  }

  exit(code: number): void {
    (this.child as unknown as EventEmitter).emit("exit", code, null);
  }
}

async function take(iter: AsyncIterator<AgentEvent>, until: (e: AgentEvent) => boolean, limit = 60): Promise<AgentEvent[]> {
  const got: AgentEvent[] = [];
  while (got.length < limit) {
    const r = await Promise.race([
      iter.next(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timeout after [${got.map((e) => e.type).join(",")}]`)), 3000)),
    ]);
    if (r.done) break;
    got.push(r.value);
    if (until(r.value)) break;
  }
  return got;
}

function items(events: AgentEvent[]) {
  return events.flatMap((e) => (e.type === "item.started" || e.type === "item.completed" ? [{ type: e.type, item: e.item }] : []));
}

function validate(events: AgentEvent[]): void {
  for (const { item } of items(events)) TimelineItemSchema.parse({ ...item, seq: 1 });
}

describe("CodexAdapter (가짜 app-server)", () => {
  let home: string;
  let cwd: string;
  beforeEach(async () => {
    home = await makeTmpHome();
    cwd = join(home, "work", "app");
    await mkdir(cwd, { recursive: true });
  });
  afterEach(async () => {
    await removeTmp(home);
  });

  function make(server: FakeAppServer) {
    return new CodexAdapter({ spawnFn: server.spawnFn, binPath: "/usr/bin/true", home, logger, requestTimeoutMs: 2000 });
  }

  it("모드 매핑은 PROTOCOL 4절을 따르고 sandboxPolicy 는 구조체다", () => {
    expect(toCodexPolicy("ask")).toEqual({ approvalPolicy: "untrusted", sandbox: "workspace-write" });
    expect(toCodexPolicy("auto-edit")).toEqual({ approvalPolicy: "on-request", sandbox: "workspace-write" });
    expect(toCodexPolicy("full-auto")).toEqual({ approvalPolicy: "never", sandbox: "danger-full-access" });
    expect(toCodexPolicy("plan")).toEqual({ approvalPolicy: "on-request", sandbox: "read-only" });
    expect(toSandboxPolicy("workspace-write", "/w")).toMatchObject({ type: "workspaceWrite", writableRoots: ["/w"] });
    expect(toSandboxPolicy("read-only", "/w")).toMatchObject({ type: "readOnly" });
  });

  it("(a) start→turn→agentMessage 델타→completed→turn/completed", async () => {
    const server = new FakeAppServer();
    const session = await make(server).start({ cwd, mode: "plan" });
    const iter = session.events[Symbol.asyncIterator]();
    expect(session.nativeId).toBe(THREAD);
    expect(server.spawnOpts?.cwd).toBe(cwd);
    const methods = server.received.map((m) => m.method);
    expect(methods.indexOf("initialize")).toBe(0);
    expect(methods.indexOf("initialized")).toBeGreaterThan(0);
    expect(methods.indexOf("thread/start")).toBeGreaterThan(methods.indexOf("initialized"));
    const init = server.received[0]!.params as { clientInfo: { name: string } };
    expect(init.clientInfo.name).toBe("mam");
    const startParams = server.received.find((m) => m.method === "thread/start")!.params as Record<string, unknown>;
    expect(startParams).toMatchObject({ cwd, approvalPolicy: "on-request", sandbox: "read-only" });

    const first = await take(iter, (e) => e.type === "status");
    expect(first[0]).toEqual({ type: "native_id", nativeId: THREAD });

    await session.sendTurn({ text: "hi" });
    const turnStart = server.received.find((m) => m.method === "turn/start")!.params as Record<string, unknown>;
    expect(turnStart).toMatchObject({ threadId: THREAD, cwd, approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly" }, input: [{ type: "text", text: "hi", text_elements: [] }] });
    const turnId = server.turnId();
    server.notify("item/started", { threadId: THREAD, turnId, item: { type: "agentMessage", id: "msg_1", text: "", phase: "final_answer" } });
    server.notify("item/agentMessage/delta", { threadId: THREAD, turnId, itemId: "msg_1", delta: "po" });
    server.notify("item/agentMessage/delta", { threadId: THREAD, turnId, itemId: "msg_1", delta: "ng" });
    server.notify("item/completed", { threadId: THREAD, turnId, item: { type: "agentMessage", id: "msg_1", text: "pong", phase: "final_answer" } });
    server.notify("item/started", { threadId: "other-thread", turnId, item: { type: "agentMessage", id: "msg_x", text: "ignored", phase: "final_answer" } });
    server.completeTurn();
    const events = await take(iter, (e) => e.type === "status" && e.status === "idle");
    validate(events);
    const types = events.map((e) => e.type);
    expect(types).toContain("turn.completed");
    const user = items(events).find((i) => i.item.kind === "user_message");
    expect(user?.item.payload).toMatchObject({ text: "hi" });
    // PROTOCOL 스키마가 trn_<ULID> 를 강제하므로 Codex turn id 는 내부에서만 쓴다.
    expect(user?.item.turnId).toMatch(/^trn_[0-9A-HJKMNP-TV-Z]{26}$/);
    const ourTurnId = user?.item.turnId;
    expect(events.some((e) => e.type === "status" && e.status === "running")).toBe(true);
    const started = items(events).find((i) => i.type === "item.started" && i.item.kind === "assistant_message");
    expect(started?.item.status).toBe("running");
    const deltas = events.filter((e) => e.type === "item.delta").map((e) => (e as { delta: string }).delta);
    expect(deltas).toEqual(["po", "ng"]);
    const done = items(events).find((i) => i.type === "item.completed" && i.item.kind === "assistant_message");
    expect(done?.item.payload).toMatchObject({ text: "pong", phase: "final" });
    expect(done?.item.id).toBe(started?.item.id);
    expect(items(events).some((i) => (i.item.payload as { text?: string }).text === "ignored")).toBe(false);
    expect(items(events).some((i) => i.item.kind === "turn_summary")).toBe(true);
    const completed = events.find((e) => e.type === "turn.completed") as Extract<AgentEvent, { type: "turn.completed" }>;
    expect(completed.turnId).toBe(ourTurnId);
    expect(items(events).every((i) => i.item.turnId === ourTurnId)).toBe(true);
    expect(completed.stopReason).toBe("completed");
    expect(completed.usage.outputTokens).toBe(5);
    expect(events.at(-1)).toMatchObject({ type: "status", status: "idle" });
    await session.close();
    expect(server.killed).toBe(1);
  });

  it("(b) commandExecution 승인 → allow_session → acceptForSession", async () => {
    const server = new FakeAppServer();
    const session = await make(server).start({ cwd, mode: "ask" });
    const iter = session.events[Symbol.asyncIterator]();
    await session.sendTurn({ text: "run tests" });
    const turnId = server.turnId();
    server.notify("item/started", { threadId: THREAD, turnId, item: { type: "commandExecution", id: "call_1", command: "npm test", cwd, status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null, processId: null } });
    const reply = server.request("item/commandExecution/requestApproval", { threadId: THREAD, turnId, itemId: "call_1", command: "npm test", cwd, reason: "테스트 실행" });
    const events = await take(iter, (e) => e.type === "approval.requested");
    validate(events);
    const req = events.at(-1) as Extract<AgentEvent, { type: "approval.requested" }>;
    expect(req.approval.kind).toBe("command");
    expect(req.approval.title).toBe("npm test");
    expect(req.approval.detail).toContain(cwd);
    expect(req.approval.options.map((o) => o.id)).toEqual(["allow", "allow_session", "deny"]);
    const started = items(events).find((i) => i.item.kind === "approval");
    expect(started?.item.status).toBe("running");
    await session.respondApproval(req.approval.approvalId, "allow_session");
    expect((await reply).result).toEqual({ decision: "acceptForSession" });
    const after = await take(iter, (e) => e.type === "item.completed" && e.item.kind === "approval");
    validate(after);
    const done = items(after).at(-1)!.item as { id: string; payload: { resolution: { optionId: string; by: string } } };
    expect(done.id).toBe(started?.item.id);
    expect(done.payload.resolution).toMatchObject({ optionId: "allow_session", by: "client" });
    await expect(session.respondApproval(req.approval.approvalId, "allow")).rejects.toThrow();
    await session.close();
  });

  it("(c) deny → decline, abort → cancel", async () => {
    const server = new FakeAppServer();
    const session = await make(server).start({ cwd, mode: "ask" });
    const iter = session.events[Symbol.asyncIterator]();
    await session.sendTurn({ text: "x" });
    const turnId = server.turnId();
    const r1 = server.request("item/commandExecution/requestApproval", { threadId: THREAD, turnId, itemId: "c1", command: "sudo reboot", cwd, reason: null });
    const e1 = await take(iter, (e) => e.type === "approval.requested");
    await session.respondApproval((e1.at(-1) as Extract<AgentEvent, { type: "approval.requested" }>).approval.approvalId, "deny");
    expect((await r1).result).toEqual({ decision: "decline" });
    const r2 = server.request("item/commandExecution/requestApproval", { threadId: THREAD, turnId, itemId: "c2", command: "curl x", cwd, reason: null });
    const e2 = await take(iter, (e) => e.type === "approval.requested");
    await session.respondApproval((e2.at(-1) as Extract<AgentEvent, { type: "approval.requested" }>).approval.approvalId, "abort");
    expect((await r2).result).toEqual({ decision: "cancel" });
    await session.close();
  });

  it("(d) fileChange 승인은 같은 itemId 의 패치를 diff 로 싣는다", async () => {
    const server = new FakeAppServer();
    const session = await make(server).start({ cwd, mode: "ask" });
    const iter = session.events[Symbol.asyncIterator]();
    await session.sendTurn({ text: "edit" });
    const turnId = server.turnId();
    server.notify("item/started", { threadId: THREAD, turnId, item: { type: "fileChange", id: "fc_1", changes: [{ path: join(cwd, "src/a.ts"), kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-old\n+new\n" }], status: "inProgress" } });
    const reply = server.request("item/fileChange/requestApproval", { threadId: THREAD, turnId, itemId: "fc_1", reason: null, grantRoot: null });
    const events = await take(iter, (e) => e.type === "approval.requested");
    validate(events);
    const change = items(events).find((i) => i.item.kind === "file_change");
    expect(change?.item.payload).toMatchObject({ files: [{ path: "src/a.ts", kind: "modify" }] });
    const req = events.at(-1) as Extract<AgentEvent, { type: "approval.requested" }>;
    expect(req.approval.kind).toBe("file_change");
    expect(req.approval.title).toContain("src/a.ts");
    expect(req.approval.diff).toContain("+new");
    await session.respondApproval(req.approval.approvalId, "allow");
    expect((await reply).result).toEqual({ decision: "accept" });
    await session.close();
  });

  it("(e) requestUserInput 왕복", async () => {
    const server = new FakeAppServer();
    const session = await make(server).start({ cwd, mode: "ask" });
    const iter = session.events[Symbol.asyncIterator]();
    await session.sendTurn({ text: "ask me" });
    const turnId = server.turnId();
    const reply = server.request("item/tool/requestUserInput", { threadId: THREAD, turnId, itemId: "t1", questions: [
      { id: "name", header: "Name", question: "What is your name?", isOther: false, isSecret: false, options: null },
      { id: "color", header: "Color", question: "Pick one", isOther: false, isSecret: false, options: [{ label: "red", description: "" }, { label: "blue", description: "" }] },
    ] });
    const events = await take(iter, (e) => e.type === "approval.requested");
    validate(events);
    const req = events.at(-1) as Extract<AgentEvent, { type: "approval.requested" }>;
    expect(req.approval.kind).toBe("user_input");
    expect(req.approval.options.map((o) => o.id)).toEqual(["submit", "cancel"]);
    expect(req.approval.inputFields.map((f) => [f.id, f.type])).toEqual([["name", "text"], ["color", "choice"]]);
    expect(req.approval.inputFields[1]?.choices).toEqual(["red", "blue"]);
    await session.respondApproval(req.approval.approvalId, "submit", { name: "Bob", color: "blue" });
    expect((await reply).result).toEqual({ answers: { name: { answers: ["Bob"] }, color: { answers: ["blue"] } } });
    await session.close();
  });

  it("(f) resumeNativeId 가 있으면 thread/resume 를 호출한다", async () => {
    const server = new FakeAppServer();
    const session = await make(server).start({ cwd, mode: "ask", resumeNativeId: THREAD });
    expect(session.nativeId).toBe(THREAD);
    expect(server.received.some((m) => m.method === "thread/start")).toBe(false);
    const resume = server.received.find((m) => m.method === "thread/resume")!.params as Record<string, unknown>;
    expect(resume).toMatchObject({ threadId: THREAD, cwd, approvalPolicy: "untrusted", sandbox: "workspace-write" });
    await session.close();
  });

  it("(g) interrupt → turn/interrupt, setMode 는 다음 turn/start 에 반영", async () => {
    const server = new FakeAppServer();
    const session = await make(server).start({ cwd, mode: "ask" });
    const iter = session.events[Symbol.asyncIterator]();
    await take(iter, (e) => e.type === "status"); // native_id + 초기 idle 소비
    await session.sendTurn({ text: "long task" });
    const turnId = server.turnId();
    await session.interrupt();
    const intr = server.received.find((m) => m.method === "turn/interrupt")!.params;
    expect(intr).toEqual({ threadId: THREAD, turnId });
    server.completeTurn("interrupted");
    const events = await take(iter, (e) => e.type === "status" && e.status === "idle");
    const completed = events.find((e) => e.type === "turn.completed") as Extract<AgentEvent, { type: "turn.completed" }>;
    expect(completed.stopReason).toBe("interrupted");
    await session.setMode("plan");
    await session.sendTurn({ text: "again" });
    const second = server.received.filter((m) => m.method === "turn/start").at(-1)!.params as Record<string, unknown>;
    expect(second).toMatchObject({ approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly" } });
    await session.close();
  });

  it("(h) 프로세스가 예기치 않게 종료되면 error{recoverable:false} 후 events 가 끝난다", async () => {
    const server = new FakeAppServer();
    const session = await make(server).start({ cwd, mode: "ask" });
    const iter = session.events[Symbol.asyncIterator]();
    await session.sendTurn({ text: "x" });
    const turnId = server.turnId();
    const pending = server.request("item/commandExecution/requestApproval", { threadId: THREAD, turnId, itemId: "c1", command: "ls", cwd, reason: null });
    await take(iter, (e) => e.type === "approval.requested");
    server.exit(1);
    const events = await take(iter, (e) => e.type === "error");
    expect(events.at(-1)).toMatchObject({ type: "error", recoverable: false });
    expect(items(events).some((i) => i.type === "item.completed" && i.item.kind === "approval")).toBe(true);
    expect((await pending).result).toEqual({ decision: "cancel" });
    expect((await iter.next()).done).toBe(true);
    await expect(session.sendTurn({ text: "y" })).rejects.toThrow();
  });

  it("readCodexAuth 는 auth.json 의 id_token 에서 email 을 읽는다", async () => {
    await mkdir(join(home, ".codex"), { recursive: true });
    expect(await readCodexAuth(home)).toEqual({ loggedIn: false, account: null });
    const payload = Buffer.from(JSON.stringify({ email: "alice@example.com" })).toString("base64url");
    await writeFile(join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { id_token: `eyJhbGciOiJSUzI1NiJ9.${payload}.sig` } }));
    expect(await readCodexAuth(home)).toEqual({ loggedIn: true, account: "alice@example.com" });
    await writeFile(join(home, ".codex", "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-x" }));
    expect(await readCodexAuth(home)).toEqual({ loggedIn: true, account: null });
  });
});
