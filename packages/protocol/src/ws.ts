import { z } from "zod";
import { ApprovalResolvedBySchema, ApprovalSchema } from "./approval.js";
import {
  ApprovalIdSchema,
  IsoDateSchema,
  ItemIdSchema,
  SeqSchema,
  SessionIdSchema,
  SessionModeSchema,
  SessionStatusSchema,
  TurnIdSchema,
} from "./common.js";
import { ApprovalRespondFieldsSchema } from "./rest.js";
import { SessionSchema, TurnInputSchema, UsageSchema } from "./session.js";
import { TimelineItemSchema } from "./timeline.js";

/** 모든 서버 이벤트의 공통 필드. */
const ServerEventBaseSchema = z.object({
  seq: SeqSchema,
  sessionId: SessionIdSchema,
  ts: IsoDateSchema,
});

export const SessionSnapshotEventSchema = ServerEventBaseSchema.extend({
  type: z.literal("session.snapshot"),
  seq: z.literal(0),
  session: SessionSchema,
  items: z.array(TimelineItemSchema),
  pendingApprovals: z.array(ApprovalSchema),
  replayFrom: SeqSchema,
  truncated: z.boolean(),
});

export const ItemStartedEventSchema = ServerEventBaseSchema.extend({
  type: z.literal("item.started"),
  item: TimelineItemSchema,
});

export const ItemDeltaFieldSchema = z.enum(["text", "output", "patch"]);

export const ItemDeltaEventSchema = ServerEventBaseSchema.extend({
  type: z.literal("item.delta"),
  itemId: ItemIdSchema,
  field: ItemDeltaFieldSchema,
  delta: z.string(),
});

export const ItemCompletedEventSchema = ServerEventBaseSchema.extend({
  type: z.literal("item.completed"),
  item: TimelineItemSchema,
});

export const ApprovalRequestedEventSchema = ServerEventBaseSchema.extend({
  type: z.literal("approval.requested"),
  approval: ApprovalSchema,
});

export const ApprovalResolvedEventSchema = ServerEventBaseSchema.extend({
  type: z.literal("approval.resolved"),
  approvalId: ApprovalIdSchema,
  optionId: z.string().min(1),
  by: ApprovalResolvedBySchema,
});

export const SessionStatusEventSchema = ServerEventBaseSchema.extend({
  type: z.literal("session.status"),
  status: SessionStatusSchema,
  mode: SessionModeSchema,
  reason: z.string().optional(),
});

export const TurnCompletedEventSchema = ServerEventBaseSchema.extend({
  type: z.literal("turn.completed"),
  turnId: TurnIdSchema,
  durationMs: z.int().min(0),
  usage: UsageSchema,
  costUsd: z.number().min(0).optional(),
  stopReason: z.string(),
});

export const ErrorEventSchema = ServerEventBaseSchema.extend({
  type: z.literal("error"),
  message: z.string(),
  recoverable: z.boolean(),
});

export const PongEventSchema = ServerEventBaseSchema.extend({
  type: z.literal("pong"),
  seq: z.literal(0),
});

export const ServerEventSchema = z.discriminatedUnion("type", [
  SessionSnapshotEventSchema,
  ItemStartedEventSchema,
  ItemDeltaEventSchema,
  ItemCompletedEventSchema,
  ApprovalRequestedEventSchema,
  ApprovalResolvedEventSchema,
  SessionStatusEventSchema,
  TurnCompletedEventSchema,
  ErrorEventSchema,
  PongEventSchema,
]);

export const TurnStartMessageSchema = TurnInputSchema.extend({
  type: z.literal("turn.start"),
});

export const TurnInterruptMessageSchema = z.object({
  type: z.literal("turn.interrupt"),
});

export const ApprovalRespondMessageSchema = ApprovalRespondFieldsSchema.extend({
  type: z.literal("approval.respond"),
});

export const SessionSetModeMessageSchema = z.object({
  type: z.literal("session.setMode"),
  mode: SessionModeSchema,
});

export const PingMessageSchema = z.object({
  type: z.literal("ping"),
});

export const ClientMessageSchema = z.discriminatedUnion("type", [
  TurnStartMessageSchema,
  TurnInterruptMessageSchema,
  ApprovalRespondMessageSchema,
  SessionSetModeMessageSchema,
  PingMessageSchema,
]);
