import type { Approval, SessionMode, TurnInput } from "@mam/protocol";
import { newId } from "../../ids.js";
import type { AgentEvent } from "../types.js";

export interface ApprovalResponse {
  optionId: string;
  inputs?: Record<string, string>;
  message?: string;
}

/** 스크립트가 쓰는 세션 컨텍스트. `emit` 은 seq 없는 어댑터 이벤트를 낸다. */
export interface ScriptContext {
  input: TurnInput;
  turnId: string;
  nativeId: string;
  mode: SessionMode;
  /** 이 세션의 몇 번째 턴인지(1부터). */
  turnNumber: number;
  model: string;
  effort: string | undefined;
  autoApprove: boolean;
  signal: AbortSignal;
  now(): string;
  emit(event: AgentEvent): void;
  /** 옵션의 `delayMs` 만큼 대기. interrupt 되면 AbortError 를 던진다. */
  delay(): Promise<void>;
  /** 승인 응답이 올 때까지 대기. interrupt 되면 AbortError 를 던진다. */
  requestApproval(approval: Approval): Promise<ApprovalResponse>;
}

export type FakeScript = (ctx: ScriptContext) => Promise<void>;

export const FAKE_FAIL_MESSAGE = "가짜 에이전트 프로세스가 예기치 않게 종료되었습니다 (exit 1)";

const ASSISTANT_CHUNKS = ["안녕하세요. ", "요청하신 명령을 ", "실행하겠습니다."];

/**
 * 기본 스크립트: user_message → assistant_message(델타 3개) → tool_call(bash "echo hi")
 * → 승인 요청(autoApprove 가 아니면) → tool_call 완료 → turn_summary + turn.completed → status idle.
 * 텍스트에 "fail" 이 있으면 error 아이템과 복구 불가 error 이벤트를 낸다.
 */
