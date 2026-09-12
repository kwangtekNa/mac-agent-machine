import { access, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ChangeSetSchema,
  MergeResultSchema,
  parseRoomServerEvent,
  type ChangeSet,
  type MemberInput,
  type RoomServerEvent,
  type Team,
  type TeamSettings,
} from "@mam/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAdapter, type FakeScript } from "../../src/agents/fake/index.js";
import { ConflictError, NotFoundError } from "../../src/errors.js";
import { newId } from "../../src/ids.js";
import { SessionManager } from "../../src/sessions/manager.js";
import { ChangeStore, conflictNoteFor } from "../../src/teams/changes.js";
import { TeamManager } from "../../src/teams/team-manager.js";
import { git, initRepo, makeTmpHome, removeTmp } from "../helpers/tmp-home.js";

const silent = { info() {}, warn() {}, error() {} };
const SHA_RE = /^[0-9a-f]{40}$/;
const dirs: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => undefined);
  for (const d of dirs.splice(0)) await removeTmp(d);
});

/**
 * 트리거 줄(뒤에서 세 번째 줄)에 따라 worktree(`ctx.cwd`)에 파일을 쓴다.
 * "write" → `out.txt`(턴마다 다른 내용), "clash" → `a.txt` 를 "from-branch" 로,
 * "충돌" (머지 충돌 해결 지시) → `hooks.gate` 를 기다린 뒤 `a.txt` 를 마커 없는 "resolved" 로 덮어쓴다.
 */
const hooks: { gate?: Promise<void> } = {};
const script: FakeScript = async (ctx) => {
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
  emitItem("tool_call", { tool: "bash", name: "Bash", title: "echo", input: {}, output: "ok\n", exitCode: 0, truncated: false });
  const files: Array<{ path: string; kind: string; additions: number; deletions: number }> = [];
  if (trigger.includes("write")) {
    await writeFile(join(ctx.cwd, "out.txt"), `${turnId}\n`);
    files.push({ path: "out.txt", kind: "add", additions: 1, deletions: 0 });
  }
  if (trigger.includes("clash")) {
    await writeFile(join(ctx.cwd, "a.txt"), "from-branch\n");
    files.push({ path: "a.txt", kind: "modify", additions: 1, deletions: 1 });
  }
  if (trigger.includes("충돌")) {
    if (hooks.gate) await hooks.gate;
    await writeFile(join(ctx.cwd, "a.txt"), "resolved\n");
    files.push({ path: "a.txt", kind: "modify", additions: 1, deletions: 1 });
  }
  if (files.length > 0) emitItem("file_change", { files, patch: "" });
  emitItem("assistant_message", { text: `완료했습니다: ${trigger.replaceAll("@", "")}`, phase: "final" });
  const summary = { durationMs: 5, usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.001, stopReason: "end_turn" };
  emitItem("turn_summary", summary);
  ctx.emit({ type: "turn.completed", turnId, ...summary });
  ctx.emit({ type: "status", status: "idle" });
};

const MEMBERS: MemberInput[] = [
  { name: "민수", handle: "minsu", role: "team-lead", agent: "claude", isLead: true },
  { name: "지연", handle: "jiyeon", role: "developer", agent: "codex" },
];

