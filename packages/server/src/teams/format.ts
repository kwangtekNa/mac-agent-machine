import type { Room, RoomMessage, TeamMember } from "@mam/protocol";

/**
 * 팀원 세션에 보내는 턴 입력 텍스트(PROTOCOL 6.4 "턴 입력"): 방 맥락 한 줄씩 + 트리거 메시지 + 영어 꼬리말.
 * 순수 함수. 메시지 본문은 요약·번역하지 않고 접두어만 붙인다.
 */

type MemberRef = Pick<TeamMember, "id" | "name" | "roleLabel">;
type RoomRef = Pick<Room, "id" | "kind" | "name">;

export interface FormatInput {
  member: MemberRef;
  members: MemberRef[];
  rooms: RoomRef[];
  /** `seq > lastSeen` 인 메시지들, 방 구분 없이 createdAt 순. */
  context: RoomMessage[];
  /** 마지막에 놓인다(`context` 에 이미 있어도 한 번만). */
  trigger: RoomMessage;
  /** 맥락 메시지 수 상한(트리거 제외). */
  maxMessages: number;
  /** 맥락 + 트리거를 합친 렌더 문자 수 상한. 트리거는 상한을 넘어도 항상 넣는다. */
  maxChars: number;
  /** step 6 이 넣는 worktree 충돌 안내. 있으면 맨 앞. */
  conflictNote?: string;
}

const APPROVAL_OUTCOME: Record<string, string> = {
  allow: "허용됨",
  allow_session: "허용됨",
  deny: "거절됨",
  abort: "중단됨",
  submit: "제출됨",
  cancel: "취소됨",
};

const CHANGE_STATUS: Record<string, string> = {
  merging: "머지 중",
  merged: "머지됨",
  conflict: "충돌",
  dismissed: "무시됨",
  stale: "대체됨",
};

function roomPrefix(roomId: string, rooms: RoomRef[]): string {
  const room = rooms.find((r) => r.id === roomId);
  if (room?.kind === "dm") return "[DM]";
  return `[#${room?.name ?? "전체"}]`;
}

function memberName(memberId: string, members: MemberRef[]): string {
  return members.find((m) => m.id === memberId)?.name ?? memberId;
}

function authorLabel(message: RoomMessage, members: MemberRef[]): string {
  const author = message.author;
  switch (author.kind) {
    case "user":
      return "사용자";
    case "system":
      return "시스템";
    case "agent": {
      const member = members.find((m) => m.id === author.memberId);
      return `@${member?.name ?? author.memberId}(${member?.roleLabel ?? "팀원"})`;
    }
  }
}

/** 맥락에는 더 이상 쓰이지 않는다(`isContextRelevant` 가 카드를 전부 거른다). 트리거가 승인 카드일 때 `formatMessageLine` 이 쓴다. */
function approvalSummary(message: RoomMessage, members: MemberRef[]): string {
  const approval = message.approval;
  const who = approval ? memberName(approval.memberId, members) : authorLabel(message, members);
  let outcome = "대기 중";
  if (approval?.resolution) {
    const optionId = approval.resolution.optionId;
    outcome = APPROVAL_OUTCOME[optionId] ?? approval.approval.options.find((o) => o.id === optionId)?.label ?? optionId;
  }
  return `${who}의 승인 요청 '${message.text}' — ${outcome}`;
}

/** 맥락에는 더 이상 쓰이지 않는다(`isContextRelevant` 가 카드를 전부 거른다). 트리거가 변경 카드일 때 `formatMessageLine` 이 쓴다. */
function changesSummary(message: RoomMessage, members: MemberRef[]): string {
  const changes = message.changes;
  const who = changes ? memberName(changes.memberId, members) : authorLabel(message, members);
  const count = changes?.files.length ?? 0;
  const status = changes ? CHANGE_STATUS[changes.status] : undefined;
  return `${who}의 변경 준비됨: ${count}개 파일${status ? ` — ${status}` : ""}`;
}

