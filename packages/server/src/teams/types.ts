import { TeamMemberSchema, TeamSchema, TeamSettingsSchema } from "@mam/protocol";
import { z } from "zod";

/**
 * `~/.mam/teams/<teamId>/team.json` 의 내부 레코드(2026-09-12 추가).
 * 프로토콜 `Team` 에 팀원별 `lastSeen`(방 ID → 그 팀원의 세션에 마지막으로 전달한 방 seq)을 더한 것이다.
 * 응답으로 나갈 때는 `toTeam()` 이 `TeamSchema` 로 다시 파싱해 `lastSeen` 을 떨어뜨린다.
 * `lastSeen` 이 없는 레코드도 통과한다(`{}` 기본값). 방 레코드는 곁방의 `participants` 를 그대로 담고(`toTeam` 이 내보낸다),
 * `settings.sideRoomMaxParticipants` 가 없는 구 레코드는 기본값으로 채워 읽는다(2026-09-14 추가).
 */
export const TeamMemberRecordSchema = TeamMemberSchema.extend({
  lastSeen: z.record(z.string(), z.int().min(0)).default({}),
});

/** `TeamSettings.sideRoomMaxParticipants` 기본값(PROTOCOL 6.1·6.6, 2026-09-14 추가). */
export const DEFAULT_SIDE_ROOM_MAX_PARTICIPANTS = 3;

export const TeamRecordSchema = TeamSchema.extend({
  members: z.array(TeamMemberRecordSchema),
  /** 2026-09-14 이전 레코드에는 `sideRoomMaxParticipants` 가 없다. 읽을 때 기본값을 채운다(파일 저장은 다음 변경 때). */
  settings: TeamSettingsSchema.extend({
    sideRoomMaxParticipants: TeamSettingsSchema.shape.sideRoomMaxParticipants.default(DEFAULT_SIDE_ROOM_MAX_PARTICIPANTS),
  }),
});

export type TeamMemberRecord = z.infer<typeof TeamMemberRecordSchema>;
export type TeamRecord = z.infer<typeof TeamRecordSchema>;
