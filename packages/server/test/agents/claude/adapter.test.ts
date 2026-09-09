import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Options, PermissionResult, PermissionUpdate, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { TimelineItemSchema } from "@mam/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeAdapter, buildChildEnv, toPermissionMode, type QueryFn } from "../../../src/agents/claude/adapter.js";
import { tokenPath } from "../../../src/agents/claude/credentials.js";
import { AsyncQueue } from "../../../src/agents/fake/async-queue.js";
import type { AgentEvent } from "../../../src/agents/types.js";
import { AgentBusyError } from "../../../src/errors.js";
import { makeTmpHome, removeTmp } from "../../helpers/tmp-home.js";

const SID = "11111111-2222-3333-4444-555555555555";
const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

type Handler = (msg: SDKUserMessage, ctx: { options: Options; emit: (m: SDKMessage) => Promise<void> }) => Promise<void>;

interface FakeQuery {
  options: Options;
  interrupt: ReturnType<typeof vi.fn>;
  setPermissionMode: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

/** 가짜 Query: 사용자 메시지마다 handler 가 SDKMessage 를 재생한다. handler 예외는 이터레이터 예외로 전달된다. */
function makeQueryFn(handler: Handler): { queryFn: QueryFn; queries: FakeQuery[] } {
  const queries: FakeQuery[] = [];
  const queryFn = ((params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => {
    const options = params.options ?? {};
    const outQueue = new AsyncQueue<SDKMessage>();
    const fake: FakeQuery = { options, interrupt: vi.fn(async () => undefined), setPermissionMode: vi.fn(async () => undefined), close: vi.fn(() => outQueue.end()) };
    queries.push(fake);
    const emit = async (m: SDKMessage): Promise<void> => {
      outQueue.push(m);
      await new Promise((r) => setTimeout(r, 0));
    };
    (async () => {
      try {
        outQueue.push({ type: "system", subtype: "init", session_id: SID, model: "m", permissionMode: options.permissionMode ?? "default" } as unknown as SDKMessage);
        for await (const msg of params.prompt as AsyncIterable<SDKUserMessage>) await handler(msg, { options, emit });
        outQueue.end();
      } catch (err) {
        outQueue.push({ __throw: err } as unknown as SDKMessage);
      }
    })();
    options.abortController?.signal.addEventListener("abort", () => outQueue.end());
    const iter = outQueue[Symbol.asyncIterator]();
    const q = {
      ...fake,
      next: async () => {
        const r = await iter.next();
        const thrown = !r.done ? (r.value as unknown as { __throw?: unknown }).__throw : undefined;
        if (thrown) throw thrown;
        return r;
      },
      return: async () => ({ value: undefined, done: true as const }),
      throw: async (e: unknown) => { throw e; },
      [Symbol.asyncIterator]() { return this; },
    };
    return q as unknown as Query;
  }) as unknown as QueryFn;
  return { queryFn, queries };
}

const text = (t: string): SDKMessage[] => [
  { type: "stream_event", session_id: SID, parent_tool_use_id: null, uuid: "u1", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } } as unknown as SDKMessage,
  { type: "stream_event", session_id: SID, parent_tool_use_id: null, uuid: "u2", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } } } as unknown as SDKMessage,
  { type: "assistant", session_id: SID, parent_tool_use_id: null, uuid: "u3", message: { role: "assistant", content: [{ type: "text", text: t }] } } as unknown as SDKMessage,
];
const toolUse = (id: string, name: string, input: Record<string, unknown>): SDKMessage =>
  ({ type: "assistant", session_id: SID, parent_tool_use_id: null, uuid: "t1", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } }) as unknown as SDKMessage;
