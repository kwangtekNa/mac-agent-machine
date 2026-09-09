import { describe, expect, it } from "vitest";
import * as protocol from "../src/index.js";

const SCHEMA_EXPORTS = [
  // common
  "AgentKindSchema",
  "SessionModeSchema",
  "SessionStatusSchema",
  "ItemStatusSchema",
  "IsoDateSchema",
  "SeqSchema",
  "ErrorCodeSchema",
  "ErrorResponseSchema",
  "SessionIdSchema",
  "ItemIdSchema",
  "ApprovalIdSchema",
  "TurnIdSchema",
  "FlowIdSchema",
  // timeline
  "ToolNameSchema",
  "TimelineItemSchema",
  "TimelineItemKindSchema",
  "UserMessagePayloadSchema",
  "AssistantMessagePayloadSchema",
  "ReasoningPayloadSchema",
  "ToolCallPayloadSchema",
  "FileChangePayloadSchema",
  "PlanPayloadSchema",
  "ApprovalPayloadSchema",
  "TurnSummaryPayloadSchema",
  "ErrorPayloadSchema",
  "SystemPayloadSchema",
  // approval
  "ApprovalOptionSchema",
  "InputFieldSchema",
  "ApprovalSchema",
  "ApprovalResolutionSchema",
  "ApprovalKindSchema",
  // session
  "SessionSchema",
  "CreateSessionRequestSchema",
  "PatchSessionRequestSchema",
  "TurnInputSchema",
  "UsageSchema",
  // rest
  "MeResponseSchema",
  "ProjectsResponseSchema",
  "SessionsResponseSchema",
  "SessionDetailResponseSchema",
  "FsListResponseSchema",
  "FsEntrySchema",
  "FsReadResponseSchema",
  "GitStatusResponseSchema",
  "GitDiffResponseSchema",
  "LoginStartResponseSchema",
  "LoginStatusResponseSchema",
  "LoginCodeRequestSchema",
  "ApprovalRespondRequestSchema",
  // ws
  "ServerEventSchema",
  "ClientMessageSchema",
] as const;

const FUNCTION_EXPORTS = ["idSchema", "parseServerEvent", "parseClientMessage", "safeParseClientMessage"] as const;

describe("index exports", () => {
  it("PROTOCOL_VERSION 은 1 이다", () => {
    expect(protocol.PROTOCOL_VERSION).toBe(1);
  });

  it.each(SCHEMA_EXPORTS)("%s 스키마를 export 한다", (name) => {
    const value = (protocol as Record<string, unknown>)[name];
    expect(value).toBeDefined();
    expect(typeof (value as { parse?: unknown }).parse).toBe("function");
  });

  it.each(FUNCTION_EXPORTS)("%s 함수를 export 한다", (name) => {
    expect(typeof (protocol as Record<string, unknown>)[name]).toBe("function");
  });

  it("parse 헬퍼가 판별 union 을 통해 좁혀진 값을 돌려준다", () => {
    const ping = protocol.parseClientMessage({ type: "ping" });
    expect(ping.type).toBe("ping");
    const pong = protocol.parseServerEvent({
      type: "pong",
      seq: 0,
      sessionId: "ses_01J8ZQ4K5N7P9R3S6T8V0W2XAB",
      ts: "2026-09-09T10:00:00Z",
    });
    expect(pong.type).toBe("pong");
    const safe = protocol.safeParseClientMessage({ type: "nope" });
    expect(safe.success).toBe(false);
  });
});
