import type { z } from "zod";
import { ClientMessageSchema, ServerEventSchema } from "./ws.js";
import { RoomClientMessageSchema, RoomServerEventSchema } from "./room-ws.js";
import type {
  AgentKindSchema,
  ErrorCodeSchema,
  ErrorResponseSchema,
  ItemStatusSchema,
  SessionModeSchema,
  SessionStatusSchema,
} from "./common.js";
import type {
  ApprovalKindSchema,
  ApprovalOptionSchema,
  ApprovalOptionStyleSchema,
  ApprovalResolutionSchema,
  ApprovalResolvedBySchema,
  ApprovalSchema,
  InputFieldSchema,
  InputFieldTypeSchema,
} from "./approval.js";
import type {
  AttachmentSchema,
  CreateSessionRequestSchema,
  PatchSessionRequestSchema,
  SessionContextSchema,
  SessionSchema,
  SessionTeamRefSchema,
  SessionUsageSchema,
  TurnInputSchema,
  UsageSchema,
} from "./session.js";
import type {
  ApprovalPayloadSchema,
  AssistantMessagePayloadSchema,
  AssistantMessagePhaseSchema,
  ErrorPayloadSchema,
  FileChangeEntrySchema,
  FileChangeKindSchema,
  FileChangePayloadSchema,
  PlanPayloadSchema,
  PlanStepSchema,
  PlanStepStatusSchema,
  ReasoningPayloadSchema,
  SystemPayloadSchema,
  TimelineItemKindSchema,
  TimelineItemSchema,
  ToolCallPayloadSchema,
  ToolNameSchema,
  TurnSummaryPayloadSchema,
  UserMessagePayloadSchema,
} from "./timeline.js";
import type {
  AgentInfoSchema,
  AgentUsageSchema,
  ApprovalRespondRequestSchema,
  FsEntrySchema,
  FsEntryTypeSchema,
  FsListResponseSchema,
  FsMkdirRequestSchema,
  FsMkdirResponseSchema,
  FsReadResponseSchema,
  GitDiffResponseSchema,
  GitInitRequestSchema,
  GitInitResponseSchema,
  GitStatusCodeSchema,
  GitStatusEntrySchema,
  GitStatusResponseSchema,
  LoginCodeRequestSchema,
  LoginFlowStatusSchema,
  LoginStartResponseSchema,
  LoginStatusResponseSchema,
  MeResponseSchema,
  ModelOptionSchema,
  ModelsQuerySchema,
  ModelsResponseSchema,
  OkResponseSchema,
  ProjectSchema,
  ProjectsResponseSchema,
  SessionDetailResponseSchema,
  SessionsResponseSchema,
  UsageLimitSchema,
  UsageLimitStatusSchema,
  UsageResponseSchema,
} from "./rest.js";
import type {
  ApprovalRequestedEventSchema,
  ApprovalResolvedEventSchema,
  ApprovalRespondMessageSchema,
  ErrorEventSchema,
  ItemCompletedEventSchema,
  ItemDeltaEventSchema,
  ItemDeltaFieldSchema,
  ItemStartedEventSchema,
  PingMessageSchema,
  PongEventSchema,
  SessionSetModeMessageSchema,
  SessionSnapshotEventSchema,
  SessionStatusEventSchema,
  SessionUsageEventSchema,
  TurnCompletedEventSchema,
  TurnInterruptMessageSchema,
  TurnStartMessageSchema,
} from "./ws.js";
import type {
  ChangeSetSchema,
  ChangeSetStatusSchema,
  ChangesResponseSchema,
  CreateTeamRequestSchema,
  CreateTeamTemplateRequestSchema,
  DispatchStateSchema,
  MemberInputSchema,
  MergeResultSchema,
  PatchMemberRequestSchema,
  PatchTeamRequestSchema,
  PatchTeamTemplateRequestSchema,
  PostRoomMessageRequestSchema,
  PostRoomMessageResponseSchema,
  QueuedDispatchSchema,
  RoleIdSchema,
  RolePresetSchema,
  RoomApprovalSchema,
  RoomAuthorSchema,
  RoomDetailResponseSchema,
  RoomKindSchema,
  RoomMessageKindSchema,
  RoomMessageSchema,
  RoomSchema,
  RunningDispatchSchema,
  TeamDetailResponseSchema,
  TeamMemberSchema,
  TeamMemberStateSchema,
  TeamRolesResponseSchema,
  TeamSchema,
  TeamSettingsSchema,
  TeamTemplateMemberSchema,
  TeamTemplateSchema,
  TeamTemplatesResponseSchema,
  TeamsResponseSchema,
  WorkSummarySchema,
} from "./teams.js";
import type {
  RoomErrorEventSchema,
  RoomInterruptMessageSchema,
  RoomMemberStatusSchema,
  RoomMessageEventSchema,
  RoomMessageUpdatedEventSchema,
  RoomPingMessageSchema,
  RoomPongEventSchema,
  RoomSendMessageSchema,
  RoomSnapshotEventSchema,
  RoomStatusEventSchema,
} from "./room-ws.js";