const toolResult = (id: string, out: string, isError = false): SDKMessage =>
  ({ type: "user", session_id: SID, parent_tool_use_id: null, uuid: "r1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: out, is_error: isError }] } }) as unknown as SDKMessage;
const result = (): SDKMessage =>
  ({ type: "result", subtype: "success", session_id: SID, uuid: "x", is_error: false, duration_ms: 1200, duration_api_ms: 1000, num_turns: 1, result: "ok", total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 }, stop_reason: "end_turn" }) as unknown as SDKMessage;

async function collect(events: AsyncIterable<AgentEvent>, until: (e: AgentEvent) => boolean, limit = 100): Promise<AgentEvent[]> {
  const got: AgentEvent[] = [];
  for await (const e of events) {
    got.push(e);
    if (until(e) || got.length >= limit) break;
  }
  return got;
}

function assertItemsValid(events: AgentEvent[]): void {
  for (const e of events) {
    if (e.type === "item.started" || e.type === "item.completed") {
      expect(TimelineItemSchema.safeParse({ seq: 1, ...e.item }).success, JSON.stringify(e.item)).toBe(true);
    }
  }
}

function payloadOf(e: AgentEvent | undefined): unknown {
  return e && (e.type === "item.started" || e.type === "item.completed") ? e.item.payload : undefined;
}
function itemOf(e: AgentEvent | undefined): { status?: string; turnId?: string | null } {
  return e && (e.type === "item.started" || e.type === "item.completed") ? e.item : {};
}

let home: string;
beforeEach(async () => { home = await makeTmpHome("mam-claude-"); });
afterEach(async () => { await removeTmp(home); });

function adapter(queryFn: QueryFn, extra: Partial<ConstructorParameters<typeof ClaudeAdapter>[0]> = {}): ClaudeAdapter {
  return new ClaudeAdapter({ queryFn, home, binPath: "/nonexistent/claude", logger, env: { PATH: "/usr/bin", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli" }, ...extra });
}

describe("ClaudeAdapter", () => {
  it("(a) init → 텍스트 스트리밍 → result 를 TimelineItem/turn.completed 로 정규화한다", async () => {
    const { queryFn } = makeQueryFn(async (_m, { emit }) => { for (const m of [...text("pong"), result()]) await emit(m); });
    const s = await adapter(queryFn).start({ cwd: home, mode: "ask" });
    await s.sendTurn({ text: "ping" });
    const ev = await collect(s.events, (e) => e.type === "turn.completed");
    const tail = await collect(s.events, (e) => e.type === "status" && e.status === "idle");
    const all = [...ev, ...tail];
    expect(all).toContainEqual({ type: "native_id", nativeId: SID });
    expect(s.nativeId).toBe(SID);
    expect(payloadOf(all.find((e) => e.type === "item.started" && e.item.kind === "user_message"))).toEqual({ text: "ping", attachments: [] });
    expect(itemOf(all.find((e) => e.type === "item.started" && e.item.kind === "assistant_message")).status).toBe("running");
    expect(all).toContainEqual(expect.objectContaining({ type: "item.delta", field: "text", delta: "pong" }));
    expect(payloadOf(all.find((e) => e.type === "item.completed" && e.item.kind === "assistant_message"))).toMatchObject({ text: "pong" });
    const tc = all.find((e) => e.type === "turn.completed");
    expect(tc).toMatchObject({ durationMs: 1200, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 }, costUsd: 0.01, stopReason: "end_turn" });
    expect(itemOf(all.find((e) => e.type === "item.started" && e.item.kind === "turn_summary")).turnId).toBe((tc as { turnId: string }).turnId);
    expect(all.at(-1)).toEqual({ type: "status", status: "idle" });
    assertItemsValid(all);
    await s.close();
  });

  it("(b) Bash tool_use → canUseTool → allow_session → updatedPermissions=suggestions → tool_result", async () => {
    const suggestions: PermissionUpdate[] = [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "echo hi" }], behavior: "allow", destination: "session" }];
    let decision: PermissionResult | undefined;
    const { queryFn } = makeQueryFn(async (_m, { options, emit }) => {
      await emit(toolUse("tu1", "Bash", { command: "echo hi" }));
      decision = await options.canUseTool!("Bash", { command: "echo hi" }, { signal: new AbortController().signal, suggestions, title: "Claude wants to run echo hi" });
      await emit(toolResult("tu1", "hi\n"));
      await emit(result());
    });
    const s = await adapter(queryFn).start({ cwd: home, mode: "ask" });
    await s.sendTurn({ text: "run" });
    const first = await collect(s.events, (e) => e.type === "approval.requested");
    const req = first.at(-1)!;
    if (req.type !== "approval.requested") throw new Error("no approval");
    expect(req.approval).toMatchObject({ kind: "command", title: "echo hi", prompt: "Claude wants to run echo hi", diff: null });
    expect(req.approval.detail).toContain(`cwd: ${home}`);
    expect(req.approval.options.map((o) => o.id)).toEqual(["allow", "allow_session", "deny"]);
    expect(payloadOf(first.find((e) => e.type === "item.started" && e.item.kind === "tool_call"))).toMatchObject({ tool: "bash", name: "Bash", title: "echo hi", input: { command: "echo hi" } });
    await expect(s.sendTurn({ text: "again" })).rejects.toBeInstanceOf(AgentBusyError);
    await s.respondApproval(req.approval.approvalId, "allow_session");
    const rest = await collect(s.events, (e) => e.type === "turn.completed");
    expect(decision).toEqual({ behavior: "allow", updatedInput: { command: "echo hi" }, updatedPermissions: suggestions });
    expect(payloadOf(rest.find((e) => e.type === "item.completed" && e.item.kind === "approval"))).toMatchObject({ approvalId: req.approval.approvalId, resolution: { optionId: "allow_session", by: "client" } });
    const tc = rest.find((e) => e.type === "item.completed" && e.item.kind === "tool_call");
    expect(itemOf(tc).status).toBe("completed");
    expect(payloadOf(tc)).toMatchObject({ output: "hi\n", truncated: false });
    assertItemsValid([...first, ...rest]);
    await s.close();
  });

  it("(c) deny / abort 응답 매핑, suggestions 없으면 allow_session 옵션 없음", async () => {
    const decisions: PermissionResult[] = [];
    const { queryFn } = makeQueryFn(async (_m, { options, emit }) => {
      for (const id of ["tu1", "tu2"]) {
        await emit(toolUse(id, "Bash", { command: "unlink x" }));
        decisions.push(await options.canUseTool!("Bash", { command: "unlink x" }, { signal: new AbortController().signal }));
        await emit(toolResult(id, "denied", true));
      }
      await emit(result());
    });
    const s = await adapter(queryFn).start({ cwd: home, mode: "ask" });
    await s.sendTurn({ text: "go" });
    const r1 = (await collect(s.events, (e) => e.type === "approval.requested")).at(-1)!;
    if (r1.type !== "approval.requested") throw new Error("no approval");
    expect(r1.approval.options.map((o) => o.id)).toEqual(["allow", "deny"]);
    await expect(s.respondApproval(r1.approval.approvalId, "bogus")).rejects.toThrow();
    await s.respondApproval(r1.approval.approvalId, "deny", undefined, "안 돼요");
    const r2 = (await collect(s.events, (e) => e.type === "approval.requested")).at(-1)!;
    if (r2.type !== "approval.requested") throw new Error("no approval 2");
    await s.respondApproval(r2.approval.approvalId, "abort");
    const rest = await collect(s.events, (e) => e.type === "turn.completed");
    expect(decisions[0]).toEqual({ behavior: "deny", message: "안 돼요" });
    expect(decisions[1]).toMatchObject({ behavior: "deny", interrupt: true });
    expect(rest.filter((e) => e.type === "item.completed" && e.item.kind === "tool_call" && e.item.status === "failed")).toHaveLength(1);
    await s.close();
  });

  it("(d) Edit → file_change 아이템과 unified diff, 승인 kind file_change + diff", async () => {
    const input = { file_path: join(home, "a.txt"), old_string: "b\nc", new_string: "b\nC" };
    const { queryFn } = makeQueryFn(async (_m, { options, emit }) => {
      await emit(toolUse("tu1", "Edit", input));
      await options.canUseTool!("Edit", input, { signal: new AbortController().signal });
      await emit(toolResult("tu1", "ok"));
      await emit(result());
    });
    const s = await adapter(queryFn).start({ cwd: home, mode: "ask" });
    await s.sendTurn({ text: "edit" });
    const first = await collect(s.events, (e) => e.type === "approval.requested");
    const req = first.at(-1)!;
    if (req.type !== "approval.requested") throw new Error("no approval");
    expect(req.approval.kind).toBe("file_change");
    expect(req.approval.diff).toContain("-c\n+C");
    const fc = payloadOf(first.find((e) => e.type === "item.started" && e.item.kind === "file_change")) as { files: unknown[]; patch: string };
    expect(fc).toMatchObject({ files: [{ path: "a.txt", kind: "modify", additions: 1, deletions: 1 }] });
    expect(fc.patch).toContain("diff --git a/a.txt b/a.txt");
    await s.respondApproval(req.approval.approvalId, "allow");
    const rest = await collect(s.events, (e) => e.type === "turn.completed");
    expect(itemOf(rest.find((e) => e.type === "item.completed" && e.item.kind === "file_change")).status).toBe("completed");
    assertItemsValid([...first, ...rest]);
    await s.close();
  });

  it("(e) resume/permissionMode/env 가 options 로 전달된다", async () => {
    await mkdir(join(home, ".mam", "secrets"), { recursive: true });
    await writeFile(tokenPath(home), "sk-ant-oat01-test\n", { mode: 0o600 });
    const { queryFn, queries } = makeQueryFn(async () => undefined);
    const s = await adapter(queryFn, { binPath: "/x/claude", settingSources: ["user"] }).start({ cwd: home, mode: "auto-edit", model: "sonnet", resumeNativeId: "prev-id" });
    const o = queries[0]!.options;
    expect(o).toMatchObject({ cwd: home, permissionMode: "acceptEdits", resume: "prev-id", model: "sonnet", includePartialMessages: true, settingSources: ["user"], pathToClaudeCodeExecutable: "/x/claude" });
    expect(o.env).toMatchObject({ PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test" });
    expect(o.env).not.toHaveProperty("CLAUDECODE");
    expect(o.env).not.toHaveProperty("CLAUDE_CODE_ENTRYPOINT");
    expect(typeof o.canUseTool).toBe("function");
    expect(o.abortController).toBeInstanceOf(AbortController);
    expect(s.nativeId).toBe("prev-id");
    await s.setMode("plan");
    expect(queries[0]!.setPermissionMode).toHaveBeenCalledWith("plan");
    expect(toPermissionMode("full-auto")).toBe("bypassPermissions");
    expect(buildChildEnv({ CLAUDECODE: "1", A: "b" }, null)).toEqual({ A: "b" });
    await s.close();
    expect(queries[0]!.close).toHaveBeenCalled();
  });

  it("(f) 이터레이터 예외 → error{recoverable:false} 후 events 종료", async () => {
    const { queryFn } = makeQueryFn(async () => { throw new Error("boom"); });
    const s = await adapter(queryFn).start({ cwd: home, mode: "ask" });
    await s.sendTurn({ text: "x" });
    const all = await collect(s.events, () => false);
    expect(all.at(-1)).toEqual({ type: "error", message: "Claude 프로세스 오류: boom", recoverable: false });
  });

  it("(g) interrupt() 는 q.interrupt() 를 부르고, result 가 안 오면 강제 중단 후 다음 턴에서 resume 으로 재시작한다", async () => {
    const { queryFn, queries } = makeQueryFn(async (_m, { emit }) => { await emit(text("working")[0]!); });
    const s = await adapter(queryFn, { interruptTimeoutMs: 50 }).start({ cwd: home, mode: "ask" });
    await s.sendTurn({ text: "x" });
    await collect(s.events, (e) => e.type === "item.started" && e.item.kind === "assistant_message");
    await s.interrupt();
    expect(queries[0]!.interrupt).toHaveBeenCalledTimes(1);
    const ev = await collect(s.events, (e) => e.type === "status" && e.status === "idle");
    expect(ev).toContainEqual({ type: "error", message: "턴을 강제 중단했습니다", recoverable: true });
    expect(itemOf(ev.find((e) => e.type === "item.completed" && e.item.kind === "assistant_message")).status).toBe("cancelled");
    expect(queries[0]!.options.abortController!.signal.aborted).toBe(true);
    await s.sendTurn({ text: "again" });
    expect(queries).toHaveLength(2);
    expect(queries[1]!.options.resume).toBe(SID);
    await s.close();
  });

  it("probe: 바이너리 없으면 SDK 버전, 로그인은 detectLogin", async () => {
    const { queryFn } = makeQueryFn(async () => undefined);
    const p = await new ClaudeAdapter({ queryFn, home, logger, env: { MAM_CLAUDE_BIN: "/nonexistent/claude", PATH: "/nonexistent", SHELL: "/usr/bin/false" } }).probe();
    expect(p.available).toBe(true);
    expect(p.loggedIn).toBe(false);
    expect(p.version).toBeTruthy();
  });
});
