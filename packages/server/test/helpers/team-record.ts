import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { TeamRecord } from "../../src/teams/types.js";

const FIXTURE = fileURLToPath(new URL("../../../protocol/fixtures/rest/team.json", import.meta.url));

/** `fixtures/rest/team.json`(팀 backend: 민수/minsu 팀장 + 지연/jiyeon 개발자, 그룹방 + DM 2)을 `lastSeen` 을 채운 TeamRecord 로. */
export function makeTeamRecord(overrides: Partial<TeamRecord> = {}): TeamRecord {
  const team = JSON.parse(readFileSync(FIXTURE, "utf8")) as TeamRecord;
  const record: TeamRecord = {
    ...team,
    members: team.members.map((m) => ({ ...m, lastSeen: {} })),
    rooms: team.rooms.map((r) => ({ ...r, lastSeq: 0, lastMessageAt: null })),
    ...overrides,
  };
  return record;
}

export const GROUP_ROOM = "room_01J8ZQ4K5N7P9R3S6T8V0W2XR0";
export const DM_MINSU = "room_01J8ZQ4K5N7P9R3S6T8V0W2XR1";
export const DM_JIYEON = "room_01J8ZQ4K5N7P9R3S6T8V0W2XR2";
export const MINSU = "agt_01J8ZQ4K5N7P9R3S6T8V0W2XA1";
export const JIYEON = "agt_01J8ZQ4K5N7P9R3S6T8V0W2XA2";
