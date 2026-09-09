import type { z } from "zod";
import { ClientMessageSchema, ServerEventSchema } from "./ws.js";
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
  SessionSchema,
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
  ApprovalRespondRequestSchema,
  FsEntrySchema,
  FsEntryTypeSchema,
  FsListResponseSchema,
  FsReadResponseSchema,
  GitDiffResponseSchema,
  GitStatusCodeSchema,
  GitStatusEntrySchema,
  GitStatusResponseSchema,
  LoginCodeRequestSchema,
  LoginFlowStatusSchema,
  LoginStartResponseSchema,
  LoginStatusResponseSchema,
  MeResponseSchema,
  OkResponseSchema,
  ProjectSchema,
  ProjectsResponseSchema,
  SessionDetailResponseSchema,
  SessionsResponseSchema,
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
  TurnCompletedEventSchema,
  TurnInterruptMessageSchema,
  TurnStartMessageSchema,
} from "./ws.js";

export * from "./common.js";
export * from "./session.js";
export * from "./approval.js";
export * from "./timeline.js";
export * from "./rest.js";
export * from "./ws.js";

// common
export type AgentKind = z.infer<typeof AgentKindSchema>;
export type SessionMode = z.infer<typeof SessionModeSchema>;
export type SessionStatus = z.infer<typeof SessionStatusSchema>;
export type ItemStatus = z.infer<typeof ItemStatusSchema>;
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

// session
export type Usage = z.infer<typeof UsageSchema>;
export type Attachment = z.infer<typeof AttachmentSchema>;
export type TurnInput = z.infer<typeof TurnInputSchema>;
export type Session = z.infer<typeof SessionSchema>;
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
export type LoginStartResponse = z.infer<typeof LoginStartResponseSchema>;
export type LoginFlowStatus = z.infer<typeof LoginFlowStatusSchema>;
export type LoginStatusResponse = z.infer<typeof LoginStatusResponseSchema>;
export type LoginCodeRequest = z.infer<typeof LoginCodeRequestSchema>;
export type ApprovalRespondRequest = z.infer<typeof ApprovalRespondRequestSchema>;

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
