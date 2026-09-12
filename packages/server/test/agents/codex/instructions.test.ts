import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexAdapter } from "../../../src/agents/codex/adapter.js";
import { FakeAppServer, THREAD, quietLogger as logger, take } from "../../helpers/fake-codex-app-server.js";
import { makeTmpHome, removeTmp } from "../../helpers/tmp-home.js";

const INSTRUCTIONS = "너는 팀 backend 의 개발자 지연이다. 커밋하지 마라.";

let home: string;
let cwd: string;
beforeEach(async () => {
  home = await makeTmpHome("mam-codex-instr-");
  cwd = join(home, "work", "app");
  await mkdir(cwd, { recursive: true });
});
afterEach(async () => {
  await removeTmp(home);
});

function make(server: FakeAppServer): CodexAdapter {
  return new CodexAdapter({ spawnFn: server.spawnFn, binPath: "/usr/bin/true", home, logger, requestTimeoutMs: 2000 });
}

function paramsOf(server: FakeAppServer, method: string): Record<string, unknown> {
  const msg = server.received.find((m) => m.method === method);
  if (!msg) throw new Error(`${method} 요청이 없습니다`);
  return msg.params as Record<string, unknown>;
}

describe("CodexAdapter instructions (역할 프롬프트)", () => {
  it("thread/start 에 developerInstructions 를 넣고 turn/start 에는 넣지 않는다", async () => {
    const server = new FakeAppServer();
    const session = await make(server).start({ cwd, mode: "auto-edit", instructions: INSTRUCTIONS });
    const start = paramsOf(server, "thread/start");
    expect(start).toMatchObject({ cwd, approvalPolicy: "on-request", sandbox: "workspace-write", developerInstructions: INSTRUCTIONS });
    expect(server.received.some((m) => m.method === "thread/resume")).toBe(false);

    const iter = session.events[Symbol.asyncIterator]();
    await take(iter, (e) => e.type === "status");
    await session.sendTurn({ text: "hi" });
    await server.waitFor((m) => m.method === "turn/start");
    const turn = paramsOf(server, "turn/start");
    expect(turn).toMatchObject({ threadId: THREAD, cwd, approvalPolicy: "on-request" });
    expect(turn).not.toHaveProperty("developerInstructions");
    await session.close();
  });

  it("instructions 가 없으면 thread/start 에 developerInstructions 키가 없다", async () => {
    const server = new FakeAppServer();
    const session = await make(server).start({ cwd, mode: "plan", model: "gpt-5" });
    const start = paramsOf(server, "thread/start");
    expect(start).toMatchObject({ cwd, approvalPolicy: "on-request", sandbox: "read-only", model: "gpt-5" });
    expect(start).not.toHaveProperty("developerInstructions");
    await session.close();
  });

  it("thread/resume 에도 developerInstructions 를 넣는다", async () => {
    const server = new FakeAppServer();
    const session = await make(server).start({ cwd, mode: "ask", resumeNativeId: THREAD, instructions: INSTRUCTIONS });
    expect(server.received.some((m) => m.method === "thread/start")).toBe(false);
    const resume = paramsOf(server, "thread/resume");
    expect(resume).toMatchObject({ threadId: THREAD, cwd, approvalPolicy: "untrusted", sandbox: "workspace-write", developerInstructions: INSTRUCTIONS });
    await session.close();
  });

  it("instructions 가 없으면 thread/resume 에 developerInstructions 키가 없다", async () => {
    const server = new FakeAppServer();
    const session = await make(server).start({ cwd, mode: "ask", resumeNativeId: THREAD });
    const resume = paramsOf(server, "thread/resume");
    expect(resume).toMatchObject({ threadId: THREAD, cwd });
    expect(resume).not.toHaveProperty("developerInstructions");
    await session.close();
  });
});
