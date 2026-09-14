import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RoomMessage, RoomServerEvent } from "@mam/protocol";
import { describe, expect, it } from "vitest";
import { buildTurnText, formatMessageLine, isContextRelevant, type FormatInput } from "../../src/teams/format.js";
import { DM_MINSU, GROUP_ROOM, JIYEON, MINSU, makeTeamRecord } from "../helpers/team-record.js";

const team = makeTeamRecord();
const members = team.members.map((m) => ({ id: m.id, name: m.name, roleLabel: m.roleLabel }));
const rooms = team.rooms.map((r) => ({ id: r.id, kind: r.kind, name: r.name }));
const minsu = members.find((m) => m.id === MINSU)!;
const jiyeon = members.find((m) => m.id === JIYEON)!;

function fixtureMessage(name: string): RoomMessage {
  const path = fileURLToPath(new URL(`../../../protocol/fixtures/room-ws/${name}.json`, import.meta.url));
  const event = JSON.parse(readFileSync(path, "utf8")) as Extract<RoomServerEvent, { type: "room.message" }>;
  return event.message;
}

let n = 0;
function msg(over: Partial<RoomMessage> & { text: string }): RoomMessage {
  n += 1;
  return {
    id: `msg_01J8ZQ4K5N7P9R3S6T8V0W2X${String(n).padStart(3, "0").slice(-2)}${n % 10}`,
    roomId: GROUP_ROOM,
    seq: n,
    author: { kind: "user" },
    kind: "text",
    mentions: [],
    hop: 0,
    dispatchId: null,
    createdAt: new Date(Date.UTC(2026, 8, 12, 9, 0, n)).toISOString(),
    work: null,
    approval: null,
    changes: null,
    ...over,
  };
}

function build(over: Partial<FormatInput>): ReturnType<typeof buildTurnText> {
  const trigger = over.trigger ?? msg({ text: "@민수 시작해줘", mentions: [MINSU] });
  return buildTurnText({ member: minsu, members, rooms, context: [], trigger, maxMessages: 40, maxChars: 12_000, ...over });
}