export * from "./common.js";
export * from "./session.js";
export * from "./approval.js";
export * from "./timeline.js";
export * from "./rest.js";
export * from "./ws.js";
export * from "./teams.js";
export * from "./room-ws.js";

// common
export type AgentKind = z.infer<typeof AgentKindSchema>;
export type SessionMode = z.infer<typeof SessionModeSchema>;
export type SessionStatus = z.infer<typeof SessionStatusSchema>;
export type ItemStatus = z.infer<typeof ItemStatusSchema>;
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

// session
export type Usage = z.infer<typeof UsageSchema>;
export type SessionContext = z.infer<typeof SessionContextSchema>;
export type SessionUsage = z.infer<typeof SessionUsageSchema>;
export type Attachment = z.infer<typeof AttachmentSchema>;
export type TurnInput = z.infer<typeof TurnInputSchema>;
export type Session = z.infer<typeof SessionSchema>;
export type SessionTeamRef = z.infer<typeof SessionTeamRefSchema>;
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;
export type PatchSessionRequest = z.infer<typeof PatchSessionRequestSchema>;

// approval
export type ApprovalKind = z.infer<typeof ApprovalKindSchema>;
export type ApprovalOptionStyle = z.infer<typeof ApprovalOptionStyleSchema>;
export type ApprovalOption = z.infer<typeof ApprovalOptionSchema>;
export type InputFieldType = z.infer<typeof InputFieldTypeSchema>;
export type InputField = z.infer<typeof InputFieldSchema>;
export type Approval = z.infer<typeof ApprovalSchema>;
export type ApprovalResolvedBy = z.infer<typeof ApprovalResolvedBySchema>;
export type ApprovalResolution = z.infer<typeof ApprovalResolutionSchema>;

// timeline
export type ToolName = z.infer<typeof ToolNameSchema>;
export type TimelineItemKind = z.infer<typeof TimelineItemKindSchema>;
export type TimelineItem = z.infer<typeof TimelineItemSchema>;
export type UserMessagePayload = z.infer<typeof UserMessagePayloadSchema>;
export type AssistantMessagePhase = z.infer<typeof AssistantMessagePhaseSchema>;
export type AssistantMessagePayload = z.infer<typeof AssistantMessagePayloadSchema>;
export type ReasoningPayload = z.infer<typeof ReasoningPayloadSchema>;
export type ToolCallPayload = z.infer<typeof ToolCallPayloadSchema>;
export type FileChangeKind = z.infer<typeof FileChangeKindSchema>;
export type FileChangeEntry = z.infer<typeof FileChangeEntrySchema>;
export type FileChangePayload = z.infer<typeof FileChangePayloadSchema>;
export type PlanStepStatus = z.infer<typeof PlanStepStatusSchema>;
export type PlanStep = z.infer<typeof PlanStepSchema>;
export type PlanPayload = z.infer<typeof PlanPayloadSchema>;
export type ApprovalPayload = z.infer<typeof ApprovalPayloadSchema>;
export type TurnSummaryPayload = z.infer<typeof TurnSummaryPayloadSchema>;
export type ErrorPayload = z.infer<typeof ErrorPayloadSchema>;
export type SystemPayload = z.infer<typeof SystemPayloadSchema>;

