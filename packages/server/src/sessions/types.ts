import { SessionSchema } from "@mam/protocol";
import { z } from "zod";

/**
 * `~/.mam/sessions/<id>.json` 의 내부 영속 레코드(2026-09-12 추가).
 * 프로토콜 `Session` 에 역할 프롬프트 `instructions` 를 더한 것이다. 이 키는 어댑터 시작 옵션으로만 쓰고
 * `list/get/detail/patch` 응답의 `Session` 에는 넣지 않는다(프로토콜 스키마에 없는 키는 개발 모드 응답 검증에 실패한다).
 * `team` 은 프로토콜 필드라 `Session` 에 그대로 남는다. 키가 없는 기존 레코드도 통과한다.
 */
export const SessionRecordSchema = SessionSchema.extend({
  instructions: z.string().optional(),
});

export type SessionRecord = z.infer<typeof SessionRecordSchema>;

/** `SessionManager.create()` 가 받는 팀·프롬프트 확장 옵션. `POST /sessions` 라우트는 쓰지 않는다. */
export interface CreateSessionExtras {
  /** 역할 프롬프트 전문. 최초 시작과 재개 모두 어댑터 `StartOptions.instructions` 로 넘긴다. */
  instructions?: string;
  /** 팀원 세션의 소속. 응답 `Session.team` 으로 나간다. */
  team?: { teamId: string; memberId: string };
  /** 초기 사고 수준(팀원 세션). 검증 없이 저장하고 `StartOptions.effort` 로 넘긴다. */
  effort?: string;
  /** true 면 어댑터를 띄우지 않고 `idle`, `nativeId: null` 로 등록·영속화만 한다. 첫 `startTurn` 이 프로세스를 연다. */
  deferStart?: boolean;
}