export const defaultScript: FakeScript = async (ctx) => {
  const { input, turnId } = ctx;
  const startedAt = Date.parse(ctx.now());
  const userAt = ctx.now();
  ctx.emit({
    type: "item.started",
    item: {
      id: newId("itm"),
      turnId,
      kind: "user_message",
      status: "completed",
      createdAt: userAt,
      completedAt: userAt,
      payload: { text: input.text, attachments: input.attachments ?? [] },
    },
  });

  if (input.text.includes("fail")) {
    await ctx.delay();
    const errAt = ctx.now();
    ctx.emit({
      type: "item.started",
      item: {
        id: newId("itm"),
        turnId,
        kind: "error",
        status: "completed",
        createdAt: errAt,
        completedAt: errAt,
        payload: { message: FAKE_FAIL_MESSAGE, recoverable: false },
      },
    });
    ctx.emit({ type: "error", message: FAKE_FAIL_MESSAGE, recoverable: false });
    return;
  }

  const assistantId = newId("itm");
  const assistantAt = ctx.now();
  ctx.emit({
    type: "item.started",
    item: {
      id: assistantId,
      turnId,
      kind: "assistant_message",
      status: "running",
      createdAt: assistantAt,
      completedAt: null,
      payload: { text: "", phase: "final" },
    },
  });
  for (const chunk of ASSISTANT_CHUNKS) {
    await ctx.delay();
    ctx.emit({ type: "item.delta", itemId: assistantId, field: "text", delta: chunk });
  }
  ctx.emit({
    type: "item.completed",
    item: {
      id: assistantId,
      turnId,
      kind: "assistant_message",
      status: "completed",
      createdAt: assistantAt,
      completedAt: ctx.now(),
      payload: { text: ASSISTANT_CHUNKS.join(""), phase: "final" },
    },
  });

  await ctx.delay();
  const toolId = newId("itm");
  const toolAt = ctx.now();
  const toolPayload = {
    tool: "bash" as const,
    name: "Bash",
    title: "echo hi",
    input: { command: "echo hi" },
    output: "",
    exitCode: null,
    truncated: false,
  };
  ctx.emit({
    type: "item.started",
    item: {
      id: toolId,
      turnId,
      kind: "tool_call",
      status: "running",
      createdAt: toolAt,
      completedAt: null,
      payload: toolPayload,
    },
  });

  let decision = "allow";
  let message: string | undefined;
  if (!ctx.autoApprove) {
    const approvalItemId = newId("itm");
    const requestedAt = ctx.now();
    const approval: Approval = {
      approvalId: newId("apr"),
      itemId: approvalItemId,
      kind: "command",
      title: "echo hi 실행",
      prompt: "Fake agent wants to run: echo hi",
      detail: "$ echo hi",
      diff: null,
      options: [
        { id: "allow", label: "허용", style: "primary" },
        { id: "allow_session", label: "이 세션에서 항상 허용", style: "secondary" },
        { id: "deny", label: "거절", style: "destructive" },
        { id: "abort", label: "턴 중단", style: "destructive" },
      ],
      inputFields: [],
      requestedAt,
    };
    ctx.emit({
      type: "item.started",
      item: {
        id: approvalItemId,
        turnId,
        kind: "approval",
        status: "running",
        createdAt: requestedAt,
        completedAt: null,
        payload: approval,
      },
    });
    ctx.emit({ type: "approval.requested", approval });
    const response = await ctx.requestApproval(approval);
    const resolvedAt = ctx.now();
    ctx.emit({
      type: "item.completed",
      item: {
        id: approvalItemId,
        turnId,
        kind: "approval",
        status: "completed",
        createdAt: requestedAt,
        completedAt: resolvedAt,
        payload: {
          ...approval,
          resolution: { optionId: response.optionId, by: "client", at: resolvedAt },
        },
      },
    });
    decision = response.optionId;
    message = response.message;
  }

  if (decision === "abort") {
    ctx.emit({
      type: "item.completed",
      item: {
        id: toolId,
        turnId,
        kind: "tool_call",
        status: "cancelled",
        createdAt: toolAt,
        completedAt: ctx.now(),
        payload: { ...toolPayload, output: message ?? "사용자가 턴을 중단했습니다" },
      },
    });
    ctx.emit({ type: "status", status: "idle", reason: "aborted" });
    return;
  }

  await ctx.delay();
  if (decision === "deny") {
    ctx.emit({
      type: "item.completed",
      item: {
        id: toolId,
        turnId,
        kind: "tool_call",
        status: "failed",
        createdAt: toolAt,
        completedAt: ctx.now(),
        payload: { ...toolPayload, output: message ?? "사용자가 거절했습니다" },
      },
    });
  } else {
    ctx.emit({
      type: "item.completed",
      item: {
        id: toolId,
        turnId,
        kind: "tool_call",
        status: "completed",
        createdAt: toolAt,
        completedAt: ctx.now(),
        payload: { ...toolPayload, output: "hi\n", exitCode: 0 },
      },
    });
  }

  const summaryAt = ctx.now();
  const summary = {
    durationMs: Math.max(0, Date.parse(summaryAt) - startedAt),
    usage: { inputTokens: 120, outputTokens: 24 },
    costUsd: 0.001,
    stopReason: "end_turn",
  };
  ctx.emit({
    type: "item.started",
    item: {
      id: newId("itm"),
      turnId,
      kind: "turn_summary",
      status: "completed",
      createdAt: summaryAt,
      completedAt: summaryAt,
      payload: summary,
    },
  });
  ctx.emit({ type: "turn.completed", turnId, ...summary });
  // 턴 끝 사용량(2026-09-10). turn.completed 뒤에 보내 매니저가 turns 를 올린 뒤 한 번에 발행하게 한다.
  ctx.emit({
    type: "usage",
    delta: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 800, cacheWriteTokens: 100, costUsd: 0.012 },
    context: { tokens: 4200 + ctx.turnNumber * 900, window: 200000 },
    model: ctx.model,
    ...(ctx.effort !== undefined ? { effort: ctx.effort } : {}),
  });
  ctx.emit({ type: "status", status: "idle" });
};
