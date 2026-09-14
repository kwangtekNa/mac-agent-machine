import { readFile, realpath, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { RoomDetailResponseSchema, type MemberInput, type RoomMessage, type Team, type TeamMember } from "@mam/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter, type FakeScript } from "../../src/agents/fake/index.js";
import { newId } from "../../src/ids.js";
import { SessionManager } from "../../src/sessions/manager.js";
import { TeamManager } from "../../src/teams/team-manager.js";
import type { TeamRecord } from "../../src/teams/types.js";
import { git, initRepo, makeTmpHome, removeTmp } from "../helpers/tmp-home.js";

/**
 * 곁방(PROTOCOL 6.4 "곁방 분리"·"곁방 안", 6.6, 2026-09-14). 에이전트가 에이전트를 부르면 그 대화가 곁방으로 갈라지고,
 * 그룹방에는 원본 답변과 연결 카드(열림·닫힘)만 남으며, 곁방에 참가하지 않은 팀원의 턴 입력에는 그 대화가 들어가지 않는다.
 */

const silent = { info() {}, warn() {}, error() {} };
const dirs: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
/** memberId(= worktree 폴더 이름) → 그 팀원이 다음 턴들에 낼 답변. 비면 트리거를 되돌린다. */
const replies = new Map<string, string[]>();

beforeEach(() => {
  replies.clear();
});
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => undefined);
  for (const d of dirs.splice(0)) await removeTmp(d);
});

/**
 * 팀원마다 미리 넣어둔 답변을 순서대로 낸다(`replies`). 없으면 트리거 줄을 되돌리되 `@` 를 지운다(우연한 연쇄 방지).
 * 트리거에 "write" 가 있으면 worktree 에 파일을 하나 쓴다. 팀원 구분은 `ctx.cwd` 의 마지막 조각(= memberId)으로 한다.
 */
const sideScript: FakeScript = async (ctx) => {
  const { input, turnId } = ctx;
  const lines = input.text.split("\n");
  const trigger = lines.length >= 3 ? lines[lines.length - 3]! : input.text;
  const emitItem = (kind: string, payload: unknown): void => {
    const at = ctx.now();
    ctx.emit({ type: "item.started", item: { id: newId("itm"), turnId, kind, status: "completed", createdAt: at, completedAt: at, payload } as never });
  };
  emitItem("user_message", { text: input.text, attachments: input.attachments ?? [] });
  emitItem("tool_call", { tool: "bash", name: "Bash", title: "echo", input: {}, output: "ok\n", exitCode: 0, truncated: false });
  if (trigger.includes("write")) {
    await writeFile(join(ctx.cwd, "out.txt"), `${turnId}\n`);
    emitItem("file_change", { files: [{ path: "out.txt", kind: "add", additions: 1, deletions: 0 }], patch: "" });
  }
  const queued = replies.get(basename(ctx.cwd));
  const reply = (queued && queued.length > 0 ? queued.shift() : undefined) ?? `완료했습니다: ${trigger.replaceAll("@", "")}`;
  emitItem("assistant_message", { text: reply, phase: "final" });
  const summary = { durationMs: 5, usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.001, stopReason: "end_turn" };
  emitItem("turn_summary", summary);
  ctx.emit({ type: "turn.completed", turnId, ...summary });
  ctx.emit({ type: "status", status: "idle" });
};

const MEMBERS: MemberInput[] = [
  { name: "민수", handle: "minsu", role: "team-lead", agent: "claude", isLead: true },
  { name: "지연", handle: "jiyeon", role: "developer", agent: "codex" },
  { name: "하나", handle: "hana", role: "code-reviewer", agent: "claude" },
  { name: "수진", handle: "sujin", role: "planner", agent: "codex" },
];

