import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ChangeSetSchema,
  RoomDetailResponseSchema,
  TeamDetailResponseSchema,
  TeamSchema,
  parseRoomServerEvent,
  type Approval,
  type MemberInput,
  type RoomMessage,
  type RoomServerEvent,
  type Team,
  type TeamSettings,
} from "@mam/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAdapter, type FakeScript } from "../../src/agents/fake/index.js";
import { ConflictError, InvalidRequestError, NotFoundError } from "../../src/errors.js";
import { newId } from "../../src/ids.js";
import { SessionManager } from "../../src/sessions/manager.js";
import { TeamManager } from "../../src/teams/team-manager.js";
import type { TeamRecord } from "../../src/teams/types.js";
import { git, initRepo, makeTmpHome, removeTmp } from "../helpers/tmp-home.js";

const silent = { info() {}, warn() {}, error() {} };
const dirs: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  // 백그라운드 저장(onRoomChanged → persist)이 임시 디렉토리 삭제와 경합하지 않게 먼저 닫는다.
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => undefined);
  for (const d of dirs.splice(0)) await removeTmp(d);
});

const makeApproval = (at: string): Approval => ({
  approvalId: newId("apr"),
  itemId: newId("itm"),
  kind: "command",
  title: "npm test 실행",
  prompt: "run npm test",
  detail: null,
  diff: null,
  options: [
    { id: "allow", label: "허용", style: "primary" },
    { id: "deny", label: "거절", style: "destructive" },
  ],
  inputFields: [],
  requestedAt: at,
});

/**
 * 팀 테스트용 스크립트. 턴 텍스트의 트리거 줄(뒤에서 세 번째 줄: 트리거, 빈 줄, 꼬리말)에 따라 동작한다.
 * "fail" → 복구 불가 오류, "limit" → 한도 오류, "wait" → interrupt 될 때까지 대기, "approve" → 승인 요청,
 * "ghost" → 승인 요청만 내보내고 기다리지 않는다(턴이 끝나도 세션에 대기 승인이 남는다),
 * "write" → `<cwd>/out.txt` 를 쓰고 file_change, "call jiyeon" → 답변에 `@지연 부탁해`.
 * 답변은 트리거 줄을 되돌리되 `@` 는 지운다(그대로 두면 답변 멘션이 되어 팀원끼리 연쇄가 생긴다).
 */
const teamScript: FakeScript = async (ctx) => {
  const { input, turnId } = ctx;
  const lines = input.text.split("\n");
  const trigger = lines.length >= 3 ? lines[lines.length - 3]! : input.text;
  const emitItem = (kind: string, payload: unknown): void => {
    const at = ctx.now();
    ctx.emit({
      type: "item.started",
      item: { id: newId("itm"), turnId, kind, status: "completed", createdAt: at, completedAt: at, payload } as never,
    });
  };
  emitItem("user_message", { text: input.text, attachments: input.attachments ?? [] });
  if (trigger.includes("fail")) {
    ctx.emit({ type: "error", message: "가짜 오류", recoverable: false });
    return;
  }
  if (trigger.includes("limit")) {
    ctx.emit({ type: "error", message: "You have hit your usage limit", recoverable: false });
    return;
  }
  if (trigger.includes("wait")) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 10_000);
      ctx.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(Object.assign(new Error("interrupted"), { name: "AbortError" }));
        },
        { once: true },
      );
    });
  }
  if (trigger.includes("approve")) {
    const approval = makeApproval(ctx.now());
    ctx.emit({ type: "approval.requested", approval });
    await ctx.requestApproval(approval);
  }
  if (trigger.includes("ghost")) {
    // 응답을 기다리지 않고 턴을 마친다: 세션에는 대기 승인이 남고 방 카드는 resolution: null 로 남는다.
    ctx.emit({ type: "approval.requested", approval: makeApproval(ctx.now()) });
  }
  emitItem("tool_call", { tool: "bash", name: "Bash", title: "echo", input: {}, output: "ok\n", exitCode: 0, truncated: false });
  if (trigger.includes("write")) {
    await writeFile(join(ctx.cwd, "out.txt"), `${turnId}\n`);
    emitItem("file_change", { files: [{ path: "out.txt", kind: "add", additions: 1, deletions: 0 }], patch: "" });
  }
  const reply = trigger.includes("call jiyeon") ? "@지연 부탁해" : `완료했습니다: ${trigger.replaceAll("@", "")}`;
  emitItem("assistant_message", { text: reply, phase: "final" });
  const summary = { durationMs: 5, usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.001, stopReason: "end_turn" };
  emitItem("turn_summary", summary);
  ctx.emit({ type: "turn.completed", turnId, ...summary });
  ctx.emit({ type: "status", status: "idle" });
};

const MEMBERS: MemberInput[] = [
  { name: "민수", handle: "minsu", role: "team-lead", agent: "claude", isLead: true },
  { name: "지연", handle: "jiyeon", role: "developer", agent: "codex" },
];

async function setup(opts: { settings?: Partial<TeamSettings>; home?: string; codexStartupIdle?: boolean } = {}) {
  const home = opts.home ?? (await realpath(await makeTmpHome("mam-team-")));
  if (!opts.home) dirs.push(home);
  const dataDir = join(home, ".mam");
  const repo = join(home, "work", "app");
  if (!opts.home) {
    await initRepo(repo);
    await writeFile(join(repo, "a.txt"), "hello\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-q", "-m", "init");
  }
  const claude = new FakeAdapter({ kind: "claude", autoApprove: true, script: teamScript });
  const codex = new FakeAdapter({ kind: "codex", autoApprove: true, script: teamScript, startupIdle: opts.codexStartupIdle ?? false });
  const manager = await SessionManager.open({ dataDir, adapters: { claude, codex }, logger: silent });
  const teams = await TeamManager.open({ dataDir, home, manager, logger: silent });
  cleanups.push(async () => {
    await teams.shutdown();
    await manager.shutdown();
  });
  const create = (over: Partial<{ name: string; members: MemberInput[]; settings: Partial<TeamSettings> }> = {}) =>
    teams.createTeam({ cwd: repo, name: over.name ?? "backend", members: over.members ?? MEMBERS, settings: over.settings ?? opts.settings ?? {} });
  return { home, dataDir, repo, claude, codex, manager, teams, create };
}