// rest
export type OkResponse = z.infer<typeof OkResponseSchema>;
export type AgentInfo = z.infer<typeof AgentInfoSchema>;
export type MeResponse = z.infer<typeof MeResponseSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type ProjectsResponse = z.infer<typeof ProjectsResponseSchema>;
export type SessionsResponse = z.infer<typeof SessionsResponseSchema>;
export type SessionDetailResponse = z.infer<typeof SessionDetailResponseSchema>;
export type FsEntryType = z.infer<typeof FsEntryTypeSchema>;
export type GitStatusCode = z.infer<typeof GitStatusCodeSchema>;
export type FsEntry = z.infer<typeof FsEntrySchema>;
export type FsListResponse = z.infer<typeof FsListResponseSchema>;
export type FsReadResponse = z.infer<typeof FsReadResponseSchema>;
export type GitStatusEntry = z.infer<typeof GitStatusEntrySchema>;
export type GitStatusResponse = z.infer<typeof GitStatusResponseSchema>;
export type GitDiffResponse = z.infer<typeof GitDiffResponseSchema>;
export type GitInitRequest = z.infer<typeof GitInitRequestSchema>;
export type GitInitResponse = z.infer<typeof GitInitResponseSchema>;
export type LoginStartResponse = z.infer<typeof LoginStartResponseSchema>;
export type LoginFlowStatus = z.infer<typeof LoginFlowStatusSchema>;
export type LoginStatusResponse = z.infer<typeof LoginStatusResponseSchema>;
export type LoginCodeRequest = z.infer<typeof LoginCodeRequestSchema>;
export type ApprovalRespondRequest = z.infer<typeof ApprovalRespondRequestSchema>;
export type FsMkdirRequest = z.infer<typeof FsMkdirRequestSchema>;
export type FsMkdirResponse = z.infer<typeof FsMkdirResponseSchema>;
export type UsageLimitStatus = z.infer<typeof UsageLimitStatusSchema>;
export type UsageLimit = z.infer<typeof UsageLimitSchema>;
export type AgentUsage = z.infer<typeof AgentUsageSchema>;
export type UsageResponse = z.infer<typeof UsageResponseSchema>;
export type ModelOption = z.infer<typeof ModelOptionSchema>;
export type ModelsResponse = z.infer<typeof ModelsResponseSchema>;
export type ModelsQuery = z.infer<typeof ModelsQuerySchema>;

// ws: server → client
export type ServerEvent = z.infer<typeof ServerEventSchema>;
export type ServerEventType = ServerEvent["type"];
export type SessionSnapshotEvent = z.infer<typeof SessionSnapshotEventSchema>;
export type ItemStartedEvent = z.infer<typeof ItemStartedEventSchema>;
export type ItemDeltaField = z.infer<typeof ItemDeltaFieldSchema>;
export type ItemDeltaEvent = z.infer<typeof ItemDeltaEventSchema>;
export type ItemCompletedEvent = z.infer<typeof ItemCompletedEventSchema>;
export type ApprovalRequestedEvent = z.infer<typeof ApprovalRequestedEventSchema>;
export type ApprovalResolvedEvent = z.infer<typeof ApprovalResolvedEventSchema>;
export type SessionStatusEvent = z.infer<typeof SessionStatusEventSchema>;
export type SessionUsageEvent = z.infer<typeof SessionUsageEventSchema>;
export type TurnCompletedEvent = z.infer<typeof TurnCompletedEventSchema>;
export type ErrorEvent = z.infer<typeof ErrorEventSchema>;
export type PongEvent = z.infer<typeof PongEventSchema>;

// ws: client → server
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ClientMessageType = ClientMessage["type"];
export type TurnStartMessage = z.infer<typeof TurnStartMessageSchema>;
export type TurnInterruptMessage = z.infer<typeof TurnInterruptMessageSchema>;
export type ApprovalRespondMessage = z.infer<typeof ApprovalRespondMessageSchema>;
export type SessionSetModeMessage = z.infer<typeof SessionSetModeMessageSchema>;
export type PingMessage = z.infer<typeof PingMessageSchema>;

/** 서버 이벤트를 검증한다. 실패하면 `ZodError` 를 던진다. */
export function parseServerEvent(input: unknown): ServerEvent {
  return ServerEventSchema.parse(input);
}

/** 클라이언트 메시지를 검증한다. 실패하면 `ZodError` 를 던진다. */
export function parseClientMessage(input: unknown): ClientMessage {
  return ClientMessageSchema.parse(input);
}

/** 클라이언트 메시지를 검증한다. 던지지 않고 결과 객체를 돌려준다. */
export function safeParseClientMessage(input: unknown): z.ZodSafeParseResult<ClientMessage> {
  return ClientMessageSchema.safeParse(input);
}