async function setup(opts: { home?: string } = {}) {
  const home = opts.home ?? (await realpath(await makeTmpHome("mam-side-")));
  if (!opts.home) dirs.push(home);
  const dataDir = join(home, ".mam");
  const repo = join(home, "work", "app");
  if (!opts.home) {
    await initRepo(repo);
    await writeFile(join(repo, "a.txt"), "hello\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-q", "-m", "init");
  }
  const claude = new FakeAdapter({ kind: "claude", autoApprove: true, script: sideScript });
  const codex = new FakeAdapter({ kind: "codex", autoApprove: true, script: sideScript });
  const manager = await SessionManager.open({ dataDir, adapters: { claude, codex }, logger: silent });
  const teams = await TeamManager.open({ dataDir, home, manager, logger: silent });
  cleanups.push(async () => {
    await teams.shutdown();
    await manager.shutdown();
  });
  const create = () => teams.createTeam({ cwd: repo, name: "backend", members: MEMBERS });
  return { home, dataDir, repo, claude, codex, manager, teams, create };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

async function waitUntil(pred: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const member = (team: Team, name: string) => team.members.find((m) => m.name === name)!;
const groupRoom = (team: Team) => team.rooms.find((r) => r.kind === "group")!;
const sideRooms = (teams: TeamManager, teamId: string) => teams.getTeam(teamId).rooms.filter((r) => r.kind === "side");
const quiet = (teams: TeamManager, teamId: string) => () => {
  const d = teams.detail(teamId);
  return d.dispatch.running.length === 0 && d.dispatch.queued.length === 0 && d.team.members.every((m) => m.state === "idle" || m.state === "error");
};
const messagesIn = async (teams: TeamManager, teamId: string, roomId: string): Promise<RoomMessage[]> => (await teams.roomDetail(teamId, roomId)).messages;
const cardsIn = async (teams: TeamManager, teamId: string, roomId: string): Promise<RoomMessage[]> =>
  (await messagesIn(teams, teamId, roomId)).filter((m) => m.sideRoom !== null);
const authorOf = (m: RoomMessage): string | null => (m.author.kind === "agent" ? m.author.memberId : null);
const agentTexts = (list: RoomMessage[]): RoomMessage[] => list.filter((m) => m.kind === "text" && m.author.kind === "agent");
/** 곁방 이름은 참가자 id 순서의 이름을 " ↔ " 로 이은 것이다(id 정렬 순서에 의존하지 않게 계산한다). */
const sideName = (team: Team, participants: string[]): string => participants.map((id) => team.members.find((m) => m.id === id)!.name).join(" ↔ ");
/** 그 팀원 세션이 받은 턴 입력 텍스트(어댑터 종류와 무관하게 worktree 로 찾는다). */
const turnsOf = (fx: Fixture, m: TeamMember): string[] =>
  [...fx.claude.sessions, ...fx.codex.sessions].filter((s) => s.options.cwd === m.worktreePath).flatMap((s) => s.turns.map((t) => t.text));
/** `closed` 연결 카드는 상태가 idle 로 돌아온 직후에 올라간다. */
const waitForClosed = (teams: TeamManager, teamId: string, roomId: string, count = 1) =>
  waitUntil(async () => (await cardsIn(teams, teamId, roomId)).filter((m) => m.sideRoom!.kind === "closed").length >= count);

describe("side rooms", () => {
  it("splits an agent-to-agent mention into a side room and keeps the group room clean", async () => {
    const fx = await setup();
    const team = await fx.create();
    const group = groupRoom(team);
    const minsu = member(team, "민수");
    const jiyeon = member(team, "지연");
    replies.set(minsu.id, ["@지연 확인 부탁해"]);

    await fx.teams.postUserMessage(team.id, group.id, { text: "시작해줘" }); // 멘션이 없으니 팀장에게 간다
    await waitUntil(quiet(fx.teams, team.id));
    await waitForClosed(fx.teams, team.id, group.id);

    const side = sideRooms(fx.teams, team.id)[0]!;
    expect(sideRooms(fx.teams, team.id)).toHaveLength(1);
    expect(side).toMatchObject({ kind: "side", memberId: null, teamId: team.id, participants: [minsu.id, jiyeon.id].sort() });
    expect(side.name).toBe(sideName(team, side.participants!));
    const detail = await fx.teams.roomDetail(team.id, side.id);
    expect(RoomDetailResponseSchema.safeParse(detail).success).toBe(true);

    // 곁방: 같은 본문의 트리거 복사본(작성자 민수, hop 그대로, dispatchId 없음) + 지연의 답변(hop +1)
    expect(detail.messages.map((m) => [m.kind, authorOf(m), m.text, m.hop, m.dispatchId === null])).toEqual([
      ["text", minsu.id, "@지연 확인 부탁해", 1, true],
      ["text", jiyeon.id, `완료했습니다: [#${side.name}] 민수(팀장): 지연 확인 부탁해`, 2, false],
    ]);
    expect(detail.messages[0]!.mentions).toEqual([jiyeon.id]);
    // 지연의 턴 입력은 곁방 트리거다
    expect(turnsOf(fx, jiyeon).at(-1)).toContain(`[#${side.name}] @민수(팀장): @지연 확인 부탁해`);

    // 그룹방: 팀장의 원본 답변은 그대로 남고 지연의 답변은 없다. 연결 카드만 늘어난다.
    const g = await messagesIn(fx.teams, team.id, group.id);
    expect(agentTexts(g).map((m) => [authorOf(m), m.text])).toEqual([[minsu.id, "@지연 확인 부탁해"]]);
    const cards = g.filter((m) => m.sideRoom !== null);
    expect(cards.map((m) => [m.kind, m.author.kind, m.sideRoom!.kind, m.sideRoom!.roomId, m.sideRoom!.participants, m.sideRoom!.messages, m.text])).toEqual([
      ["system", "system", "opened", side.id, side.participants, 0, `${side.name} 곁방을 열었습니다`],
      [
        "system",
        "system",
        "closed",
        side.id,
        side.participants,
        2,
        `${side.name} 곁방 대화 2건 · 결론: 완료했습니다: [#${side.name}] 민수(팀장): 지연 확인 부탁해`,
      ],
    ]);
    expect(cards[1]!.sideRoom!.messages).toBe(detail.messages.length);
  });

  it("reuses the same room for the same pair and posts one closed card per chain", async () => {
    const fx = await setup();
    const team = await fx.create();
    const group = groupRoom(team);
    const minsu = member(team, "민수");
    replies.set(minsu.id, ["@지연 확인 부탁해", "@지연 하나만 더"]);

    await fx.teams.postUserMessage(team.id, group.id, { text: "시작해줘" });
    await waitUntil(quiet(fx.teams, team.id));
    await waitForClosed(fx.teams, team.id, group.id, 1);
    const first = sideRooms(fx.teams, team.id)[0]!;

    await fx.teams.postUserMessage(team.id, group.id, { text: "또 시작해줘" });
    await waitUntil(quiet(fx.teams, team.id));
    await waitForClosed(fx.teams, team.id, group.id, 2);

    expect(sideRooms(fx.teams, team.id).map((r) => r.id)).toEqual([first.id]);
    const cards = await cardsIn(fx.teams, team.id, group.id);
    expect(cards.filter((m) => m.sideRoom!.kind === "opened")).toHaveLength(1);
    // 두 번째 연쇄의 closed 카드는 그 연쇄의 대화만 센다(이전 대화는 세지 않는다)
    expect(cards.filter((m) => m.sideRoom!.kind === "closed").map((m) => m.sideRoom!.messages)).toEqual([2, 2]);
    expect(await messagesIn(fx.teams, team.id, first.id)).toHaveLength(4);
  });

  it("keeps a broadcast in the group room when the candidates exceed sideRoomMaxParticipants", async () => {
    const fx = await setup();
    const team = await fx.create();
    const group = groupRoom(team);
    const minsu = member(team, "민수");
    replies.set(minsu.id, ["@지연 @하나 @수진 공지합니다"]); // 후보 4명 > 상한 3
    await fx.teams.postUserMessage(team.id, group.id, { text: "시작해줘" });
    await waitUntil(quiet(fx.teams, team.id));

    expect(sideRooms(fx.teams, team.id)).toHaveLength(0);
    const g = await messagesIn(fx.teams, team.id, group.id);
    expect(g.filter((m) => m.sideRoom !== null)).toEqual([]);
    expect(agentTexts(g).map((m) => authorOf(m)).sort()).toEqual([minsu.id, member(team, "지연").id, member(team, "하나").id, member(team, "수진").id].sort());
    for (const name of ["지연", "하나", "수진"]) {
      expect(turnsOf(fx, member(team, name)).at(-1)).toContain("[#전체] @민수(팀장): @지연 @하나 @수진 공지합니다");
    }
  });

  it("continues in the same side room when a participant is mentioned back (hop +1)", async () => {
    const fx = await setup();
    const team = await fx.create();
    const group = groupRoom(team);
    const minsu = member(team, "민수");
    const jiyeon = member(team, "지연");
    replies.set(minsu.id, ["@지연 확인 부탁해"]);
    replies.set(jiyeon.id, ["@민수 다 됐습니다"]);

    await fx.teams.postUserMessage(team.id, group.id, { text: "시작해줘" });
    await waitUntil(quiet(fx.teams, team.id));
    await waitForClosed(fx.teams, team.id, group.id);

    expect(sideRooms(fx.teams, team.id)).toHaveLength(1);
    const side = sideRooms(fx.teams, team.id)[0]!;
    const msgs = await messagesIn(fx.teams, team.id, side.id);
    expect(msgs.map((m) => [authorOf(m), m.hop])).toEqual([
      [minsu.id, 1],
      [jiyeon.id, 2],
      [minsu.id, 3],
    ]);
    expect(msgs[2]!.text).toBe(`완료했습니다: [#${side.name}] 지연(개발자): 민수 다 됐습니다`);
    // 이어진 대화도 하나의 연쇄다: closed 카드는 1건, 대화 3건
    const closed = (await cardsIn(fx.teams, team.id, group.id)).filter((m) => m.sideRoom!.kind === "closed");
    expect(closed.map((m) => m.sideRoom!.messages)).toEqual([3]);
  });

  it("opens a new side room when an outsider is pulled into the conversation", async () => {
    const fx = await setup();
    const team = await fx.create();
    const group = groupRoom(team);
    const minsu = member(team, "민수");
    const jiyeon = member(team, "지연");
    const hana = member(team, "하나");
    replies.set(minsu.id, ["@지연 확인 부탁해"]);
    replies.set(jiyeon.id, ["@민수 @하나 같이 봐주세요"]);

    await fx.teams.postUserMessage(team.id, group.id, { text: "시작해줘" });
    await waitUntil(quiet(fx.teams, team.id));
    await waitUntil(() => sideRooms(fx.teams, team.id).length === 2);
    await waitUntil(quiet(fx.teams, team.id));

    const [pair, trio] = sideRooms(fx.teams, team.id);
    expect(pair!.participants).toEqual([minsu.id, jiyeon.id].sort());
    expect(trio!.participants).toEqual([minsu.id, jiyeon.id, hana.id].sort());
    expect(trio!.name).toBe(sideName(team, trio!.participants!));
    // 3인 방에는 지연의 본문이 트리거로 복사되고 민수·하나가 그 방에서 답한다
    const msgs = await messagesIn(fx.teams, team.id, trio!.id);
    expect(msgs[0]).toMatchObject({ kind: "text", text: "@민수 @하나 같이 봐주세요", hop: 2, dispatchId: null });
    expect(authorOf(msgs[0]!)).toBe(jiyeon.id);
    expect(msgs[0]!.mentions.sort()).toEqual([minsu.id, hana.id].sort());
    expect(agentTexts(msgs.slice(1)).map((m) => authorOf(m)).sort()).toEqual([minsu.id, hana.id].sort());
    for (const m of [minsu, hana]) expect(turnsOf(fx, m).at(-1)).toContain(`[#${trio!.name}] @지연(개발자): @민수 @하나 같이 봐주세요`);
    // 2인 방의 원본은 그대로 남는다
    expect((await messagesIn(fx.teams, team.id, pair!.id)).map((m) => m.text)).toEqual(["@지연 확인 부탁해", "@민수 @하나 같이 봐주세요"]);
    expect((await cardsIn(fx.teams, team.id, group.id)).filter((m) => m.sideRoom!.kind === "opened").map((m) => m.sideRoom!.roomId)).toEqual([pair!.id, trio!.id]);
  });

  it("dispatches every participant when the user writes in a side room without a mention", async () => {
    const fx = await setup();
    const team = await fx.create();
    const group = groupRoom(team);
    const minsu = member(team, "민수");
    const jiyeon = member(team, "지연");
    replies.set(minsu.id, ["@지연 확인 부탁해"]);
    await fx.teams.postUserMessage(team.id, group.id, { text: "시작해줘" });
    await waitUntil(quiet(fx.teams, team.id));
    const side = sideRooms(fx.teams, team.id)[0]!;

    const { message, dispatches } = await fx.teams.postUserMessage(team.id, side.id, { text: "둘 다 상황 알려줘" });
    expect(dispatches).toHaveLength(2);
    expect(message).toMatchObject({ roomId: side.id, hop: 0, mentions: [] });
    await waitUntil(quiet(fx.teams, team.id));
    for (const m of [minsu, jiyeon]) expect(turnsOf(fx, m).at(-1)).toContain(`[#${side.name}] 사용자: 둘 다 상황 알려줘`);
    const replied = agentTexts(await messagesIn(fx.teams, team.id, side.id)).filter((m) => m.seq > message.seq);
    expect(replied.map((m) => [authorOf(m), m.hop]).sort()).toEqual([
      [minsu.id, 1],
      [jiyeon.id, 1],
    ].sort());

    // 멘션을 쓰면 그 참가자만 답한다
    const one = await fx.teams.postUserMessage(team.id, side.id, { text: "@지연 하나만" });
    expect(one.dispatches).toHaveLength(1);
    expect(one.message.mentions).toEqual([jiyeon.id]);
    await waitUntil(quiet(fx.teams, team.id));
  });

  it("posts the changes card in the group room for work done in a side room", async () => {
    const fx = await setup();
    const team = await fx.create();
    const group = groupRoom(team);
    const minsu = member(team, "민수");
    const jiyeon = member(team, "지연");
    replies.set(minsu.id, ["@지연 write 파일 하나 만들어줘"]);

    await fx.teams.postUserMessage(team.id, group.id, { text: "시작해줘" });
    await waitUntil(quiet(fx.teams, team.id));
    await waitUntil(() => fx.teams.listChanges(team.id).length === 1);

    const side = sideRooms(fx.teams, team.id)[0]!;
    const change = fx.teams.listChanges(team.id)[0]!;
    expect(change).toMatchObject({ memberId: jiyeon.id, status: "ready", files: [{ path: "out.txt", kind: "add" }] });
    const g = await messagesIn(fx.teams, team.id, group.id);
    const card = g.find((m) => m.kind === "changes")!;
    expect(card.id).toBe(change.messageId);
    expect(card.roomId).toBe(group.id);
    // 곁방에는 변경 카드가 없다(머지는 그룹방 한곳에서 본다)
    expect((await messagesIn(fx.teams, team.id, side.id)).filter((m) => m.kind === "changes")).toEqual([]);
  });

  it("keeps side-room messages out of a non-participant's turn input", async () => {
    const fx = await setup();
    const team = await fx.create();
    const group = groupRoom(team);
    const minsu = member(team, "민수");
    const jiyeon = member(team, "지연");
    const hana = member(team, "하나");
    replies.set(minsu.id, ["@지연 확인 부탁해", "정리했습니다"]);
    replies.set(jiyeon.id, ["@민수 비밀 메모 A"]);

    await fx.teams.postUserMessage(team.id, group.id, { text: "시작해줘" });
    await waitUntil(quiet(fx.teams, team.id));
    const side = sideRooms(fx.teams, team.id)[0]!;
    await waitForClosed(fx.teams, team.id, group.id);
    expect((await messagesIn(fx.teams, team.id, side.id)).map((m) => m.text)).toEqual(["@지연 확인 부탁해", "@민수 비밀 메모 A", "정리했습니다"]);

    // 참가자가 아닌 하나의 턴 입력에는 곁방 줄이 한 줄도 없다(그룹방 연결 카드의 결론 한 줄만 보인다)
    await fx.teams.postUserMessage(team.id, group.id, { text: "@하나 리뷰해줘" });
    await waitUntil(quiet(fx.teams, team.id));
    const turn = turnsOf(fx, hana).at(-1)!;
    expect(turn.split("\n").filter((l) => l.startsWith(`[#${side.name}]`))).toEqual([]);
    expect(turn).not.toContain("비밀 메모 A");
    expect(turn).toContain("[#전체] @민수(팀장): @지연 확인 부탁해"); // 그룹방 원본은 보인다
    expect(turn).toContain(`[#전체] 시스템: ${side.name} 곁방 대화 3건 · 결론: 정리했습니다`);
    expect(turn).toContain("[#전체] 사용자: @하나 리뷰해줘");
    // 참가자인 지연에게는 곁방 대화가 보였다
    expect(turnsOf(fx, jiyeon).some((t) => t.split("\n").some((l) => l.startsWith(`[#${side.name}]`)))).toBe(true);
  });

  it("restores side rooms, participants and lastSeen after a restart", async () => {
    const first = await setup();
    const team = await first.create();
    const group = groupRoom(team);
    const minsu = member(team, "민수");
    const jiyeon = member(team, "지연");
    replies.set(minsu.id, ["@지연 확인 부탁해"]);
    await first.teams.postUserMessage(team.id, group.id, { text: "시작해줘" });
    await waitUntil(quiet(first.teams, team.id));
    // `quiet` 은 팀원이 idle 로 바뀌는 순간 참이 되지만 그 뒤의 `room.status` 가 아직 곁방 seq 를 하나 더 쓴다.
    // `closed` 카드는 그 `room.status` **다음에** 올라가므로, 카드를 기다린 뒤 읽어야 `lastSeq` 가 확정된 방을 얻는다.
    await waitForClosed(first.teams, team.id, group.id);
    const side = sideRooms(first.teams, team.id)[0]!;
    const before = await messagesIn(first.teams, team.id, side.id);
    await first.teams.shutdown();
    await first.manager.shutdown();

    const record = JSON.parse(await readFile(join(first.dataDir, "teams", team.id, "team.json"), "utf8")) as TeamRecord;
    expect(record.rooms.find((r) => r.id === side.id)).toMatchObject({ kind: "side", participants: side.participants });
    // 방이 생길 때 참가자 전원에게 0 이 깔리고, 그 방에서 턴을 돈 지연은 읽은 seq 가 올라가 있다
    for (const id of [minsu.id, jiyeon.id]) {
      expect(side.id in record.members.find((m) => m.id === id)!.lastSeen).toBe(true);
    }
    expect(record.members.find((m) => m.id === jiyeon.id)!.lastSeen[side.id]).toBeGreaterThanOrEqual(1);

    const second = await setup({ home: first.home });
    const restored = second.teams.getTeam(team.id);
    expect(restored.rooms.find((r) => r.id === side.id)).toEqual(side);
    expect(await messagesIn(second.teams, team.id, side.id)).toEqual(before);
    // 복원된 곁방에 이어서 쓸 수 있다
    const { dispatches } = await second.teams.postUserMessage(team.id, side.id, { text: "이어서 하자" });
    expect(dispatches).toHaveLength(2);
    await waitUntil(quiet(second.teams, team.id));
    expect((await messagesIn(second.teams, team.id, side.id)).length).toBe(before.length + 3);
    await second.teams.shutdown();
    await second.manager.shutdown();
  });
});
