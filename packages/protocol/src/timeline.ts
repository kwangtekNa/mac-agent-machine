import { z } from "zod";
import { ApprovalResolutionSchema, ApprovalSchema } from "./approval.js";
import { IsoDateSchema, ItemIdSchema, ItemStatusSchema, SeqSchema, TurnIdSchema } from "./common.js";
import { AttachmentSchema, UsageSchema } from "./session.js";

export const ToolNameSchema = z.enum([
  "bash",
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "web",
  "mcp",
  "task",
  "other",
]);

export const UserMessagePayloadSchema = z.object({
  text: z.string(),
  attachments: z.array(AttachmentSchema),
});

export const AssistantMessagePhaseSchema = z.enum(["commentary", "final"]);

export const AssistantMessagePayloadSchema = z.object({
  text: z.string(),
  phase: AssistantMessagePhaseSchema,
});

export const ReasoningPayloadSchema = z.object({
  text: z.string(),
});

export const ToolCallPayloadSchema = z.object({
  tool: ToolNameSchema,
  name: z.string(),
  title: z.string(),
  input: z.record(z.string(), z.unknown()),
  output: z.string(),
  exitCode: z.int().nullable(),
  truncated: z.boolean(),
});

export const FileChangeKindSchema = z.enum(["add", "modify", "delete", "rename"]);

export const FileChangeEntrySchema = z.object({
  path: z.string().min(1),
  kind: FileChangeKindSchema,
  additions: z.int().min(0),
  deletions: z.int().min(0),
});

export const FileChangePayloadSchema = z.object({
  files: z.array(FileChangeEntrySchema),
  patch: z.string(),
});

export const PlanStepStatusSchema = z.enum(["pending", "in_progress", "completed"]);

export const PlanStepSchema = z.object({
  text: z.string(),
  status: PlanStepStatusSchema,
});

export const PlanPayloadSchema = z.object({
  steps: z.array(PlanStepSchema),
});

export const ApprovalPayloadSchema = ApprovalSchema.extend({
  resolution: ApprovalResolutionSchema.optional(),
});

export const TurnSummaryPayloadSchema = z.object({
  durationMs: z.int().min(0),
  usage: UsageSchema,
  costUsd: z.number().min(0).optional(),
  stopReason: z.string(),
});

export const ErrorPayloadSchema = z.object({
  message: z.string(),
  recoverable: z.boolean(),
});

export const SystemPayloadSchema = z.object({
  text: z.string(),
});

const TimelineItemBaseSchema = z.object({
  id: ItemIdSchema,
  seq: SeqSchema,
  turnId: TurnIdSchema.nullable(),
  status: ItemStatusSchema,
  createdAt: IsoDateSchema,
  completedAt: IsoDateSchema.nullable(),
});

export const UserMessageItemSchema = TimelineItemBaseSchema.extend({
  kind: z.literal("user_message"),
  payload: UserMessagePayloadSchema,
});
export const AssistantMessageItemSchema = TimelineItemBaseSchema.extend({
  kind: z.literal("assistant_message"),
  payload: AssistantMessagePayloadSchema,
});
export const ReasoningItemSchema = TimelineItemBaseSchema.extend({
  kind: z.literal("reasoning"),
  payload: ReasoningPayloadSchema,
});
export const ToolCallItemSchema = TimelineItemBaseSchema.extend({
  kind: z.literal("tool_call"),
  payload: ToolCallPayloadSchema,
});
export const FileChangeItemSchema = TimelineItemBaseSchema.extend({
  kind: z.literal("file_change"),
  payload: FileChangePayloadSchema,
});
export const PlanItemSchema = TimelineItemBaseSchema.extend({
  kind: z.literal("plan"),
  payload: PlanPayloadSchema,
});
export const ApprovalItemSchema = TimelineItemBaseSchema.extend({
  kind: z.literal("approval"),
  payload: ApprovalPayloadSchema,
});
export const TurnSummaryItemSchema = TimelineItemBaseSchema.extend({
  kind: z.literal("turn_summary"),
  payload: TurnSummaryPayloadSchema,
});
export const ErrorItemSchema = TimelineItemBaseSchema.extend({
  kind: z.literal("error"),
  payload: ErrorPayloadSchema,
});
export const SystemItemSchema = TimelineItemBaseSchema.extend({
  kind: z.literal("system"),
  payload: SystemPayloadSchema,
});

export const TimelineItemSchema = z.discriminatedUnion("kind", [
  UserMessageItemSchema,
  AssistantMessageItemSchema,
  ReasoningItemSchema,
  ToolCallItemSchema,
  FileChangeItemSchema,
  PlanItemSchema,
  ApprovalItemSchema,
  TurnSummaryItemSchema,
  ErrorItemSchema,
  SystemItemSchema,
]);

export const TimelineItemKindSchema = z.enum([
  "user_message",
  "assistant_message",
  "reasoning",
  "tool_call",
  "file_change",
  "plan",
  "approval",
  "turn_summary",
  "error",
  "system",
]);
