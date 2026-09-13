import type { PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SessionMode } from "@mam/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeAdapter, type QueryFn } from "../../../src/agents/claude/adapter.js";
import type { AgentEvent } from "../../../src/agents/types.js";
import { FAKE_SID, fakeResult, makeFakeQueryFn } from "../../helpers/fake-claude-query.js";
import { makeTmpHome, removeTmp } from "../../helpers/tmp-home.js";

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const MODES: SessionMode[] = ["ask", "auto-edit", "full-auto", "plan"];
const BASH_INPUT = { command: "echo pong" };

let home: string;
beforeEach(async () => {
  home = await makeTmpHome("mam-claude-perm-");
});
afterEach(async () => {
  await removeTmp(home);
});

function adapter(queryFn: QueryFn): ClaudeAdapter {
  return new ClaudeAdapter({ queryFn, home, dataDir: `${home}/.mam`, binPath: "/nonexistent/claude", logger, env: { PATH: "/usr/bin" } });
}

const toolUse = (id: string): SDKMessage =>
  ({ type: "assistant", session_id: FAKE_SID, parent_tool_use_id: null, uuid: "t1", message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: BASH_INPUT }] } }) as unknown as SDKMessage;
const toolResult = (id: string): SDKMessage =>
  ({ type: "user", session_id: FAKE_SID, parent_tool_use_id: null, uuid: "r1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "pong\n", is_error: false }] } }) as unknown as SDKMessage;

async function collect(events: AsyncIterable<AgentEvent>, until: (e: AgentEvent) => boolean, limit = 100): Promise<AgentEvent[]> {
  const got: AgentEvent[] = [];
  for await (const e of events) {
    got.push(e);
    if (until(e) || got.length >= limit) break;
  }
  return got;
}

const isIdle = (e: AgentEvent): boolean => e.type === "status" && e.status === "idle";
const approvalEvents = (events: AgentEvent[]): AgentEvent[] =>
  events.filter((e) => e.type === "approval.requested" || ((e.type === "item.started" || e.type === "item.completed") && e.item.kind === "approval"));

/** Bash tool_use 전에 `canUseTool` 을 흉내 내 부르고 결정을 기록하는 핸들러. */
function bashHandler(decisions: PermissionResult[]) {
  return makeFakeQueryFn(async (_m, { options, emit }) => {
    decisions.push(await options.canUseTool!("Bash", BASH_INPUT, { signal: new AbortController().signal }));
    await emit(toolUse("tu1"));
    await emit(toolResult("tu1"));
    await emit(fakeResult());
  });
}

describe("ClaudeAdapter 권한 (full-auto = bypassPermissions)", () => {
  it("allowDangerouslySkipPermissions 는 모든 모드에서 true 로 넘어간다(SDK 가 bypassPermissions 에 요구)", async () => {
    const { queryFn, queries } = makeFakeQueryFn(async () => undefined);
    const a = adapter(queryFn);
    for (const mode of MODES) {
      const s = await a.start({ cwd: home, mode });
      await s.close();
    }
    expect(queries.map((q) => q.options.permissionMode)).toEqual(["default", "acceptEdits", "bypassPermissions", "plan"]);
    for (const q of queries) expect(q.options.allowDangerouslySkipPermissions).toBe(true);
  });

  it("full-auto 세션에서 canUseTool 은 승인 아이템·approval.requested 없이 즉시 allow 를 돌려준다", async () => {
    const decisions: PermissionResult[] = [];
    const { queryFn } = bashHandler(decisions);
    const s = await adapter(queryFn).start({ cwd: home, mode: "full-auto" });
    await s.sendTurn({ text: "run echo pong" });
    const events = await collect(s.events, isIdle);
    expect(decisions).toEqual([{ behavior: "allow", updatedInput: BASH_INPUT }]);
    expect(approvalEvents(events)).toEqual([]);
    expect(events.some((e) => e.type === "item.completed" && e.item.kind === "tool_call")).toBe(true);
    expect(events.some((e) => e.type === "turn.completed")).toBe(true);
    await s.close();
  });

  it("ask 세션은 여전히 approval.requested 를 내고 사용자 응답을 기다린다", async () => {
    const decisions: PermissionResult[] = [];
    const { queryFn } = bashHandler(decisions);
    const s = await adapter(queryFn).start({ cwd: home, mode: "ask" });
    await s.sendTurn({ text: "run echo pong" });
    const first = await collect(s.events, (e) => e.type === "approval.requested");
    const req = first.at(-1)!;
    if (req.type !== "approval.requested") throw new Error("no approval");
    expect(decisions).toEqual([]);
    expect(req.approval.kind).toBe("command");
    await s.respondApproval(req.approval.approvalId, "allow");
    const rest = await collect(s.events, isIdle);
    expect(decisions).toEqual([{ behavior: "allow", updatedInput: BASH_INPUT }]);
    expect(rest.some((e) => e.type === "item.completed" && e.item.kind === "approval")).toBe(true);
    await s.close();
  });

  it("라이브 프로세스에서 setMode('full-auto') 는 setPermissionMode('bypassPermissions') 를 부르고 이후 canUseTool 은 allow", async () => {
    const decisions: PermissionResult[] = [];
    const { queryFn, queries } = bashHandler(decisions);
    const s = await adapter(queryFn).start({ cwd: home, mode: "ask" });
    await s.setMode("full-auto");
    expect(queries[0]!.setPermissionMode).toHaveBeenCalledWith("bypassPermissions");
    await s.sendTurn({ text: "run echo pong" });
    const events = await collect(s.events, isIdle);
    expect(decisions).toEqual([{ behavior: "allow", updatedInput: BASH_INPUT }]);
    expect(approvalEvents(events)).toEqual([]);
    await s.close();
  });

  it("프로세스가 없을 때(idle) 바뀐 mode 는 다음 openProcess 의 permissionMode 로 간다", async () => {
    const { queryFn, queries } = makeFakeQueryFn(async (_m, { options, emit }) => {
      await emit(fakeResult());
      // 유휴 중 프로세스 정상 종료를 흉내낸다(이터레이터 종료).
      options.abortController!.abort();
    });
    const s = await adapter(queryFn).start({ cwd: home, mode: "ask" });
    await s.sendTurn({ text: "first" });
    await collect(s.events, isIdle);
    await new Promise((r) => setTimeout(r, 20));
    expect(s.liveQuery).toBeUndefined();
    await s.setMode("full-auto");
    expect(queries[0]!.setPermissionMode).not.toHaveBeenCalled();
    await s.sendTurn({ text: "second" });
    expect(queries).toHaveLength(2);
    expect(queries[1]!.options).toMatchObject({ permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, resume: FAKE_SID });
    await s.close();
  });
});
