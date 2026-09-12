import type { TeamMember } from "@mam/protocol";

/**
 * 방 메시지의 `@멘션` 파서(PROTOCOL 6.4). `@` 뒤에 이름 또는 핸들, `@all` 은 작성자 제외 전원.
 * 이름 중복은 저장 시 409 로 막으므로 모호성은 다루지 않는다. 텍스트는 바꾸지 않는다.
 */

export interface MentionResult {
  /** 멘션된 팀원 ID(중복 제거, 작성자 제외). `all` 이면 작성자 제외 전원. */
  memberIds: string[];
  all: boolean;
  /** 어떤 팀원과도 맞지 않은 토큰(원문, 중복 제거). */
  unknown: string[];
}

const MENTION_RE = /@([\p{L}\p{N}_.\-]+)/gu;
const TRAILING_PUNCT_RE = /[.,!?:;)\]}"']+$/u;

/** NFC + 소문자 + trim. 이름·핸들 비교에 쓴다. */
export function normalizeName(s: string): string {
  return s.normalize("NFC").toLowerCase().trim();
}

export function parseMentions(
  text: string,
  members: Array<Pick<TeamMember, "id" | "name" | "handle">>,
  opts: { excludeMemberId?: string } = {},
): MentionResult {
  const byKey = new Map<string, string>();
  for (const m of members) {
    byKey.set(normalizeName(m.handle), m.id);
    byKey.set(normalizeName(m.name), m.id);
  }
  const memberIds = new Set<string>();
  const unknown = new Set<string>();
  let all = false;
  for (const match of text.matchAll(MENTION_RE)) {
    const token = match[1]!.replace(TRAILING_PUNCT_RE, "");
    if (token === "") continue;
    const key = normalizeName(token);
    if (key === "all") {
      all = true;
      continue;
    }
    const id = byKey.get(key);
    if (id === undefined) unknown.add(token);
    else memberIds.add(id);
  }
  if (all) for (const m of members) memberIds.add(m.id);
  if (opts.excludeMemberId !== undefined) memberIds.delete(opts.excludeMemberId);
  return { memberIds: [...memberIds], all, unknown: [...unknown] };
}