async function waitUntil(pred: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const member = (team: Team, name: string) => team.members.find((m) => m.name === name)!;
const groupRoom = (team: Team) => team.rooms.find((r) => r.kind === "group")!;
const dmRoom = (team: Team, memberId: string) => team.rooms.find((r) => r.kind === "dm" && r.memberId === memberId)!;
const quiet = (teams: TeamManager, teamId: string) => () => {
  const d = teams.detail(teamId);
  return d.dispatch.running.length === 0 && d.dispatch.queued.length === 0 && d.team.members.every((m) => m.state === "idle" || m.state === "error");
};
const exists = async (p: string): Promise<boolean> => access(p).then(() => true, () => false);

/** 구독으로 모은 이벤트에서 승인 카드(`room.message`)만 게시 순서대로. */
const approvalCards = (events: RoomServerEvent[]): RoomMessage[] =>
  events.flatMap((e) => (e.type === "room.message" && e.message.kind === "approval" ? [e.message] : []));

async function collectRoom(teams: TeamManager, teamId: string, roomId: string) {
  const events: RoomServerEvent[] = [];
  const unsubscribe = await teams.subscribeRoom(teamId, roomId, 0, (e) => {
    parseRoomServerEvent(e);
    events.push(e);
  });
  return { events, unsubscribe };
}

describe("TeamManager.createTeam", () => {
  it("rejects a team without exactly one lead, duplicate names, non-git cwd and cwd outside home", async () => {
    const { teams, repo, home, create } = await setup();
    await expect(create({ members: MEMBERS.map((m) => ({ ...m, isLead: false })) })).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(create({ members: MEMBERS.map((m) => ({ ...m, isLead: true })) })).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(create({ members: [MEMBERS[0]!, { ...MEMBERS[1]!, name: "민 수", handle: "other" }] })).rejects.toBeInstanceOf(ConflictError);
    await expect(create({ members: [MEMBERS[0]!, { ...MEMBERS[1]!, handle: "minsu" }] })).rejects.toBeInstanceOf(ConflictError);
    await expect(create({ members: [{ ...MEMBERS[0]!, role: "custom" }] })).rejects.toBeInstanceOf(InvalidRequestError);
    const notRepo = join(home, "work", "plain");
    await mkdir(notRepo, { recursive: true });
    await expect(teams.createTeam({ cwd: notRepo, name: "x", members: MEMBERS })).rejects.toBeInstanceOf(InvalidRequestError);
    // resolveInsideHome 은 SandboxError(code forbidden, 403) 를 던진다
    await expect(teams.createTeam({ cwd: "/", name: "x", members: MEMBERS })).rejects.toMatchObject({ code: "forbidden", status: 403 });
    // 실패해도 남는 팀이 없다
    expect(teams.listTeams()).toEqual([]);
    expect(teams.listTeams(repo)).toEqual([]);
  });

  it("creates worktrees, branches, rooms and deferred sessions without starting an adapter", async () => {
    const { teams, repo, dataDir, claude, codex, manager, create } = await setup();
    const team = await create();
    expect(TeamSchema.safeParse(team).success).toBe(true);
    expect(team).toMatchObject({ name: "backend", cwd: repo, baseBranch: "main", settings: { maxHops: 6, maxConcurrent: 2, contextMaxMessages: 40 } });
    expect(team.members.map((m) => [m.name, m.handle, m.isLead, m.state, m.mode, m.roleLabel])).toEqual([
      ["민수", "minsu", true, "idle", "auto-edit", "팀장"],
      ["지연", "jiyeon", false, "idle", "auto-edit", "개발자"],
    ]);
    expect(team.rooms.map((r) => [r.kind, r.name, r.memberId])).toEqual([
      ["group", "전체", null],
      ["dm", "민수", member(team, "민수").id],
      ["dm", "지연", member(team, "지연").id],
    ]);
    for (const m of team.members) {
      expect(m.branch).toBe(`mam/backend/${m.handle}`);
      expect(m.worktreePath).toBe(join(dataDir, "teams", team.id, "worktrees", m.id));
      expect(await exists(join(m.worktreePath, "a.txt"))).toBe(true);
      expect((await git(repo, "branch", "--list", m.branch)).trim()).toContain(m.branch);
      expect(m.sessionId).toMatch(/^ses_/);
      const session = manager.get(m.sessionId!)!;
      expect(session).toMatchObject({ status: "idle", cwd: m.worktreePath, agent: m.agent, mode: "auto-edit", team: { teamId: team.id, memberId: m.id } });
      expect(session.nativeId).toBeNull();
      expect(m.prompt.length).toBeGreaterThan(0);
    }
    expect(claude.startCalls).toEqual([]);
    expect(codex.startCalls).toEqual([]);
    expect(teams.listTeams(repo).map((t) => t.id)).toEqual([team.id]);
    expect(teams.listTeams("/nope")).toEqual([]);
    expect(teams.getTeam(team.id).id).toBe(team.id);
    expect(() => teams.getTeam(newId("team"))).toThrow(NotFoundError);
    expect(TeamDetailResponseSchema.safeParse(teams.detail(team.id)).success).toBe(true);
    // 같은 이름으로 다시 만들면 브랜치가 -2 로 밀린다
    const second = await create();
    expect(member(second, "민수").branch).toBe("mam/backend/minsu-2");
    const record = JSON.parse(await readFile(join(dataDir, "teams", team.id, "team.json"), "utf8")) as TeamRecord;
    expect(record.members[0]!.lastSeen).toEqual({});
  });
});

describe("TeamManager dispatch", () => {
  it("routes a message without mention to the lead and posts the reply with work", async () => {
    const { teams, claude, codex, manager, create } = await setup();
    const team = await create();
    const group = groupRoom(team);
    const c = await collectRoom(teams, team.id, group.id);
    const { message, dispatches } = await teams.postUserMessage(team.id, group.id, { text: "안녕 팀장" });
    expect(message).toMatchObject({ author: { kind: "user" }, kind: "text", text: "안녕 팀장", mentions: [], hop: 0, dispatchId: null });
    expect(dispatches).toHaveLength(1);
    await waitUntil(quiet(teams, team.id));
    expect(claude.sessions).toHaveLength(1);
    expect(codex.sessions).toHaveLength(0);
    const turn = claude.sessions[0]!.turns[0]!;
    expect(turn.text).toContain("[#전체] 사용자: 안녕 팀장");
    expect(turn.text.endsWith("Reply for room #전체. Address teammates with @name only when they must act.")).toBe(true);
    expect(claude.startCalls[0]!.instructions).toContain("## Team protocol");

    const detail = await teams.roomDetail(team.id, group.id);
    expect(RoomDetailResponseSchema.safeParse(detail).success).toBe(true);
    const reply = detail.messages.find((m) => m.author.kind === "agent")!;
    const minsu = member(team, "민수");
    expect(reply).toMatchObject({
      author: { kind: "agent", memberId: minsu.id },
      kind: "text",
      text: "완료했습니다: [#전체] 사용자: 안녕 팀장",
      hop: 1,
      dispatchId: dispatches[0],
      mentions: [],
    });
    expect(reply.work).toMatchObject({ sessionId: minsu.sessionId, toolCalls: 1, filesChanged: [], durationMs: 5, usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.001 });
    expect(reply.work!.turnId).toMatch(/^trn_/);
    // 턴이 끝나면 세션 구독이 남지 않는다
    expect(manager.subscriberCount(minsu.sessionId!)).toBe(0);
    // 상태 이벤트가 방에 흘렀고 팀원 상태는 idle 로 돌아온다
    const statuses = c.events.filter((e) => e.type === "room.status");
    expect(statuses.length).toBeGreaterThanOrEqual(2);
    expect(teams.detail(team.id).team.members.every((m) => m.state === "idle")).toBe(true);
    expect(teams.detail(team.id).dispatch).toEqual({ running: [], queued: [] });
    c.unsubscribe();
  });

  it("ignores the adapter's startup idle status (Codex thread/start) and still posts the reply", async () => {
    // 회귀: Codex 어댑터는 스레드 시작 직후 `status: idle` 을 한 번 내보낸다. 이 idle 은 턴 종료가 아니므로
    // "답변 없이 턴을 끝냈습니다" 가 아니라 실제 답변이 방에 게시돼야 한다(2026-09-13 실제 어댑터 확인에서 발견).
    const { teams, codex, create } = await setup({ codexStartupIdle: true });
    const team = await create();
    const group = groupRoom(team);
    const { dispatches } = await teams.postUserMessage(team.id, group.id, { text: "@지연 pong" });
    expect(dispatches).toHaveLength(1);
    await waitUntil(quiet(teams, team.id));
    expect(codex.sessions).toHaveLength(1);
    const detail = await teams.roomDetail(team.id, group.id);
    expect(detail.messages.filter((m) => m.author.kind === "system" && m.text.includes("답변 없이"))).toEqual([]);
    const jiyeon = member(team, "지연");
    const reply = detail.messages.find((m) => m.author.kind === "agent");
    expect(reply).toMatchObject({ author: { kind: "agent", memberId: jiyeon.id }, kind: "text", text: "완료했습니다: [#전체] 사용자: 지연 pong", hop: 1, dispatchId: dispatches[0] });
    expect(reply!.work).toMatchObject({ toolCalls: 1, durationMs: 5 });
    expect(teams.detail(team.id).team.members.every((m) => m.state === "idle")).toBe(true);
  });

  it("@지연 goes only to 지연, @all to both, and context carries earlier messages with prefixes", async () => {
    const { teams, claude, codex, create } = await setup();
    const team = await create();
    const group = groupRoom(team);
    const jiyeon = member(team, "지연");
    const r1 = await teams.postUserMessage(team.id, group.id, { text: "@지연 hello" });
    expect(r1.message.mentions).toEqual([jiyeon.id]);
    await waitUntil(quiet(teams, team.id));
    expect(codex.sessions[0]!.turns).toHaveLength(1);
    expect(claude.sessions).toHaveLength(0);

    const r2 = await teams.postUserMessage(team.id, group.id, { text: "status" });
    expect(r2.dispatches).toHaveLength(1);
    await waitUntil(quiet(teams, team.id));
    const text = claude.sessions[0]!.turns[0]!.text;
    const idx = (s: string) => text.indexOf(s);
    expect(idx("[#전체] 사용자: @지연 hello")).toBeGreaterThanOrEqual(0);
    expect(idx("[#전체] @지연(개발자): 완료했습니다: [#전체] 사용자: 지연 hello")).toBeGreaterThan(idx("[#전체] 사용자: @지연 hello"));
    expect(idx("[#전체] 사용자: status")).toBeGreaterThan(idx("[#전체] @지연(개발자)"));
    // 이미 전달한 메시지는 다음 턴에 다시 넣지 않는다
    await teams.postUserMessage(team.id, group.id, { text: "again" });
    await waitUntil(quiet(teams, team.id));
    expect(claude.sessions[0]!.turns[1]!.text).not.toContain("@지연 hello");
    expect(claude.sessions[0]!.turns[1]!.text).toContain("[#전체] 사용자: again");

    const r3 = await teams.postUserMessage(team.id, group.id, { text: "@all 점검" });
    expect(r3.dispatches).toHaveLength(2);
    await waitUntil(quiet(teams, team.id));
    expect(claude.sessions[0]!.turns).toHaveLength(3);
    expect(codex.sessions[0]!.turns).toHaveLength(2);
    // 모르는 멘션은 room.error 로 알린다
    const c = await collectRoom(teams, team.id, group.id);
    await teams.postUserMessage(team.id, group.id, { text: "@철수 뭐해" });
    await waitUntil(quiet(teams, team.id));
    expect(c.events.some((e) => e.type === "room.error" && e.recoverable && e.message.includes("철수"))).toBe(true);
    c.unsubscribe();
    // DM 방은 그 팀원에게만 가고 멘션은 비운다
    const dm = dmRoom(team, jiyeon.id);
    const r4 = await teams.postUserMessage(team.id, dm.id, { text: "@민수 DM 이야" });
    expect(r4.message.mentions).toEqual([]);
    await waitUntil(quiet(teams, team.id));
    const dmTurn = codex.sessions[0]!.turns.at(-1)!.text;
    expect(dmTurn).toContain("[DM] 사용자: @민수 DM 이야");
    expect(dmTurn.endsWith("Reply in this DM.")).toBe(true);
    expect((await teams.roomDetail(team.id, dm.id)).messages.filter((m) => m.author.kind === "agent")).toHaveLength(1);
  });

  it("chains the lead's @지연 mention into a side room with hop 2 and stops at maxHops with a system message", async () => {
    const { teams, codex, create } = await setup();
    const team = await create();
    const group = groupRoom(team);
    const minsu = member(team, "민수");
    const jiyeon = member(team, "지연");
    // 사용자 글에 @멘션이 없어야 팀장에게 가고, 팀장 답변의 @지연 이 연쇄를 만든다
    await teams.postUserMessage(team.id, group.id, { text: "call jiyeon" });
    await waitUntil(quiet(teams, team.id));
    await waitUntil(() => codex.sessions.length === 1 && codex.sessions[0]!.turns.length === 1);
    await waitUntil(quiet(teams, team.id));
    // 그룹방에는 팀장의 원본 답변만 남고(에이전트 간 대화는 곁방으로 갈라진다, PROTOCOL 6.6)
    const msgs = (await teams.roomDetail(team.id, group.id)).messages;
    const agents = msgs.filter((m) => m.kind === "text" && m.author.kind === "agent");
    expect(agents.map((m) => [m.text, m.hop, (m.author as { memberId: string }).memberId])).toEqual([["@지연 부탁해", 1, minsu.id]]);
    expect(agents[0]!.mentions).toEqual([jiyeon.id]);
    // 곁방에서 같은 본문이 트리거가 되고 지연의 답변이 hop 2 로 이어진다
    const side = teams.getTeam(team.id).rooms.find((r) => r.kind === "side")!;
    expect(side).toMatchObject({ kind: "side", memberId: null, participants: [minsu.id, jiyeon.id].sort() });
    // 이름은 참가자 id 순서(= participants 순서)의 이름을 " ↔ " 로 이은 것이다
    expect(side.name).toBe(side.participants!.map((id) => member(team, "민수").id === id ? "민수" : "지연").join(" ↔ "));
    const sideMsgs = (await teams.roomDetail(team.id, side.id)).messages;
    expect(sideMsgs.map((m) => [m.text, m.hop, (m.author as { memberId: string }).memberId])).toEqual([
      ["@지연 부탁해", 1, minsu.id],
      [`완료했습니다: [#${side.name}] 민수(팀장): 지연 부탁해`, 2, jiyeon.id],
    ]);
    // 그룹방에는 연결 카드 두 장(열림·닫힘)이 남는다
    await waitUntil(async () => (await teams.roomDetail(team.id, group.id)).messages.some((m) => m.sideRoom?.kind === "closed"));
    const cards = (await teams.roomDetail(team.id, group.id)).messages.filter((m) => m.sideRoom !== null);
    expect(cards.map((m) => [m.kind, m.sideRoom!.kind, m.sideRoom!.roomId, m.sideRoom!.messages])).toEqual([
      ["system", "opened", side.id, 0],
      ["system", "closed", side.id, 2],
    ]);

    const strict = await create({ name: "strict", settings: { maxHops: 0 } });
    const sg = groupRoom(strict);
    await teams.postUserMessage(strict.id, sg.id, { text: "call jiyeon" });
    await waitUntil(quiet(teams, strict.id));
    const smsgs = (await teams.roomDetail(strict.id, sg.id)).messages;
    expect(smsgs.filter((m) => m.author.kind === "agent")).toHaveLength(1);
    expect(smsgs.at(-1)).toMatchObject({ kind: "system", text: "자동 연쇄 상한(0)에 도달했습니다. 계속하려면 직접 지시하세요" });
    // 홉 상한에 걸린 멘션은 곁방을 만들지 않는다
    expect(teams.getTeam(strict.id).rooms.some((r) => r.kind === "side")).toBe(false);
    expect(codex.sessions).toHaveLength(1);
  });

  it("maxConcurrent 1 queues the second member until the first turn ends", async () => {
    const { teams, create } = await setup({ settings: { maxConcurrent: 1 } });
    const team = await create();
    const group = groupRoom(team);
    const minsu = member(team, "민수");
    const jiyeon = member(team, "지연");
    const { dispatches } = await teams.postUserMessage(team.id, group.id, { text: "@all wait" });
    expect(dispatches).toHaveLength(2);
    await waitUntil(() => teams.detail(team.id).dispatch.running.length === 1);
    let d = teams.detail(team.id);
    expect(d.dispatch.running[0]).toMatchObject({ memberId: minsu.id, sessionId: minsu.sessionId, hop: 1 });
    expect(d.dispatch.queued[0]).toMatchObject({ memberId: jiyeon.id, hop: 1 });
    expect(member(d.team, "민수").state).toBe("running");
    expect(member(d.team, "지연").state).toBe("queued");
    await teams.interrupt(team.id, minsu.id);
    await waitUntil(() => teams.detail(team.id).dispatch.running[0]?.memberId === jiyeon.id);
    d = teams.detail(team.id);
    expect(d.dispatch.queued).toEqual([]);
    expect(member(d.team, "민수").state).toBe("idle");
    expect(member(d.team, "지연").state).toBe("running");
    await teams.patchTeam(team.id, { settings: { maxConcurrent: 2 } });
    await teams.interrupt(team.id, jiyeon.id);
    await waitUntil(quiet(teams, team.id));
    const texts = (await teams.roomDetail(team.id, group.id)).messages.filter((m) => m.kind === "system").map((m) => m.text);
    expect(texts).toEqual(["민수의 작업을 중단했습니다", "지연의 작업을 중단했습니다"]);
  });

  it("mirrors approvals into the room and fills the resolution after respondApproval", async () => {
    const { teams, manager, create } = await setup();
    const team = await create();
    const group = groupRoom(team);
    const minsu = member(team, "민수");
    const c = await collectRoom(teams, team.id, group.id);
    await teams.postUserMessage(team.id, group.id, { text: "approve" });
    await waitUntil(() => c.events.some((e) => e.type === "room.message" && e.message.kind === "approval"));
    const card = (c.events.find((e) => e.type === "room.message" && e.message.kind === "approval") as { message: RoomMessage }).message;
    expect(card).toMatchObject({
      text: "npm test 실행",
      hop: 1,
      approval: { memberId: minsu.id, sessionId: minsu.sessionId, approval: { title: "npm test 실행", kind: "command" }, resolution: null },
    });
    await waitUntil(() => member(teams.detail(team.id).team, "민수").state === "waiting_approval");
    expect(manager.get(minsu.sessionId!)!.status).toBe("waiting_approval");
    await manager.respondApproval(minsu.sessionId!, card.approval!.approval.approvalId, "allow");
    await waitUntil(quiet(teams, team.id));
    const updated = c.events.filter((e) => e.type === "room.message.updated" && e.message.id === card.id);
    expect(updated).toHaveLength(1);
    const ev = updated[0]!;
    if (ev.type !== "room.message.updated") throw new Error("type");
    expect(ev.message.seq).toBe(card.seq);
    expect(ev.message.approval!.resolution).toMatchObject({ optionId: "allow", by: "client" });
    const messages = (await teams.roomDetail(team.id, group.id)).messages;
    expect(messages.find((m) => m.id === card.id)!.approval!.resolution!.optionId).toBe("allow");
    expect(messages.at(-1)).toMatchObject({ kind: "text", author: { kind: "agent", memberId: minsu.id } });
    c.unsubscribe();
  });

  it("keeps another member's approval card out of the next member's turn input but keeps their reply", async () => {
    // 맥락 절약(PROTOCOL 6.4, 2026-09-14): 승인 카드는 방에는 남지만 다른 팀원의 턴 입력에서는 빠진다.
    const { teams, claude, manager, create } = await setup();
    const team = await create();
    const group = groupRoom(team);
    const jiyeon = member(team, "지연");
    const c = await collectRoom(teams, team.id, group.id);
    await teams.postUserMessage(team.id, group.id, { text: "@지연 approve" });
    await waitUntil(() => c.events.some((e) => e.type === "room.message" && e.message.kind === "approval"));
    const card = (c.events.find((e) => e.type === "room.message" && e.message.kind === "approval") as { message: RoomMessage }).message;
    expect(card.approval!.memberId).toBe(jiyeon.id);
    await manager.respondApproval(jiyeon.sessionId!, card.approval!.approval.approvalId, "allow");
    await waitUntil(quiet(teams, team.id));

    // 카드는 방에 그대로 남는다(사람이 봐야 한다)
    const messages = (await teams.roomDetail(team.id, group.id)).messages;
    expect(messages.filter((m) => m.kind === "approval")).toHaveLength(1);

    // 팀장(민수)이 도는 다음 턴의 입력에는 지연의 승인 카드 줄이 없고 지연의 대화는 있다
    await teams.postUserMessage(team.id, group.id, { text: "status" });
    await waitUntil(quiet(teams, team.id));
    const turn = claude.sessions[0]!.turns[0]!.text;
    expect(turn).not.toContain("승인 요청");
    expect(turn).not.toContain("npm test 실행");
    expect(turn).toContain("[#전체] 사용자: @지연 approve");
    expect(turn).toContain("[#전체] @지연(개발자): 완료했습니다: [#전체] 사용자: 지연 approve");
    expect(turn).toContain("[#전체] 사용자: status");
    c.unsubscribe();
  });

  it("keeps the member's own approval and change cards out of their own next turn input", async () => {
    // 맥락 절감(PROTOCOL 6.4, 2026-09-15): 자기가 실행한 명령과 바꾼 파일은 그 팀원 세션 타임라인에 이미 있다.
    const { teams, codex, manager, create } = await setup();
    const team = await create();
    const group = groupRoom(team);
    const jiyeon = member(team, "지연");
    const c = await collectRoom(teams, team.id, group.id);
    await teams.postUserMessage(team.id, group.id, { text: "@지연 approve write" });
    await waitUntil(() => c.events.some((e) => e.type === "room.message" && e.message.kind === "approval"));
    const card = (c.events.find((e) => e.type === "room.message" && e.message.kind === "approval") as { message: RoomMessage }).message;
    expect(card.approval!.memberId).toBe(jiyeon.id);
    await manager.respondApproval(jiyeon.sessionId!, card.approval!.approval.approvalId, "allow");
    await waitUntil(quiet(teams, team.id));
    await waitUntil(() => teams.listChanges(team.id).length === 1);

    // 방에는 자기 승인·변경 카드가 그대로 남는다(사람이 승인·머지해야 한다)
    const messages = (await teams.roomDetail(team.id, group.id)).messages;
    expect(messages.filter((m) => m.kind === "approval")).toHaveLength(1);
    expect(messages.filter((m) => m.kind === "changes")).toHaveLength(1);

    // 같은 팀원(지연)의 다음 턴 입력에는 자기 승인·변경 줄이 없다
    await teams.postUserMessage(team.id, group.id, { text: "@지연 status" });
    await waitUntil(quiet(teams, team.id));
    expect(codex.sessions[0]!.turns).toHaveLength(2);
    const turn = codex.sessions[0]!.turns[1]!.text;
    expect(turn).not.toContain("승인 요청");
    expect(turn).not.toContain("npm test 실행");
    expect(turn).not.toContain("변경 준비됨");
    expect(turn).toContain("[#전체] 사용자: @지연 status");
    c.unsubscribe();
  });

  it("commits worktree changes after the turn, posts a ready ChangeSet and marks the previous one stale", async () => {
    const { teams, repo, dataDir, create } = await setup();
    const team = await create();
    const group = groupRoom(team);
    const jiyeon = member(team, "지연");
    const c = await collectRoom(teams, team.id, group.id);
    await teams.postUserMessage(team.id, group.id, { text: "@지연 write" });
    await waitUntil(quiet(teams, team.id));
    await waitUntil(() => teams.listChanges(team.id).length === 1);
    expect((await git(jiyeon.worktreePath, "log", "--format=%an <%ae>", "-1")).trim()).toBe("지연 (mam-team) <jiyeon@mam.local>");
    expect((await git(jiyeon.worktreePath, "log", "--format=%s", "-1")).trim()).toBe("지연(개발자): 완료했습니다: [#전체] 사용자: 지연 write");
    expect((await git(jiyeon.worktreePath, "status", "--porcelain")).trim()).toBe("");
    const [first] = teams.listChanges(team.id);
    expect(ChangeSetSchema.safeParse(first).success).toBe(true);
    expect(first).toMatchObject({
      teamId: team.id,
      memberId: jiyeon.id,
      sessionId: jiyeon.sessionId,
      branch: jiyeon.branch,
      baseBranch: "main",
      files: [{ path: "out.txt", kind: "add", additions: 1, deletions: 0 }],
      commits: 1,
      status: "ready",
      conflictFiles: [],
    });
    expect(first!.commit).toBe((await git(repo, "rev-parse", jiyeon.branch)).trim());
    const msgs = (await teams.roomDetail(team.id, group.id)).messages;
    const card = msgs.find((m) => m.kind === "changes")!;
    expect(card.id).toBe(first!.messageId);
    expect(card).toMatchObject({ author: { kind: "agent", memberId: jiyeon.id }, changes: { id: first!.id, status: "ready" } });
    expect(card.text).toContain("1개 파일");
    const saved = JSON.parse(await readFile(join(dataDir, "teams", team.id, "changes.json"), "utf8")) as unknown[];
    expect(saved).toHaveLength(1);
    // 답변 메시지의 work.filesChanged 에 파일이 들어 있다
    expect(msgs.find((m) => m.kind === "text" && m.author.kind === "agent")!.work!.filesChanged).toEqual(["out.txt"]);

    // 두 번째 쓰기 → 이전 ready 는 stale
    await teams.postUserMessage(team.id, group.id, { text: "@지연 write again" });
    await waitUntil(quiet(teams, team.id));
    await waitUntil(() => teams.listChanges(team.id).length === 2);
    const changes = teams.listChanges(team.id);
    expect(changes.map((ch) => ch.status)).toEqual(["stale", "ready"]);
    expect(changes[1]!.commits).toBe(2);
    const stale = c.events.filter((e) => e.type === "room.message.updated" && e.message.id === first!.messageId);
    expect(stale).toHaveLength(1);
    expect((stale[0] as { message: RoomMessage }).message.changes!.status).toBe("stale");
    // 변경이 없는 턴은 카드를 올리지 않는다
    await teams.postUserMessage(team.id, group.id, { text: "@지연 nothing" });
    await waitUntil(quiet(teams, team.id));
    expect(teams.listChanges(team.id)).toHaveLength(2);
    expect(teams.detail(team.id).changes).toHaveLength(2);
    c.unsubscribe();
  });

  it("stop interrupts running turns and clears the queue; a failing turn marks the member error", async () => {
    const { teams, create } = await setup({ settings: { maxConcurrent: 1 } });
    const team = await create();
    const group = groupRoom(team);
    await teams.postUserMessage(team.id, group.id, { text: "@all wait" });
    await waitUntil(() => teams.detail(team.id).dispatch.running.length === 1 && teams.detail(team.id).dispatch.queued.length === 1);
    const state = await teams.stop(team.id);
    expect(state).toEqual({ running: [], queued: [] });
    await waitUntil(quiet(teams, team.id));
    const d = teams.detail(team.id);
    expect(d.team.members.map((m) => m.state)).toEqual(["idle", "idle"]);
    const msgs = (await teams.roomDetail(team.id, group.id)).messages;
    expect(msgs.filter((m) => m.author.kind === "agent")).toHaveLength(0);
    expect(msgs.filter((m) => m.kind === "system").map((m) => m.text)).toContain("민수의 작업을 중단했습니다");

    await teams.postUserMessage(team.id, group.id, { text: "@지연 fail" });
    await waitUntil(quiet(teams, team.id));
    expect(member(teams.detail(team.id).team, "지연").state).toBe("error");
    const after = (await teams.roomDetail(team.id, group.id)).messages;
    expect(after.at(-1)).toMatchObject({ kind: "system" });
    expect(after.at(-1)!.text).toContain("지연");
    expect(after.at(-1)!.text).toContain("가짜 오류");

    // 한도 오류는 큐를 멈추고 안내한다
    await teams.postUserMessage(team.id, group.id, { text: "@지연 limit" });
    await waitUntil(quiet(teams, team.id));
    const texts = (await teams.roomDetail(team.id, group.id)).messages.map((m) => m.text);
    expect(texts).toContain("구독 사용 한도에 걸려 팀 작업을 멈췄습니다. 한도가 풀리면 메시지를 보내 다시 시작하세요");
    // 다음 사용자 메시지가 정지를 푼다
    await teams.postUserMessage(team.id, group.id, { text: "@지연 ok" });
    await waitUntil(quiet(teams, team.id));
    expect(member(teams.detail(team.id).team, "지연").state).toBe("idle");
  });
});

describe("TeamManager lifecycle", () => {
  it("patchMember/addMember/removeMember/resetMember keep handles and sessions consistent", async () => {
    const { teams, manager, codex, create } = await setup();
    const team = await create();
    const minsu = member(team, "민수");
    const jiyeon = member(team, "지연");
    const patched = await teams.patchMember(team.id, jiyeon.id, { name: "지연2", emoji: "🐙", mode: "ask", model: "fake-mini", prompt: "커스텀 지시" });
    const j2 = patched.members.find((m) => m.id === jiyeon.id)!;
    expect(j2).toMatchObject({ name: "지연2", emoji: "🐙", mode: "ask", model: "fake-mini", prompt: "커스텀 지시", handle: "jiyeon", branch: jiyeon.branch });
    expect(manager.get(jiyeon.sessionId!)).toMatchObject({ mode: "ask", model: "fake-mini" });
    await expect(teams.patchMember(team.id, jiyeon.id, { name: "민수" })).rejects.toBeInstanceOf(ConflictError);
    await expect(teams.patchMember(team.id, newId("agt"), { name: "x" })).rejects.toBeInstanceOf(NotFoundError);

    const added = await teams.addMember(team.id, { name: "하나", role: "code-reviewer", agent: "codex" });
    const hana = added.members.find((m) => m.name === "하나")!;
    expect(hana.handle).toBe("agent-3");
    expect(hana.branch).toBe("mam/backend/agent-3");
    expect(await exists(join(hana.worktreePath, "a.txt"))).toBe(true);
    expect(added.rooms.some((r) => r.kind === "dm" && r.memberId === hana.id && r.name === "하나")).toBe(true);
    expect(codex.startCalls).toEqual([]);

    await expect(teams.removeMember(team.id, minsu.id, {})).rejects.toBeInstanceOf(InvalidRequestError);
    const removed = await teams.removeMember(team.id, hana.id, {});
    expect(removed.members.map((m) => m.id)).toEqual([minsu.id, jiyeon.id]);
    expect(removed.rooms.some((r) => r.memberId === hana.id)).toBe(true);
    expect(await exists(hana.worktreePath)).toBe(false);
    expect(manager.get(hana.sessionId!)!.status).toBe("closed");

    const reset = await teams.resetMember(team.id, jiyeon.id);
    const j3 = reset.members.find((m) => m.id === jiyeon.id)!;
    expect(j3.sessionId).not.toBe(jiyeon.sessionId);
    expect(manager.get(jiyeon.sessionId!)!.status).toBe("closed");
    expect(manager.get(j3.sessionId!)).toMatchObject({ status: "idle", cwd: jiyeon.worktreePath });
    expect(j3.state).toBe("idle");
    // 새 세션에는 바뀐 프롬프트가 들어간다
    await teams.postUserMessage(team.id, dmRoom(reset, jiyeon.id).id, { text: "hi" });
    await waitUntil(quiet(teams, team.id));
    expect(codex.startCalls[0]!.instructions!.startsWith("커스텀 지시")).toBe(true);
    expect(codex.startCalls[0]!.mode).toBe("ask");
  });

  it("deleteTeam removes worktrees, files and sessions when clean, and refuses with 409 when dirty", async () => {
    const { teams, manager, dataDir, create } = await setup();
    const team = await create();
    const minsu = member(team, "민수");
    await writeFile(join(minsu.worktreePath, "dirty.txt"), "x\n");
    await expect(teams.deleteTeam(team.id, {})).rejects.toBeInstanceOf(ConflictError);
    expect(await exists(join(minsu.worktreePath, "dirty.txt"))).toBe(true);
    expect(await exists(join(dataDir, "teams", team.id, "team.json"))).toBe(true);
    expect(manager.get(minsu.sessionId!)!.status).toBe("idle");
    expect(teams.getTeam(team.id).id).toBe(team.id);

    await teams.deleteTeam(team.id, { keepWorktrees: true });
    expect(() => teams.getTeam(team.id)).toThrow(NotFoundError);
    expect(await exists(join(minsu.worktreePath, "dirty.txt"))).toBe(true);
    expect(await exists(join(dataDir, "teams", team.id, "team.json"))).toBe(false);
    expect(manager.get(minsu.sessionId!)!.status).toBe("closed");

    const clean = await create({ name: "clean" });
    await teams.deleteTeam(clean.id, {});
    for (const m of clean.members) {
      expect(await exists(m.worktreePath)).toBe(false);
      expect(manager.get(m.sessionId!)!.status).toBe("closed");
    }
    expect(await exists(join(dataDir, "teams", clean.id))).toBe(false);
    expect(teams.listTeams()).toEqual([]);
  });

  it("restart restores teams, rooms, messages and changes, resets member states and announces the restart", async () => {
    const first = await setup();
    const team = await first.create();
    const group = groupRoom(team);
    await first.teams.postUserMessage(team.id, group.id, { text: "@지연 write" });
    await waitUntil(quiet(first.teams, team.id));
    await waitUntil(() => first.teams.listChanges(team.id).length === 1);
    const before = await first.teams.roomDetail(team.id, group.id);
    await first.teams.shutdown();
    await first.manager.shutdown();
    // 죽기 직전 running 이었던 흔적을 남긴다
    const path = join(first.dataDir, "teams", team.id, "team.json");
    const record = JSON.parse(await readFile(path, "utf8")) as TeamRecord;
    record.members[1]!.state = "running";
    await writeFile(path, JSON.stringify(record), "utf8");

    const second = await setup({ home: first.home });
    const restored = second.teams.getTeam(team.id);
    expect(restored.members.map((m) => m.state)).toEqual(["idle", "idle"]);
    expect(restored.rooms.map((r) => r.id)).toEqual(team.rooms.map((r) => r.id));
    expect(second.teams.listChanges(team.id)).toEqual(first.teams.listChanges(team.id));
    const after = await second.teams.roomDetail(team.id, group.id);
    expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages);
    expect(after.messages.at(-1)).toMatchObject({ kind: "system", text: "서버가 다시 시작되어 진행 중이던 작업은 취소됐습니다" });
    expect(after.room.lastSeq).toBeGreaterThan(before.room.lastSeq);
    expect(second.teams.detail(team.id).dispatch).toEqual({ running: [], queued: [] });
    // 복원된 팀에 이어서 디스패치할 수 있고 세션은 재개된다
    await second.teams.postUserMessage(team.id, group.id, { text: "@지연 hi" });
    await waitUntil(quiet(second.teams, team.id));
    expect(second.codex.startCalls[0]!.resumeNativeId).toBeTruthy();
    const messages = (await second.teams.roomDetail(team.id, group.id)).messages;
    expect(messages.at(-1)).toMatchObject({ kind: "text", author: { kind: "agent", memberId: member(team, "지연").id } });
    await second.teams.shutdown();
    await second.manager.shutdown();
  });

  it("reconciles orphaned approval cards on restart and leaves resolved ones untouched", async () => {
    // 재시작하면 SessionManager 가 모든 세션의 대기 승인을 0 으로 되돌리므로 방의 미해결 카드는 전부 유령이다
    // (PROTOCOL 6.4 "승인 미러링", ADR-019). 실제 팀에서 이 카드를 누르면 404 가 났다.
    const first = await setup();
    const team = await first.create();
    const group = groupRoom(team);
    const jiyeon = member(team, "지연");
    const c = await collectRoom(first.teams, team.id, group.id);
    // (1) 사용자가 실제로 응답해 by: "client" 로 해결된 카드
    await first.teams.postUserMessage(team.id, group.id, { text: "@지연 approve" });
    await waitUntil(() => approvalCards(c.events).length === 1);
    const answered = approvalCards(c.events)[0]!;
    await first.manager.respondApproval(jiyeon.sessionId!, answered.approval!.approval.approvalId, "allow");
    await waitUntil(quiet(first.teams, team.id));
    // (2) 팀장이 승인을 기다리는 채로 서버가 죽는다
    await first.teams.postUserMessage(team.id, group.id, { text: "approve" });
    await waitUntil(() => approvalCards(c.events).length === 2);
    const ghost = approvalCards(c.events)[1]!;
    expect((await first.teams.roomPendingApprovals(team.id, group.id)).map((a) => a.approval.approvalId)).toEqual([
      ghost.approval!.approval.approvalId,
    ]);
    c.unsubscribe();
    await first.teams.shutdown();
    await first.manager.shutdown();

    const second = await setup({ home: first.home });
    const messages = (await second.teams.roomDetail(team.id, group.id)).messages;
    const cleaned = messages.find((m) => m.id === ghost.id)!;
    // 카드는 지우지 않고 kind·본문·seq 를 유지한 채 resolution 만 채운다
    expect(cleaned).toMatchObject({ kind: "approval", text: ghost.text, seq: ghost.seq });
    expect(cleaned.approval!.resolution).toMatchObject({ optionId: "abort", by: "system" });
    expect(messages.find((m) => m.id === answered.id)!.approval!.resolution).toMatchObject({ optionId: "allow", by: "client" });
    expect(await second.teams.roomPendingApprovals(team.id, group.id)).toEqual([]);
    // 정리는 room.message.updated 로 나간다(같은 message.id, message.seq 는 원래 값)
    const replay = await collectRoom(second.teams, team.id, group.id);
    const updates = replay.events.filter((e) => e.type === "room.message.updated");
    const forGhost = updates.filter((e) => e.type === "room.message.updated" && e.message.id === ghost.id);
    expect(forGhost).toHaveLength(1);
    const ev = forGhost[0]!;
    if (ev.type !== "room.message.updated") throw new Error("type");
    expect(ev.message.seq).toBe(ghost.seq);
    expect(ev.seq).toBeGreaterThan(ghost.seq);
    // 이미 해결된 카드는 재조정이 다시 쓰지 않는다(사용자 응답 1건뿐)
    expect(updates.filter((e) => e.type === "room.message.updated" && e.message.id === answered.id)).toHaveLength(1);
    replay.unsubscribe();
    await second.teams.shutdown();
    await second.manager.shutdown();
  });

  it("keeps a live approval card when another member is reset", async () => {
    // 이 step 의 핵심 안전장치: 같은 프로세스에서 사람을 기다리는 승인은 재조정이 죽이지 않는다.
    const { teams, manager, create } = await setup();
    const team = await create();
    const group = groupRoom(team);
    const minsu = member(team, "민수");
    const jiyeon = member(team, "지연");
    const c = await collectRoom(teams, team.id, group.id);
    await teams.postUserMessage(team.id, group.id, { text: "@지연 approve" });
    await waitUntil(() => approvalCards(c.events).length === 1);
    const card = approvalCards(c.events)[0]!;

    await teams.resetMember(team.id, minsu.id);
    const after = (await teams.roomDetail(team.id, group.id)).messages.find((m) => m.id === card.id)!;
    expect(after.approval!.resolution).toBeNull();
    expect(manager.pendingApprovals(jiyeon.sessionId!).map((a) => a.approvalId)).toEqual([card.approval!.approval.approvalId]);
    expect(await teams.roomPendingApprovals(team.id, group.id)).toHaveLength(1);
    expect(c.events.filter((e) => e.type === "room.message.updated" && e.message.id === card.id)).toHaveLength(0);

    // 사람이 응답하면 그대로 client 로 해결된다
    await manager.respondApproval(jiyeon.sessionId!, card.approval!.approval.approvalId, "allow");
    await waitUntil(quiet(teams, team.id));
    const resolved = (await teams.roomDetail(team.id, group.id)).messages.find((m) => m.id === card.id)!;
    expect(resolved.approval!.resolution).toMatchObject({ optionId: "allow", by: "client" });
    c.unsubscribe();
  });

  it("clears orphaned approval cards on resetMember and removeMember and fans the update out", async () => {
    const { teams, manager, create } = await setup();
    const team = await create();
    const group = groupRoom(team);
    const jiyeon = member(team, "지연");
    const c = await collectRoom(teams, team.id, group.id);
    // 턴이 끝난 뒤 세션이 닫히면(구독이 이미 끊긴 뒤라 approval.resolved 가 방에 반영되지 않는다) 카드가 유령이 된다
    await teams.postUserMessage(team.id, group.id, { text: "@지연 ghost" });
    await waitUntil(() => approvalCards(c.events).length === 1);
    await waitUntil(quiet(teams, team.id));
    const card = approvalCards(c.events)[0]!;
    expect(await teams.roomPendingApprovals(team.id, group.id)).toHaveLength(1);
    await manager.close(jiyeon.sessionId!);
    expect((await teams.roomDetail(team.id, group.id)).messages.find((m) => m.id === card.id)!.approval!.resolution).toBeNull();

    await teams.resetMember(team.id, jiyeon.id);
    const cleaned = (await teams.roomDetail(team.id, group.id)).messages.find((m) => m.id === card.id)!;
    expect(cleaned).toMatchObject({ kind: "approval", text: card.text, seq: card.seq });
    expect(cleaned.approval!.resolution).toMatchObject({ optionId: "abort", by: "system" });
    expect(await teams.roomPendingApprovals(team.id, group.id)).toEqual([]);
    const updates = c.events.filter((e) => e.type === "room.message.updated" && e.message.id === card.id);
    expect(updates).toHaveLength(1);
    const ev = updates[0]!;
    if (ev.type !== "room.message.updated") throw new Error("type");
    expect(ev.message.seq).toBe(card.seq);
    expect(ev.seq).toBeGreaterThan(card.seq);

    // removeMember 도 같은 정리를 한다
    const next = member(teams.getTeam(team.id), "지연");
    await teams.postUserMessage(team.id, group.id, { text: "@지연 ghost" });
    await waitUntil(() => approvalCards(c.events).length === 2);
    await waitUntil(quiet(teams, team.id));
    const second = approvalCards(c.events)[1]!;
    await manager.close(next.sessionId!);
    await teams.removeMember(team.id, next.id, {});
    const afterRemove = (await teams.roomDetail(team.id, group.id)).messages.find((m) => m.id === second.id)!;
    expect(afterRemove.approval!.resolution).toMatchObject({ optionId: "abort", by: "system" });
    expect(await teams.roomPendingApprovals(team.id, group.id)).toEqual([]);
    c.unsubscribe();
  });
});