async function setup(opts: { settings?: Partial<TeamSettings>; home?: string } = {}) {
  const home = opts.home ?? (await realpath(await makeTmpHome("mam-chg-")));
  if (!opts.home) dirs.push(home);
  const dataDir = join(home, ".mam");
  const repo = join(home, "work", "app");
  if (!opts.home) {
    await initRepo(repo);
    await writeFile(join(repo, "a.txt"), "hello\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-q", "-m", "init");
  }
  const claude = new FakeAdapter({ kind: "claude", autoApprove: true, script });
  const codex = new FakeAdapter({ kind: "codex", autoApprove: true, script });
  const manager = await SessionManager.open({ dataDir, adapters: { claude, codex }, logger: silent });
  const teams = await TeamManager.open({ dataDir, home, manager, logger: silent });
  cleanups.push(async () => {
    await teams.shutdown();
    await manager.shutdown();
  });
  const create = () => teams.createTeam({ cwd: repo, name: "backend", members: MEMBERS, settings: opts.settings ?? {} });
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
const porcelain = (dir: string) => git(dir, "status", "--porcelain");
const head = async (dir: string, rev = "HEAD") => (await git(dir, "rev-parse", rev)).trim();
async function hasMergeHead(dir: string): Promise<boolean> {
  try {
    await git(dir, "rev-parse", "--verify", "--quiet", "MERGE_HEAD");
    return true;
  } catch {
    return false;
  }
}

async function collectRoom(teams: TeamManager, teamId: string, roomId: string) {
  const events: RoomServerEvent[] = [];
  const unsubscribe = await teams.subscribeRoom(teamId, roomId, 0, (e) => {
    parseRoomServerEvent(e);
    events.push(e);
  });
  return { events, unsubscribe };
}

/** 카드(messageId)에 대한 `room.message.updated` 이벤트의 status 흐름. */
const cardStatuses = (events: RoomServerEvent[], messageId: string): string[] =>
  events.flatMap((e) => (e.type === "room.message.updated" && e.message.id === messageId ? [e.message.changes!.status] : []));

/** 지연에게 write 를 시켜 ready ChangeSet 하나를 만든다. */
async function readyChange(teams: TeamManager, team: Team, text = "@지연 write"): Promise<ChangeSet> {
  const before = teams.listChanges(team.id).length;
  await teams.postUserMessage(team.id, groupRoom(team).id, { text });
  await waitUntil(quiet(teams, team.id));
  await waitUntil(() => teams.listChanges(team.id).length === before + 1);
  return teams.listChanges(team.id).at(-1)!;
}

describe("ChangeStore", () => {
  it("returns [] when changes.json is missing, round-trips a saved list and ignores a corrupted file", async () => {
    const home = await makeTmpHome("mam-chg-store-");
    dirs.push(home);
    const teamDir = join(home, "teams", "team_x");
    const store = new ChangeStore(teamDir, silent);
    expect(await store.load()).toEqual([]);
    const change: ChangeSet = {
      id: newId("chg"),
      teamId: newId("team"),
      memberId: newId("agt"),
      sessionId: newId("ses"),
      turnId: newId("trn"),
      branch: "mam/backend/jiyeon",
      baseBranch: "main",
      commit: "a".repeat(40),
      files: [{ path: "a.txt", kind: "modify", additions: 1, deletions: 1 }],
      commits: 1,
      status: "ready",
      conflictFiles: [],
      messageId: newId("msg"),
      createdAt: "2026-09-12T00:00:00.000Z",
      updatedAt: "2026-09-12T00:00:00.000Z",
    };
    await store.save([change]);
    expect(await exists(join(teamDir, "changes.json"))).toBe(true);
    expect(await new ChangeStore(teamDir, silent).load()).toEqual([change]);
    await writeFile(join(teamDir, "changes.json"), "{not json", "utf8");
    expect(await store.load()).toEqual([]);
    await writeFile(join(teamDir, "changes.json"), JSON.stringify([{ id: "nope" }]), "utf8");
    expect(await store.load()).toEqual([]);
  });
});

describe("conflictNoteFor", () => {
  it("names the files, the base branch, the markers and forbids git commands", () => {
    const note = conflictNoteFor(["a.txt", "src/b.ts"], "main");
    expect(note.startsWith("머지 충돌: a.txt, src/b.ts.")).toBe(true);
    expect(note).toContain("main");
    expect(note).toContain("충돌 마커(<<<<<<<, >>>>>>>)를 정리하고 파일을 저장하라");
    expect(note.endsWith("git 명령은 실행하지 마라.")).toBe(true);
    expect(note).not.toContain("\n");
    expect(conflictNoteFor([], "main")).toContain("머지 충돌");
  });
});

describe("TeamManager.merge", () => {
  it("merges a ready ChangeSet with --no-ff, updates the card, keeps the branch and syncs the member worktree", async () => {
    const { teams, repo, dataDir, create } = await setup();
    const team = await create();
    const group = groupRoom(team);
    const jiyeon = member(team, "지연");
    const minsu = member(team, "민수");
    const c = await collectRoom(teams, team.id, group.id);
    const ready = await readyChange(teams, team);
    const minsuHead = await head(minsu.worktreePath);

    const result = await teams.merge(team.id, ready.id);
    expect(MergeResultSchema.safeParse(result).success).toBe(true);
    expect(result.change).toMatchObject({ id: ready.id, status: "merged", conflictFiles: [], commit: ready.commit });
    expect(result.mergeCommit).toMatch(SHA_RE);
    expect(result.change.updatedAt > ready.updatedAt).toBe(true);
    // 베이스: --no-ff 머지 커밋, 메시지, 브랜치 유지, 깨끗한 체크아웃
    expect(await head(repo)).toBe(result.mergeCommit);
    expect((await git(repo, "log", "--merges", "--format=%s")).trim()).toBe(`Merge ${jiyeon.branch} (지연)`);
    expect(await head(repo, `${result.mergeCommit}^2`)).toBe(ready.commit);
    expect(await exists(join(repo, "out.txt"))).toBe(true);
    expect((await git(repo, "symbolic-ref", "--short", "HEAD")).trim()).toBe("main");
    expect(await porcelain(repo)).toBe("");
    expect((await git(repo, "branch", "--list", jiyeon.branch)).trim()).toContain(jiyeon.branch);
    // 그 팀원 worktree 만 베이스와 같은 head 로 동기화된다
    expect(await head(jiyeon.worktreePath)).toBe(result.mergeCommit);
    expect(await head(minsu.worktreePath)).toBe(minsuHead);
    // 카드 갱신 merging → merged, 저장
    expect(cardStatuses(c.events, ready.messageId)).toEqual(["merging", "merged"]);
    const card = (await teams.roomDetail(team.id, group.id)).messages.find((m) => m.id === ready.messageId)!;
    expect(card.changes).toMatchObject({ id: ready.id, status: "merged" });
    expect(teams.listChanges(team.id)[0]!.status).toBe("merged");
    const saved = JSON.parse(await readFile(join(dataDir, "teams", team.id, "changes.json"), "utf8")) as ChangeSet[];
    expect(saved[0]!.status).toBe("merged");
    // merged 는 다시 머지·dismiss 할 수 없다, 모르는 ID 는 404
    await expect(teams.merge(team.id, ready.id)).rejects.toBeInstanceOf(ConflictError);
    await expect(teams.dismiss(team.id, ready.id)).rejects.toBeInstanceOf(ConflictError);
    await expect(teams.merge(team.id, newId("chg"))).rejects.toBeInstanceOf(NotFoundError);
    // 같은 브랜치에서 계속 일한다: 다음 턴의 ChangeSet 은 베이스 대비 커밋 1개, merged 는 stale 이 되지 않는다
    const next = await readyChange(teams, team);
    expect(next).toMatchObject({ status: "ready", commits: 1, branch: jiyeon.branch });
    expect(teams.listChanges(team.id).map((ch) => ch.status)).toEqual(["merged", "ready"]);
    c.unsubscribe();
  });

  it("refuses with 409 when the checkout is dirty or on another branch and leaves the ChangeSet ready", async () => {
    const { teams, repo, create } = await setup();
    const team = await create();
    const group = groupRoom(team);
    const c = await collectRoom(teams, team.id, group.id);
    const ready = await readyChange(teams, team);
    const baseHead = await head(repo);

    await writeFile(join(repo, "wip.txt"), "wip\n");
    await expect(teams.merge(team.id, ready.id)).rejects.toMatchObject({
      code: "conflict",
      status: 409,
      message: "프로젝트에 커밋되지 않은 변경이 있어 머지할 수 없습니다. 먼저 커밋하거나 stash 하세요",
    });
    expect(teams.listChanges(team.id)[0]!.status).toBe("ready");
    expect(await exists(join(repo, "wip.txt"))).toBe(true);
    await rm(join(repo, "wip.txt"));

    await git(repo, "checkout", "-q", "-b", "other");
    const err = await teams.merge(team.id, ready.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as Error).message).toContain("현재 브랜치가 main 가 아닙니다");
    expect(teams.listChanges(team.id)[0]!.status).toBe("ready");
    expect(await head(repo)).toBe(baseHead);
    expect((await git(repo, "log", "--merges", "--format=%s")).trim()).toBe("");
    await git(repo, "checkout", "-q", "main");
    // 실패 경로마다 카드는 merging → ready 로 되돌아간다
    expect(cardStatuses(c.events, ready.messageId)).toEqual(["merging", "ready", "merging", "ready"]);
    // 전제조건이 맞으면 머지된다
    expect((await teams.merge(team.id, ready.id)).change.status).toBe("merged");
    c.unsubscribe();
  });

  it("dismiss marks ready as dismissed, keeps the branch commit and refuses a second dismiss or a merge", async () => {
    const { teams, repo, dataDir, create } = await setup();
    const team = await create();
    const group = groupRoom(team);
    const jiyeon = member(team, "지연");
    const c = await collectRoom(teams, team.id, group.id);
    const ready = await readyChange(teams, team);

    const dismissed = await teams.dismiss(team.id, ready.id);
    expect(ChangeSetSchema.safeParse(dismissed).success).toBe(true);
    expect(dismissed).toMatchObject({ id: ready.id, status: "dismissed", commit: ready.commit, conflictFiles: [] });
    expect(await head(repo, jiyeon.branch)).toBe(ready.commit);
    expect((await git(repo, "branch", "--list", jiyeon.branch)).trim()).toContain(jiyeon.branch);
    expect((await git(repo, "log", "--merges", "--format=%s")).trim()).toBe("");
    expect(cardStatuses(c.events, ready.messageId)).toEqual(["dismissed"]);
    expect(teams.listChanges(team.id)[0]!.status).toBe("dismissed");
    const saved = JSON.parse(await readFile(join(dataDir, "teams", team.id, "changes.json"), "utf8")) as ChangeSet[];
    expect(saved[0]!.status).toBe("dismissed");
    await expect(teams.dismiss(team.id, ready.id)).rejects.toBeInstanceOf(ConflictError);
    await expect(teams.merge(team.id, ready.id)).rejects.toBeInstanceOf(ConflictError);
    await expect(teams.dismiss(team.id, newId("chg"))).rejects.toBeInstanceOf(NotFoundError);
    await expect(teams.dismiss(newId("team"), ready.id)).rejects.toBeInstanceOf(NotFoundError);
    // 같은 팀원의 다음 ChangeSet 은 dismissed 를 건드리지 않는다
    await readyChange(teams, team);
    expect(teams.listChanges(team.id).map((ch) => ch.status)).toEqual(["dismissed", "ready"]);
    c.unsubscribe();
  });

  it("conflict: aborts the base merge, leaves markers in the member worktree, dispatches the fix via DM and merges after resolution", async () => {
    const { teams, repo, codex, create } = await setup();
    const team = await create();
    const group = groupRoom(team);
    const jiyeon = member(team, "지연");
    const minsu = member(team, "민수");
    const dm = dmRoom(team, jiyeon.id);
    const cg = await collectRoom(teams, team.id, group.id);
    const cd = await collectRoom(teams, team.id, dm.id);
    const first = await readyChange(teams, team, "@지연 clash");
    expect(first.files).toEqual([{ path: "a.txt", kind: "modify", additions: 1, deletions: 1 }]);
    // 베이스에서 같은 파일 같은 줄을 먼저 바꿔 커밋
    await writeFile(join(repo, "a.txt"), "from-main\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-q", "-m", "main side");
    const baseHead = await head(repo);
    const minsuHead = await head(minsu.worktreePath);

    let release!: () => void;
    hooks.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const result = await teams.merge(team.id, first.id);
      expect(MergeResultSchema.safeParse(result).success).toBe(true);
      expect(result).toMatchObject({ change: { id: first.id, status: "conflict", conflictFiles: ["a.txt"] }, mergeCommit: null });
      // 베이스 체크아웃은 깨끗하고 머지 흔적이 없다
      expect(await porcelain(repo)).toBe("");
      expect(await hasMergeHead(repo)).toBe(false);
      expect(await head(repo)).toBe(baseHead);
      expect((await git(repo, "show", "HEAD:a.txt")).toString()).toBe("from-main\n");
      // 그 팀원 worktree 에만 MERGE_HEAD 와 마커가 남는다
      expect(await hasMergeHead(jiyeon.worktreePath)).toBe(true);
      expect(await readFile(join(jiyeon.worktreePath, "a.txt"), "utf8")).toContain("<<<<<<<");
      expect(await hasMergeHead(minsu.worktreePath)).toBe(false);
      expect(await head(minsu.worktreePath)).toBe(minsuHead);
      // DM 방의 system 메시지와 그 팀원에게 간 디스패치(루트, hop 0 메시지)
      const dmMessages = (await teams.roomDetail(team.id, dm.id)).messages;
      const notice = dmMessages.at(-1)!;
      expect(notice).toMatchObject({
        author: { kind: "system" },
        kind: "system",
        text: "main 에 머지하는 중 충돌이 났습니다: a.txt. worktree 에서 충돌을 해결하고 파일을 저장하세요.",
        hop: 0,
        dispatchId: null,
      });
      await waitUntil(() => teams.detail(team.id).dispatch.running.some((r) => r.memberId === jiyeon.id));
      expect(teams.detail(team.id).dispatch.running[0]).toMatchObject({ memberId: jiyeon.id, roomId: dm.id, hop: 1 });
      expect(cardStatuses(cg.events, first.messageId)).toEqual(["merging", "conflict"]);
      expect(teams.listChanges(team.id)[0]).toMatchObject({ status: "conflict", conflictFiles: ["a.txt"] });
      // 다른 ready 가 아닌 것은 머지할 수 없다
      await expect(teams.merge(team.id, first.id)).rejects.toBeInstanceOf(ConflictError);
    } finally {
      release();
      hooks.gate = undefined;
    }
    await waitUntil(quiet(teams, team.id));
    await waitUntil(() => teams.listChanges(team.id).length === 2);
    // 턴 텍스트 앞에 conflictNote, 마지막에 DM 트리거
    const turn = codex.sessions[0]!.turns.at(-1)!.text;
    expect(turn.startsWith("머지 충돌: a.txt.")).toBe(true);
    expect(turn).toContain("[DM] 시스템: main 에 머지하는 중 충돌이 났습니다: a.txt.");
    expect(turn.endsWith("Reply in this DM.")).toBe(true);
    // 턴 종료 커밋이 머지 커밋을 완성한다
    expect(await hasMergeHead(jiyeon.worktreePath)).toBe(false);
    expect(await porcelain(jiyeon.worktreePath)).toBe("");
    expect(await readFile(join(jiyeon.worktreePath, "a.txt"), "utf8")).toBe("resolved\n");
    expect((await git(jiyeon.worktreePath, "log", "-1", "--format=%P")).trim().split(" ")).toHaveLength(2);
    expect((await git(jiyeon.worktreePath, "log", "-1", "--format=%s")).trim().startsWith("지연(개발자): merge main — ")).toBe(true);
    expect((await git(jiyeon.worktreePath, "log", "-1", "--format=%an <%ae>")).trim()).toBe("지연 (mam-team) <jiyeon@mam.local>");
    // 새 ready ChangeSet, 이전 conflict 는 stale
    const [stale, second] = teams.listChanges(team.id);
    expect(stale!.status).toBe("stale");
    expect(second).toMatchObject({ status: "ready", conflictFiles: [], files: [{ path: "a.txt", kind: "modify" }], commits: 2 });
    expect(second!.commit).toBe(await head(jiyeon.worktreePath));
    expect(cardStatuses(cg.events, first.messageId)).toEqual(["merging", "conflict", "stale"]);
    expect(cd.events.some((e) => e.type === "room.message" && e.message.kind === "text" && e.message.author.kind === "agent")).toBe(true);
    // 다시 머지하면 merged
    const merged = await teams.merge(team.id, second!.id);
    expect(merged.change.status).toBe("merged");
    expect(merged.mergeCommit).toMatch(SHA_RE);
    expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("resolved\n");
    expect(await porcelain(repo)).toBe("");
    expect(await head(jiyeon.worktreePath)).toBe(merged.mergeCommit);
    cg.unsubscribe();
    cd.unsubscribe();
  });

  it("dismiss also accepts a conflict ChangeSet", async () => {
    const { teams, repo, create } = await setup();
    const team = await create();
    const jiyeon = member(team, "지연");
    const first = await readyChange(teams, team, "@지연 clash");
    await writeFile(join(repo, "a.txt"), "from-main\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-q", "-m", "main side");
    let release!: () => void;
    hooks.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      expect((await teams.merge(team.id, first.id)).change.status).toBe("conflict");
      const dismissed = await teams.dismiss(team.id, first.id);
      // conflictFiles 는 conflict 일 때만 값이다(PROTOCOL 6.1)
      expect(dismissed).toMatchObject({ status: "dismissed", conflictFiles: [] });
      await expect(teams.dismiss(team.id, first.id)).rejects.toBeInstanceOf(ConflictError);
      expect(await head(repo, jiyeon.branch)).toBe(first.commit);
    } finally {
      release();
      hooks.gate = undefined;
    }
    await waitUntil(quiet(teams, team.id));
  });
});