describe("formatMessageLine", () => {
  it("renders the exact prefixes from PROTOCOL 6.4", () => {
    expect(formatMessageLine(msg({ text: "로그인 버그 고쳐줘" }), members, rooms)).toBe("[#전체] 사용자: 로그인 버그 고쳐줘");
    expect(formatMessageLine(msg({ text: "DM 이야", roomId: DM_MINSU }), members, rooms)).toBe("[DM] 사용자: DM 이야");
    expect(formatMessageLine(msg({ text: "@지연 부탁해", author: { kind: "agent", memberId: MINSU } }), members, rooms)).toBe("[#전체] @민수(팀장): @지연 부탁해");
    expect(formatMessageLine(msg({ text: "끝났어요", author: { kind: "agent", memberId: JIYEON }, roomId: DM_MINSU }), members, rooms)).toBe("[DM] @지연(개발자): 끝났어요");
    expect(formatMessageLine(msg({ text: "지연이 합류했습니다", author: { kind: "system" }, kind: "system" }), members, rooms)).toBe("[#전체] 시스템: 지연이 합류했습니다");
  });

  it("matches the fixtures for user, agent and system messages", () => {
    expect(formatMessageLine(fixtureMessage("room.message.user"), members, rooms)).toBe("[#전체] 사용자: @민수 로그인 버그를 고치고 테스트를 돌려줘");
    expect(formatMessageLine(fixtureMessage("room.message.agent"), members, rooms)).toBe(
      "[#전체] @민수(팀장): @지연 `src/login.ts` 의 토큰 만료 검사를 추가하고 테스트를 돌려줘. 끝나면 결과를 알려줘.",
    );
    expect(formatMessageLine(fixtureMessage("room.message.system"), members, rooms)).toBe(
      "[#전체] 시스템: 지연(개발자, Codex)이 팀에 합류했습니다. 브랜치 mam/backend/jiyeon",
    );
  });

  it("summarizes approval cards as one system line with the resolution", () => {
    const pending = fixtureMessage("room.message.approval");
    expect(formatMessageLine(pending, members, rooms)).toBe("[#전체] 시스템: 지연의 승인 요청 'npm test 실행' — 대기 중");
    const allowed: RoomMessage = { ...pending, approval: { ...pending.approval!, resolution: { optionId: "allow", by: "client", at: "2026-09-12T09:10:20Z" } } };
    expect(formatMessageLine(allowed, members, rooms)).toBe("[#전체] 시스템: 지연의 승인 요청 'npm test 실행' — 허용됨");
    const session: RoomMessage = { ...pending, approval: { ...pending.approval!, resolution: { optionId: "allow_session", by: "client", at: "2026-09-12T09:10:20Z" } } };
    expect(formatMessageLine(session, members, rooms)).toBe("[#전체] 시스템: 지연의 승인 요청 'npm test 실행' — 허용됨");
    const denied: RoomMessage = { ...pending, approval: { ...pending.approval!, resolution: { optionId: "deny", by: "timeout", at: "2026-09-12T09:10:20Z" } } };
    expect(formatMessageLine(denied, members, rooms)).toBe("[#전체] 시스템: 지연의 승인 요청 'npm test 실행' — 거절됨");
    expect(formatMessageLine(pending, members, rooms)).not.toContain("cwd:"); // 도구 상세 없음
  });

  it("summarizes change cards as one system line with the file count", () => {
    const ready = fixtureMessage("room.message.changes");
    expect(formatMessageLine(ready, members, rooms)).toBe("[#전체] 시스템: 지연의 변경 준비됨: 2개 파일");
    const merged: RoomMessage = { ...ready, changes: { ...ready.changes!, status: "merged" } };
    expect(formatMessageLine(merged, members, rooms)).toBe("[#전체] 시스템: 지연의 변경 준비됨: 2개 파일 — 머지됨");
    const conflict: RoomMessage = { ...ready, changes: { ...ready.changes!, status: "conflict", conflictFiles: ["src/login.ts"] } };
    expect(formatMessageLine(conflict, members, rooms)).toBe("[#전체] 시스템: 지연의 변경 준비됨: 2개 파일 — 충돌");
    expect(formatMessageLine(ready, members, rooms)).not.toContain("a1b2c3d4");
  });

  it("falls back for unknown members and rooms without throwing", () => {
    const stranger = msg({ text: "hi", author: { kind: "agent", memberId: "agt_01J8ZQ4K5N7P9R3S6T8V0W2XZZ" }, roomId: "room_01J8ZQ4K5N7P9R3S6T8V0W2XZZ" });
    expect(formatMessageLine(stranger, members, rooms)).toBe("[#전체] @agt_01J8ZQ4K5N7P9R3S6T8V0W2XZZ(팀원): hi");
  });

  it("keeps multi-line text verbatim after the prefix", () => {
    const line = formatMessageLine(msg({ text: "첫 줄\n```ts\nconst a = 1;\n```", author: { kind: "agent", memberId: JIYEON } }), members, rooms);
    expect(line).toBe("[#전체] @지연(개발자): 첫 줄\n```ts\nconst a = 1;\n```");
  });
});

describe("isContextRelevant", () => {
  const approvalCard = (memberId: string): RoomMessage => {
    const fixture = fixtureMessage("room.message.approval");
    return { ...fixture, author: { kind: "agent", memberId }, approval: { ...fixture.approval!, memberId } };
  };
  const changesCard = (memberId: string): RoomMessage => {
    const fixture = fixtureMessage("room.message.changes");
    return { ...fixture, author: { kind: "agent", memberId }, changes: { ...fixture.changes!, memberId } };
  };

  it("keeps only the member's own approval and change cards, and every conversation but their own text", () => {
    const cases: [string, RoomMessage, boolean][] = [
      ["내 승인 카드", approvalCard(MINSU), true],
      ["남의 승인 카드", approvalCard(JIYEON), false],
      ["내 변경 카드", changesCard(MINSU), true],
      ["남의 변경 카드", changesCard(JIYEON), false],
      ["내 text", msg({ text: "제가 한 말", author: { kind: "agent", memberId: MINSU } }), false],
      ["남의 text", msg({ text: "동료 말", author: { kind: "agent", memberId: JIYEON } }), true],
      ["사용자 text", msg({ text: "사용자 말" }), true],
      ["시스템", msg({ text: "지연이 합류했습니다", author: { kind: "system" }, kind: "system" }), true],
    ];
    for (const [label, message, expected] of cases) {
      expect(`${label}=${isContextRelevant(message, MINSU)}`).toBe(`${label}=${expected}`);
    }
  });

  it("is independent of the room: the same rules apply in a DM", () => {
    const mine = { ...approvalCard(MINSU), roomId: DM_MINSU };
    const theirs = { ...approvalCard(JIYEON), roomId: DM_MINSU };
    expect(isContextRelevant(mine, MINSU)).toBe(true);
    expect(isContextRelevant(theirs, MINSU)).toBe(false);
  });
});