// teams (2026-09-12 추가)
export type RoleId = z.infer<typeof RoleIdSchema>;
export type RolePreset = z.infer<typeof RolePresetSchema>;
export type TeamMemberState = z.infer<typeof TeamMemberStateSchema>;
export type TeamMember = z.infer<typeof TeamMemberSchema>;
export type TeamSettings = z.infer<typeof TeamSettingsSchema>;
export type RoomKind = z.infer<typeof RoomKindSchema>;
export type Room = z.infer<typeof RoomSchema>;
export type Team = z.infer<typeof TeamSchema>;
export type RoomAuthor = z.infer<typeof RoomAuthorSchema>;
export type WorkSummary = z.infer<typeof WorkSummarySchema>;
export type ChangeSetStatus = z.infer<typeof ChangeSetStatusSchema>;
export type ChangeSet = z.infer<typeof ChangeSetSchema>;
export type RoomMessageKind = z.infer<typeof RoomMessageKindSchema>;
export type RoomApproval = z.infer<typeof RoomApprovalSchema>;
export type RoomMessage = z.infer<typeof RoomMessageSchema>;
export type MergeResult = z.infer<typeof MergeResultSchema>;
export type RunningDispatch = z.infer<typeof RunningDispatchSchema>;
export type QueuedDispatch = z.infer<typeof QueuedDispatchSchema>;
export type DispatchState = z.infer<typeof DispatchStateSchema>;
export type TeamTemplateMember = z.infer<typeof TeamTemplateMemberSchema>;
export type TeamTemplate = z.infer<typeof TeamTemplateSchema>;
export type MemberInput = z.infer<typeof MemberInputSchema>;
export type CreateTeamRequest = z.infer<typeof CreateTeamRequestSchema>;
export type PatchTeamRequest = z.infer<typeof PatchTeamRequestSchema>;
export type PatchMemberRequest = z.infer<typeof PatchMemberRequestSchema>;
export type PostRoomMessageRequest = z.infer<typeof PostRoomMessageRequestSchema>;
export type CreateTeamTemplateRequest = z.infer<typeof CreateTeamTemplateRequestSchema>;
export type PatchTeamTemplateRequest = z.infer<typeof PatchTeamTemplateRequestSchema>;
export type TeamRolesResponse = z.infer<typeof TeamRolesResponseSchema>;
export type TeamsResponse = z.infer<typeof TeamsResponseSchema>;
export type TeamDetailResponse = z.infer<typeof TeamDetailResponseSchema>;
export type RoomDetailResponse = z.infer<typeof RoomDetailResponseSchema>;
export type PostRoomMessageResponse = z.infer<typeof PostRoomMessageResponseSchema>;
export type ChangesResponse = z.infer<typeof ChangesResponseSchema>;
export type TeamTemplatesResponse = z.infer<typeof TeamTemplatesResponseSchema>;

// room ws: server → client
export type RoomServerEvent = z.infer<typeof RoomServerEventSchema>;
export type RoomServerEventType = RoomServerEvent["type"];
export type RoomMemberStatus = z.infer<typeof RoomMemberStatusSchema>;
export type RoomSnapshotEvent = z.infer<typeof RoomSnapshotEventSchema>;
export type RoomMessageEvent = z.infer<typeof RoomMessageEventSchema>;
export type RoomMessageUpdatedEvent = z.infer<typeof RoomMessageUpdatedEventSchema>;
export type RoomStatusEvent = z.infer<typeof RoomStatusEventSchema>;
export type RoomErrorEvent = z.infer<typeof RoomErrorEventSchema>;
export type RoomPongEvent = z.infer<typeof RoomPongEventSchema>;

// room ws: client → server
export type RoomClientMessage = z.infer<typeof RoomClientMessageSchema>;
export type RoomClientMessageType = RoomClientMessage["type"];
export type RoomSendMessage = z.infer<typeof RoomSendMessageSchema>;
export type RoomInterruptMessage = z.infer<typeof RoomInterruptMessageSchema>;
export type RoomPingMessage = z.infer<typeof RoomPingMessageSchema>;

/** 방 서버 이벤트를 검증한다. 실패하면 `ZodError` 를 던진다. */
export function parseRoomServerEvent(input: unknown): RoomServerEvent {
  return RoomServerEventSchema.parse(input);
}

/** 방 클라이언트 메시지를 검증한다. 실패하면 `ZodError` 를 던진다. */
export function parseRoomClientMessage(input: unknown): RoomClientMessage {
  return RoomClientMessageSchema.parse(input);
}

/** 방 클라이언트 메시지를 검증한다. 던지지 않고 결과 객체를 돌려준다. */
export function safeParseRoomClientMessage(input: unknown): z.ZodSafeParseResult<RoomClientMessage> {
  return RoomClientMessageSchema.safeParse(input);
}