describe("TeamManager restart (changes)", () => {
  it("reconciles merging leftovers, marks moved ready ChangeSets stale and caps terminal changes in detail at 20", async () => {
    const first = await setup();
    const team = await first.create();
    const group = groupRoom(team);
    const jiyeon = member(team, "지연");
    // c1: 지연 write → 실제 머지. c2: 팀장 write → ready. c3: 지연 write → ready 뒤 브랜치를 손으로 움직인다.
    const c1 = await readyChange(first.teams, team);
    expect((await first.teams.merge(team.id, c1.id)).change.status).toBe("merged");
    const c2 = await readyChange(first.teams, team, "write");
    expect(c2.memberId).toBe(member(team, "민수").id);
    const c3 = await readyChange(first.teams, team);
    expect(c3.memberId).toBe(jiyeon.id);
    await writeFile(join(jiyeon.worktreePath, "extra.txt"), "x\n");
    await git(jiyeon.worktreePath, "add", "-A");
    await git(jiyeon.worktreePath, "commit", "-q", "-m", "manual");
    await first.teams.shutdown();
    await first.manager.shutdown();

    const path = join(first.dataDir, "teams", team.id, "changes.json");
    const list = JSON.parse(await readFile(path, "utf8")) as ChangeSet[];
    expect(list.map((ch) => ch.status)).toEqual(["merged", "ready", "ready"]);
    list[0]!.status = "merging"; // 머지 커밋은 이미 베이스에 있다 → merged
    list[1]!.status = "merging"; // 머지되지 않았다 → ready
    for (let i = 0; i < 25; i += 1) list.push({ ...list[0]!, id: newId("chg"), status: "stale", messageId: newId("msg") });
    await writeFile(path, JSON.stringify(list), "utf8");
    await mkdir(join(first.home, "unused"), { recursive: true });

    const second = await setup({ home: first.home });
    const changes = second.teams.listChanges(team.id);
    expect(changes).toHaveLength(28);
    expect(changes.slice(0, 3).map((ch) => [ch.id, ch.status])).toEqual([
      [c1.id, "merged"],
      [c2.id, "ready"],
      [c3.id, "stale"],
    ]);
    // 카드도 갱신됐다
    const msgs = (await second.teams.roomDetail(team.id, group.id)).messages;
    expect(msgs.find((m) => m.id === c1.messageId)!.changes!.status).toBe("merged");
    expect(msgs.find((m) => m.id === c2.messageId)!.changes!.status).toBe("ready");
    expect(msgs.find((m) => m.id === c3.messageId)!.changes!.status).toBe("stale");
    // 파일에도 반영
    const saved = JSON.parse(await readFile(path, "utf8")) as ChangeSet[];
    expect(saved.slice(0, 3).map((ch) => ch.status)).toEqual(["merged", "ready", "stale"]);
    // detail 은 ready/conflict/merging 전부 + 종료 상태 최근 20개
    const detail = second.teams.detail(team.id).changes;
    expect(detail).toHaveLength(21);
    expect(detail.filter((ch) => ch.status === "ready").map((ch) => ch.id)).toEqual([c2.id]);
    expect(detail.map((ch) => ch.id)).toEqual(changes.filter((ch) => ch.id === c2.id || changes.indexOf(ch) >= 8).map((ch) => ch.id));
    // ready 로 돌아온 c2 는 머지할 수 있다
    expect((await second.teams.merge(team.id, c2.id)).change.status).toBe("merged");
    await second.teams.shutdown();
    await second.manager.shutdown();
  });
});
