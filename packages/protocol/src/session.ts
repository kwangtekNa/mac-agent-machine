import { z } from "zod";
import {
  AgentKindSchema,
  IsoDateSchema,
  SeqSchema,
  SessionIdSchema,
  SessionModeSchema,
  SessionStatusSchema,
} from "./common.js";

/** 턴별 토큰 사용량(`turn.completed`, `turn_summary`). 캐시 필드는 키를 생략할 수 있다. */
export const UsageSchema = z.object({
  inputTokens: z.int().min(0),
  outputTokens: z.int().min(0),
  cacheReadTokens: z.int().min(0).optional(),
  cacheWriteTokens: z.int().min(0).optional(),
});

/** 마지막 턴 기준 컨텍스트 크기와 모델 컨텍스트 창. `percent` 는 정수 0~100. */
export const SessionContextSchema = z.object({
  tokens: z.int().min(0),
  window: z.int().min(1),
  percent: z.int().min(0).max(100),
});

/** 세션 누적 토큰·비용과 현재 컨텍스트(2026-09-10 추가). `Session.usage` 와 `session.usage` 이벤트가 공유한다. */
export const SessionUsageSchema = z.object({
  inputTokens: z.int().min(0),
  outputTokens: z.int().min(0),
  cacheReadTokens: z.int().min(0),
  cacheWriteTokens: z.int().min(0),
  /** 어댑터가 추정값을 주지 않으면 `null`(Codex 구독 계정). */
  costUsd: z.number().min(0).nullable(),
  turns: z.int().min(0),
  /** 모르면 `null`. */
  context: SessionContextSchema.nullable(),
  updatedAt: IsoDateSchema,
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
  /**
   * 어댑터가 보고한 사고 수준(2026-09-10 추가). 모르면 `null`.
   * 서버는 항상 키를 보내지만(0절), 서버가 채우기 전 응답과 구 세션 메타 파일을 읽기 위해 키 생략도 허용한다.
   */
  effort: z.string().nullable().optional(),
  status: SessionStatusSchema,
  nativeId: z.string().nullable(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  lastSeq: SeqSchema,
  pendingApprovals: z.int().min(0),
  preview: z.string().nullable(),
  /** 누적 사용량(2026-09-10 추가). 첫 턴 전에는 `null`. 키 생략 허용 사유는 `effort` 와 같다. */
  usage: SessionUsageSchema.nullable().optional(),
});

export const CreateSessionRequestSchema = z.object({
  agent: AgentKindSchema,
  cwd: z.string().min(1),
  title: z.string().optional(),
  mode: SessionModeSchema.optional(),
  model: z.string().optional(),
  resumeNativeId: z.string().optional(),
});

/** `model`/`effort` 는 `GET /models` 가 준 값이어야 한다(서버가 400). 적용 시점은 어댑터가 정한다. */
export const PatchSessionRequestSchema = z.object({
  title: z.string().optional(),
  mode: SessionModeSchema.optional(),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
});
