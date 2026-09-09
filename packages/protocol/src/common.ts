import { z } from "zod";

/** 클라이언트가 `X-MAM-Protocol` 헤더로 보내는 계약 버전. */
export const PROTOCOL_VERSION = 1 as const;

export const AgentKindSchema = z.enum(["claude", "codex"]);

export const SessionModeSchema = z.enum(["ask", "auto-edit", "full-auto", "plan"]);

export const SessionStatusSchema = z.enum([
  "starting",
  "idle",
  "running",
  "waiting_approval",
  "error",
  "closed",
]);

export const ItemStatusSchema = z.enum(["running", "completed", "failed", "cancelled"]);

/** ISO-8601 문자열. Date 로 변환하지 않는다(클라이언트 언어별 처리). */
export const IsoDateSchema = z.iso.datetime({ offset: true });

/** Crockford base32 26자 (ULID). */
const ULID_BODY = "[0-9A-HJKMNP-TV-Z]{26}";

/** `<prefix>` + 26자 ULID 형태의 ID 스키마. 예: `idSchema("ses_")`. */
export function idSchema(prefix: string): z.ZodString {
  const re = new RegExp(`^${prefix}${ULID_BODY}$`);
  return z.string().regex(re, { message: `expected ${prefix}<ULID>` });
}

export const SessionIdSchema = idSchema("ses_");
export const ItemIdSchema = idSchema("itm_");
export const ApprovalIdSchema = idSchema("apr_");
export const TurnIdSchema = idSchema("trn_");
export const FlowIdSchema = idSchema("flw_");

/** 세션 내 단조 증가 이벤트 번호. 0 이상의 정수. */
export const SeqSchema = z.int().min(0);

export const ErrorCodeSchema = z.enum([
  "not_found",
  "forbidden",
  "invalid_request",
  "conflict",
  "agent_unavailable",
  "internal",
]);

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
  }),
});
