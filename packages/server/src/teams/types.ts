import { TeamMemberSchema, TeamSchema } from "@mam/protocol";
import { z } from "zod";

/**
 * `~/.mam/teams/<teamId>/team.json` 의 내부 레코드(2026-09-12 추가).
 * 프로토콜 `Team` 에 팀원별 `lastSeen`(방 ID → 그 팀원의 세션에 마지막으로 전달한 방 seq)을 더한 것이다.
 * 응답으로 나갈 때는 `toTeam()` 이 `TeamSchema` 로 다시 파싱해 `lastSeen` 을 떨어뜨린다.
 * `lastSeen` 이 없는 레코드도 통과한다(`{}` 기본값).
 */
export const TeamMemberRecordSchema = TeamMemberSchema.extend({
  lastSeen: z.record(z.string(), z.int().min(0)).default({}),
});

export const TeamRecordSchema = TeamSchema.extend({
  members: z.array(TeamMemberRecordSchema),
});

export type TeamMemberRecord = z.infer<typeof TeamMemberRecordSchema>;
export type TeamRecord = z.infer<typeof TeamRecordSchema>;