/**
 * 한 메시지를 한 줄로: `[#전체] 사용자: …` / `[DM] 사용자: …` / `[#전체] @민수(개발자): …` / `[#전체] 시스템: …`.
 * 승인·변경 카드는 시스템 줄로 한 줄 요약한다(도구 상세 없음). 본문은 줄바꿈을 포함해 그대로 둔다.
 */
export function formatMessageLine(message: RoomMessage, members: MemberRef[], rooms: RoomRef[]): string {
  const prefix = roomPrefix(message.roomId, rooms);
  switch (message.kind) {
    case "approval":
      return `${prefix} 시스템: ${approvalSummary(message, members)}`;
    case "changes":
      return `${prefix} 시스템: ${changesSummary(message, members)}`;
    case "system":
      return `${prefix} 시스템: ${message.text}`;
    case "text":
      return `${prefix} ${authorLabel(message, members)}: ${message.text}`;
  }
}

/**
 * 이 팀원의 턴 입력에 넣을 메시지인가(PROTOCOL 6.4 "턴 입력", 2026-09-15 갱신). `memberId` 는 턴을 도는 팀원.
 * 승인·변경 카드는 **자기 것까지 전부** 뺀다: 남의 카드는 제목이 bash 명령 원문이라 길기만 하고, 자기가 실행한 명령과
 * 바꾼 파일은 그 팀원 세션 타임라인에 이미 있다. 카드는 방 화면·방 로그에는 그대로 남는다(사람이 승인·머지해야 한다).
 * 자기 `text` 도 세션이 이미 기억하므로 뺀다. `system` 은 홉 상한·서버 재시작·곁방 연결·머지 충돌 지시를 나르므로 반드시 넣는다.
 */
export function isContextRelevant(message: RoomMessage, memberId: string): boolean {
  switch (message.kind) {
    case "approval":
    case "changes":
      return false;
    case "text":
      return !(message.author.kind === "agent" && message.author.memberId === memberId);
    case "system":
      return true;
  }
}

function footer(trigger: RoomMessage, rooms: RoomRef[]): string {
  const room = rooms.find((r) => r.id === trigger.roomId);
  if (room?.kind === "dm") return "Reply in this DM.";
  return `Reply for room #${room?.name ?? "전체"}. Address teammates with @name only when they must act.`;
}

/**
 * 맥락(오래된 것부터 버림, `maxMessages`/`maxChars`) + 트리거(항상 마지막, 한 번만) + 꼬리말.
 * 맥락은 `isContextRelevant` 로 먼저 거른다(자기 `text` 와 모든 승인·변경 카드를 뺀다). 트리거는 필터와 무관하게 항상 마지막에 들어간다.
 * 넘쳐서 버린 개수가 `omitted` 이고, 있으면 `(이전 메시지 N개 생략)` 한 줄을 맥락 앞에 둔다.
 */
export function buildTurnText(input: FormatInput): { text: string; omitted: number } {
  const { member, members, rooms, trigger, maxMessages, maxChars } = input;
  const candidates = input.context.filter((m) => m.id !== trigger.id && isContextRelevant(m, member.id));
  const triggerLine = formatMessageLine(trigger, members, rooms);

  const kept: string[] = [];
  let used = triggerLine.length;
  let i = candidates.length - 1;
  for (; i >= 0 && kept.length < maxMessages; i--) {
    const line = formatMessageLine(candidates[i]!, members, rooms);
    if (used + 1 + line.length > maxChars) break;
    used += 1 + line.length;
    kept.unshift(line);
  }
  const omitted = i + 1; // 상한 때문에 버린 개수만 센다(필터로 뺀 것은 애초에 그 팀원의 대화가 아니다)

  const parts: string[] = [];
  if (input.conflictNote !== undefined && input.conflictNote !== "") parts.push(input.conflictNote, "");
  if (omitted > 0) parts.push(`(이전 메시지 ${omitted}개 생략)`);
  parts.push(...kept, triggerLine, "", footer(trigger, rooms));
  return { text: parts.join("\n"), omitted };
}
