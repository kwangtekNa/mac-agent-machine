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
  "SessionUsageSchema",
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
  "FsMkdirRequestSchema",
  "FsMkdirResponseSchema",
  "UsageLimitSchema",
  "AgentUsageSchema",
  "UsageResponseSchema",
  "ModelOptionSchema",
  "ModelsResponseSchema",
  "ModelsQuerySchema",
  // ws
  "ServerEventSchema",
  "ClientMessageSchema",
  "SessionUsageEventSchema",
  // teams (2026-09-12 추가)
  "TeamIdSchema",
  "MemberIdSchema",
  "RoomIdSchema",
  "MessageIdSchema",
  "ChangeIdSchema",
  "TemplateIdSchema",
  "DispatchIdSchema",
  "SessionTeamRefSchema",
  "RoleIdSchema",
  "RolePresetSchema",
  "TeamMemberStateSchema",
  "TeamMemberSchema",
  "TeamSettingsSchema",
  "RoomKindSchema",
  "RoomSchema",
  "TeamSchema",
  "RoomAuthorSchema",
  "WorkSummarySchema",
  "ChangeSetStatusSchema",
  "ChangeSetSchema",
  "RoomMessageKindSchema",
  "RoomApprovalSchema",
  "RoomMessageSchema",
  "MergeResultSchema",
  "DispatchStateSchema",
  "TeamTemplateMemberSchema",
  "TeamTemplateSchema",
  "MemberInputSchema",
  "CreateTeamRequestSchema",
  "PatchTeamRequestSchema",
  "PatchMemberRequestSchema",
  "PostRoomMessageRequestSchema",
  "CreateTeamTemplateRequestSchema",
  "PatchTeamTemplateRequestSchema",
  "TeamRolesResponseSchema",
  "TeamsResponseSchema",
  "TeamDetailResponseSchema",
  "RoomDetailResponseSchema",
  "PostRoomMessageResponseSchema",
  "ChangesResponseSchema",
  "TeamTemplatesResponseSchema",
  // room ws
  "RoomServerEventSchema",
  "RoomClientMessageSchema",
  "RoomSnapshotEventSchema",
  "RoomMessageEventSchema",
  "RoomMessageUpdatedEventSchema",
  "RoomStatusEventSchema",
  "RoomErrorEventSchema",
  "RoomPongEventSchema",
  "RoomSendMessageSchema",
  "RoomInterruptMessageSchema",
  "RoomPingMessageSchema",
] as const;

const FUNCTION_EXPORTS = [
  "idSchema",
  "parseServerEvent",
  "parseClientMessage",
  "safeParseClientMessage",
  "parseRoomServerEvent",
  "parseRoomClientMessage",
  "safeParseRoomClientMessage",
] as const;

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

  it("방 parse 헬퍼는 세션 파서와 분리돼 있다 (2026-09-12 추가)", () => {
    const base = {
      seq: 0,
      roomId: "room_01J8ZQ4K5N7P9R3S6T8V0W2XR0",
      teamId: "team_01J8ZQ4K5N7P9R3S6T8V0W2XT1",
      ts: "2026-09-12T09:00:00Z",
    };
    const pong = protocol.parseRoomServerEvent({ type: "pong", ...base });
    expect(pong.type).toBe("pong");
    expect(() => protocol.parseServerEvent({ type: "pong", ...base })).toThrow();
    expect(() => protocol.parseRoomServerEvent({ type: "room.message", ...base, seq: 1 })).toThrow();
    const ping = protocol.parseRoomClientMessage({ type: "ping" });
    expect(ping.type).toBe("ping");
    expect(protocol.safeParseRoomClientMessage({ type: "turn.start", text: "x" }).success).toBe(false);
    expect(protocol.safeParseClientMessage({ type: "room.send", text: "x" }).success).toBe(false);
  });
});
