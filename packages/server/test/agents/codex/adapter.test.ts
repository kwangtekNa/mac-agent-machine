import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TimelineItemSchema } from "@mam/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexAdapter, readCodexAuth, toCodexPolicy, toSandboxPolicy } from "../../../src/agents/codex/adapter.js";
import type { AgentEvent } from "../../../src/agents/types.js";
import { FakeAppServer, THREAD, quietLogger as logger, take } from "../../helpers/fake-codex-app-server.js";
import { makeTmpHome, removeTmp } from "../../helpers/tmp-home.js";

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
