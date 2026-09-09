import { z } from "zod";
import {
  AgentKindSchema,
  IsoDateSchema,
  SeqSchema,
  SessionIdSchema,
  SessionModeSchema,
  SessionStatusSchema,
} from "./common.js";

export const UsageSchema = z.object({
  inputTokens: z.int().min(0),
  outputTokens: z.int().min(0),
  cacheReadTokens: z.int().min(0).optional(),
});

export const AttachmentSchema = z.object({
  kind: z.literal("image"),
  mediaType: z.string().min(1),
  base64: z.string().min(1),
});

/** 사용자 턴 입력. `text` 는 최소 1자. */
export const TurnInputSchema = z.object({
  text: z.string().min(1),
  attachments: z.array(AttachmentSchema).optional(),
});

export const SessionSchema = z.object({
  id: SessionIdSchema,
  agent: AgentKindSchema,
  cwd: z.string().min(1),
  title: z.string(),
  mode: SessionModeSchema,
  model: z.string().nullable(),
  status: SessionStatusSchema,
  nativeId: z.string().nullable(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  lastSeq: SeqSchema,
  pendingApprovals: z.int().min(0),
  preview: z.string().nullable(),
});

export const CreateSessionRequestSchema = z.object({
  agent: AgentKindSchema,
  cwd: z.string().min(1),
  title: z.string().optional(),
  mode: SessionModeSchema.optional(),
  model: z.string().optional(),
  resumeNativeId: z.string().optional(),
});

export const PatchSessionRequestSchema = z.object({
  title: z.string().optional(),
  mode: SessionModeSchema.optional(),
});