describe("buildTurnText", () => {
  it("puts context lines first, the trigger last and a group footer", () => {
    const c1 = msg({ text: "안녕" });
    const c2 = msg({ text: "네 안녕하세요", author: { kind: "agent", memberId: JIYEON } });
    const trigger = msg({ text: "@민수 계획 세워줘", mentions: [MINSU] });
    const { text, omitted } = build({ context: [c1, c2], trigger });
    expect(omitted).toBe(0);
    expect(text).toBe(
      [
        "[#전체] 사용자: 안녕",
        "[#전체] @지연(개발자): 네 안녕하세요",
        "[#전체] 사용자: @민수 계획 세워줘",
        "",
        "Reply for room #전체. Address teammates with @name only when they must act.",
      ].join("\n"),
    );
  });

  it("uses the DM footer when the trigger is in a DM room", () => {
    const trigger = msg({ text: "혼자 확인해줘", roomId: DM_MINSU });
    const { text } = build({ trigger });
    expect(text).toBe(["[DM] 사용자: 혼자 확인해줘", "", "Reply in this DM."].join("\n"));
  });

  it("renders the trigger exactly once even if it is also in the context", () => {
    const c1 = msg({ text: "먼저" });
    const trigger = msg({ text: "@민수 지금", mentions: [MINSU] });
    const { text } = build({ context: [c1, trigger], trigger });
    expect(text.split("\n").filter((l) => l === "[#전체] 사용자: @민수 지금")).toHaveLength(1);
    expect(text.startsWith("[#전체] 사용자: 먼저\n[#전체] 사용자: @민수 지금\n")).toBe(true);
  });

  it("drops the oldest beyond maxMessages and prepends the omitted line", () => {
    const context = Array.from({ length: 45 }, (_, i) => msg({ text: `m${i}` }));
    const trigger = msg({ text: "@민수 마지막", mentions: [MINSU] });
    const { text, omitted } = build({ context, trigger, maxMessages: 40 });
    const lines = text.split("\n");
    expect(omitted).toBe(5);
    expect(lines[0]).toBe("(이전 메시지 5개 생략)");
    expect(lines[1]).toBe("[#전체] 사용자: m5");
    expect(lines[40]).toBe("[#전체] 사용자: m44");
    expect(lines[41]).toBe("[#전체] 사용자: @민수 마지막");
    expect(lines.slice(1, 42)).toHaveLength(41);
  });

  it("fills from the newest line back until maxChars, always keeping the trigger", () => {
    const context = Array.from({ length: 15 }, (_, i) => msg({ text: `${i}`.padEnd(1000, "x") }));
    const trigger = msg({ text: "@민수 끝", mentions: [MINSU] });
    const { text, omitted } = build({ context, trigger, maxChars: 12_000 });
    const lines = text.split("\n");
    const body = lines.slice(1, lines.indexOf(""));
    expect(body.join("\n").length).toBeLessThanOrEqual(12_000);
    expect(body.length).toBe(12); // 11 context + trigger
    expect(omitted).toBe(4);
    expect(lines[0]).toBe("(이전 메시지 4개 생략)");
    expect(body[0]!.startsWith("[#전체] 사용자: 4xxx")).toBe(true);
    expect(body.at(-1)).toBe("[#전체] 사용자: @민수 끝");

    const huge = msg({ text: "y".repeat(20_000) });
    const r = build({ context: [msg({ text: "작은 것" })], trigger: huge, maxChars: 12_000 });
    expect(r.omitted).toBe(1);
    expect(r.text).toContain("y".repeat(20_000));
  });

  it("skips the member's own text messages but keeps their cards", () => {
    const mine = msg({ text: "제가 한 말", author: { kind: "agent", memberId: MINSU } });
    const fixture = fixtureMessage("room.message.changes");
    const card: RoomMessage = { ...fixture, author: { kind: "agent", memberId: MINSU }, changes: { ...fixture.changes!, memberId: MINSU } };
    const other = msg({ text: "동료 말", author: { kind: "agent", memberId: JIYEON } });
    const { text, omitted } = build({ context: [mine, card, other] });
    expect(omitted).toBe(0);
    expect(text).not.toContain("제가 한 말");
    expect(text).toContain("[#전체] 시스템: 민수의 변경 준비됨: 2개 파일");
    expect(text).toContain("[#전체] @지연(개발자): 동료 말");
  });

  it("drops other members' approval and change cards while keeping the conversation", () => {
    const approvalFixture = fixtureMessage("room.message.approval");
    const changesFixture = fixtureMessage("room.message.changes");
    // 실제 팀에서 관측된 모양: 남의 카드가 맥락의 대부분(승인 12 + 변경 8)이고 대화는 2건뿐이다.
    const cards: RoomMessage[] = [
      ...Array.from({ length: 12 }, (_, i) => ({
        ...approvalFixture,
        id: `msg_approval${i}`,
        text: `npx eslint src ${i} 2>&1 | tail -30`,
        author: { kind: "agent", memberId: JIYEON } as const,
        approval: { ...approvalFixture.approval!, memberId: JIYEON },
      })),
      ...Array.from({ length: 8 }, (_, i) => ({
        ...changesFixture,
        id: `msg_changes${i}`,
        author: { kind: "agent", memberId: JIYEON } as const,
        changes: { ...changesFixture.changes!, memberId: JIYEON },
      })),
    ];
    const talk = [msg({ text: "배포 전에 확인 부탁해요" }), msg({ text: "네 보고 있습니다", author: { kind: "agent", memberId: JIYEON } })];
    const trigger = msg({ text: "@민수 정리해줘", mentions: [MINSU] });
    const { text, omitted } = build({ context: [...cards, ...talk], trigger });
    expect(omitted).toBe(0); // 필터로 뺀 것은 세지 않는다
    expect(text).not.toContain("승인 요청");
    expect(text).not.toContain("변경 준비됨");
    expect(text).not.toContain("eslint");
    expect(text.split("\n").filter((l) => l.includes("시스템:"))).toEqual([]);
    expect(text).toBe(
      [
        "[#전체] 사용자: 배포 전에 확인 부탁해요",
        "[#전체] @지연(개발자): 네 보고 있습니다",
        "[#전체] 사용자: @민수 정리해줘",
        "",
        "Reply for room #전체. Address teammates with @name only when they must act.",
      ].join("\n"),
    );
  });

  it("always renders the trigger last even when the filter would drop it", () => {
    const fixture = fixtureMessage("room.message.approval");
    const foreign: RoomMessage = { ...fixture, author: { kind: "agent", memberId: JIYEON }, approval: { ...fixture.approval!, memberId: JIYEON } };
    const { text, omitted } = build({ context: [msg({ text: "앞" }), foreign], trigger: foreign });
    expect(omitted).toBe(0);
    expect(text.split("\n").filter((l) => l.includes("지연의 승인 요청"))).toHaveLength(1);
    expect(text).toBe(
      [
        "[#전체] 사용자: 앞",
        "[#전체] 시스템: 지연의 승인 요청 'npm test 실행' — 대기 중",
        "",
        "Reply for room #전체. Address teammates with @name only when they must act.",
      ].join("\n"),
    );
  });

  it("puts the conflict note first", () => {
    const { text } = build({ context: [msg({ text: "앞" })], conflictNote: "main 을 브랜치에 머지하다 충돌했습니다: src/a.ts" });
    expect(text.startsWith("main 을 브랜치에 머지하다 충돌했습니다: src/a.ts\n\n[#전체] 사용자: 앞\n")).toBe(true);
  });

  it("mixes rooms in the given order with per-room prefixes", () => {
    const g = msg({ text: "그룹" });
    const d = msg({ text: "디엠", roomId: DM_MINSU });
    const trigger = msg({ text: "@민수 응답", mentions: [MINSU] });
    const { text } = build({ context: [g, d], trigger });
    expect(text.startsWith("[#전체] 사용자: 그룹\n[DM] 사용자: 디엠\n[#전체] 사용자: @민수 응답\n")).toBe(true);
    expect(jiyeon.name).toBe("지연");
  });
});
