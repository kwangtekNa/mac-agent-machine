import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexAdapter } from "../../../src/agents/codex/adapter.js";
import type { AgentEvent } from "../../../src/agents/types.js";
import { FakeAppServer, THREAD, quietLogger as logger, take } from "../../helpers/fake-codex-app-server.js";
import { makeTmpHome, removeTmp } from "../../helpers/tmp-home.js";

const approvalEvents = (events: AgentEvent[]): AgentEvent[] =>
  events.filter((e) => e.type === "approval.requested" || ((e.type === "item.started" || e.type === "item.completed") && e.item.kind === "approval"));

describe("CodexAdapter 권한 (full-auto = never / danger-full-access)", () => {
  let home: string;
  let cwd: string;
  beforeEach(async () => {
    home = await makeTmpHome("mam-codex-perm-");
    cwd = join(home, "work", "app");
    await mkdir(cwd, { recursive: true });
  });
  afterEach(async () => {
    await removeTmp(home);
  });

  function make(server: FakeAppServer) {
    return new CodexAdapter({ spawnFn: server.spawnFn, binPath: "/usr/bin/true", home, logger, requestTimeoutMs: 2000 });
  }

  it("setMode('full-auto') 뒤의 turn/start 는 approvalPolicy never, sandboxPolicy dangerFullAccess 를 쓴다", async () => {
    const server = new FakeAppServer();
    const session = await make(server).start({ cwd, mode: "ask" });
    const iter = session.events[Symbol.asyncIterator]();
    await take(iter, (e) => e.type === "status");
    await session.sendTurn({ text: "first" });
    const first = server.calls("turn/start").at(-1)!.params as Record<string, unknown>;
    expect(first).toMatchObject({ approvalPolicy: "untrusted", sandboxPolicy: { type: "workspaceWrite" } });
    server.completeTurn();
    await take(iter, (e) => e.type === "status" && e.status === "idle");
    await session.setMode("full-auto");
    await session.sendTurn({ text: "second" });
    const second = server.calls("turn/start").at(-1)!.params as Record<string, unknown>;
    expect(second).toMatchObject({ approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } });
    await session.close();
  });

  it("full-auto 중 서버 승인 요청은 자동 승인으로 응답하고 승인 아이템을 만들지 않는다", async () => {
    const server = new FakeAppServer();
    const session = await make(server).start({ cwd, mode: "full-auto" });
    const iter = session.events[Symbol.asyncIterator]();
    await take(iter, (e) => e.type === "status");
    await session.sendTurn({ text: "run" });
    const turnId = server.turnId();
    const cmd = await server.request("item/commandExecution/requestApproval", { threadId: THREAD, turnId, itemId: "c1", command: "rm -rf build", cwd, reason: null });
    expect(cmd.result).toEqual({ decision: "accept" });
    const file = await server.request("item/fileChange/requestApproval", { threadId: THREAD, turnId, itemId: "f1", reason: null, grantRoot: null });
    expect(file.result).toEqual({ decision: "accept" });
    const perm = await server.request("item/permissions/requestApproval", { threadId: THREAD, turnId, itemId: "p1", cwd, reason: null, permissions: { network: { enabled: true } } });
    expect(perm.result).toEqual({ permissions: { network: { enabled: true } }, scope: "turn" });
    server.completeTurn();
    const events = await take(iter, (e) => e.type === "status" && e.status === "idle");
    expect(approvalEvents(events)).toEqual([]);
    expect(events.some((e) => e.type === "turn.completed")).toBe(true);
    await session.close();
  });

  it("full-auto 에서도 사용자 입력 요청(requestUserInput)은 자동 응답하지 않고 사용자에게 보낸다", async () => {
    const server = new FakeAppServer();
    const session = await make(server).start({ cwd, mode: "full-auto" });
    const iter = session.events[Symbol.asyncIterator]();
    await take(iter, (e) => e.type === "status");
    await session.sendTurn({ text: "run" });
    const turnId = server.turnId();
    const reply = server.request("item/tool/requestUserInput", { threadId: THREAD, turnId, itemId: "q1", questions: [{ id: "name", header: "이름", question: "이름은?", isSecret: false, options: null }] });
    const events = await take(iter, (e) => e.type === "approval.requested");
    const req = events.at(-1) as Extract<AgentEvent, { type: "approval.requested" }>;
    expect(req.approval.kind).toBe("user_input");
    await session.respondApproval(req.approval.approvalId, "submit", { name: "Bob" });
    expect((await reply).result).toEqual({ answers: { name: { answers: ["Bob"] } } });
    await session.close();
  });
});
