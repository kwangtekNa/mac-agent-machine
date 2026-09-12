import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  Attachment,
  ChangeSet,
  CreateTeamRequest,
  DispatchState,
  MemberInput,
  PatchMemberRequest,
  PatchTeamRequest,
  Room,
  RoomDetailResponse,
  RoomMemberStatus,
  RoomMessage,
  RoomServerEvent,
  ServerEvent,
  Team,
  TeamMemberState,
  TeamSettings,
  TurnInput,
} from "@mam/protocol";
import { ConflictError, InvalidRequestError, NotFoundError, RoomNotFoundError, SessionBusyError } from "../errors.js";
import { resolveInsideHome } from "../fs/sandbox.js";
import {
  WorktreeError,
  addWorktree,
  branchExists,
  changedFileKinds,
  changesVsBase,
  commitAll,
  detectBaseBranch,
  hasMergeInProgress,
  removeWorktree,
  syncFromBase,
  worktreeIsDirty,
} from "../git/worktree.js";
import { newId } from "../ids.js";
import type { SessionManager } from "../sessions/manager.js";
import { DispatchQueue, hopExceeded, nextHop, route, type RunningItem } from "./dispatcher.js";
import { buildTurnText } from "./format.js";
import { parseMentions } from "./mentions.js";
import { buildInstructions, rolePreset } from "./roles.js";
import { RoomManager } from "./room-manager.js";
import { TeamStore, makeHandle, slug, toTeam } from "./store.js";
import { extractReply, summarizeWork } from "./summary.js";
import type { TeamMemberRecord, TeamRecord } from "./types.js";

/**
 * 팀·팀원 생명주기(worktree + 지연 시작 세션), 방 메시지 → 디스패치 → 세션 턴 → 답변 게시, 승인 미러링,
 * 턴 종료 자동 커밋과 "변경 준비됨" ChangeSet(PROTOCOL 6, ADR-017). 머지·dismiss·충돌 정리는 step 6, HTTP/WS 는 step 7.
 * 세션 구독은 턴 동안만 유지한다(구독자가 있으면 세션 유휴 종료가 막힌다). 방 seq 는 RoomManager, 세션 seq 는 SessionManager 만 발급한다.
 * 메시지 본문·프롬프트는 로그에 남기지 않는다(CRITICAL 6). 모든 경로는 `resolveInsideHome` 을 거치고 git 은 `worktree.ts` 헬퍼만 쓴다.
 */

export interface TeamManagerOptions {
  dataDir: string;
  home: string;
  manager: SessionManager;
  now?: () => Date;
  logger?: Pick<Console, "info" | "warn" | "error">;
  defaults?: Partial<TeamSettings>;
  /** 세션이 바빠 턴을 못 보낸 항목을 다시 시도하기까지의 대기(ms). 기본 2초. */
  busyRetryMs?: number;
}

export interface TeamDetail {
  team: Team;
  dispatch: DispatchState;
  changes: ChangeSet[];
}

const DEFAULT_SETTINGS: TeamSettings = { maxHops: 6, maxConcurrent: 2, contextMaxMessages: 40 };
const CONTEXT_MAX_CHARS = 12_000;
const GROUP_ROOM_NAME = "전체";
const DEFAULT_MODE = "auto-edit" as const;
const COMMIT_SUBJECT_MAX = 72;
const DETAIL_LIMIT = 100_000;
const STOP_WAIT_MS = 5_000;
const DEFAULT_BUSY_RETRY_MS = 2_000;
const RATE_LIMIT_RE = /rate limit|usage limit|too many requests|429/i;
const RESTART_NOTICE = "서버가 다시 시작되어 진행 중이던 작업은 취소됐습니다";
const RATE_LIMIT_NOTICE = "구독 사용 한도에 걸려 팀 작업을 멈췄습니다. 한도가 풀리면 메시지를 보내 다시 시작하세요";
const BUSY_STATES: ReadonlySet<TeamMemberState> = new Set(["queued", "running", "waiting_approval"]);

type Outcome =
  | { kind: "completed" | "ended" | "interrupted"; turnId: string | null }
  | { kind: "error"; turnId: string | null; message: string };

interface ActiveRun {
  item: RunningItem;
  interrupted: boolean;
  done: Promise<void>;
  unsubscribe?: () => void;
}

interface TeamRuntime {
  record: TeamRecord;
  rooms: RoomManager;
  queue: DispatchQueue;
  changes: ChangeSet[];
  paused: boolean;
  active: Map<string, ActiveRun>;
  attachments: Map<string, Attachment[]>;
  pumping: boolean;
  pumpAgain: boolean;
  persistDirty: boolean;
  persistChain: Promise<void>;
  changesChain: Promise<void>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 이름 비교 키: NFKC, 공백 제거, 소문자(PROTOCOL 6.1). */
function nameKey(name: string): string {
  return name.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

function firstLine(text: string): string {
  return text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
}

function withTimeout(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    p.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

export class TeamManager {
  private readonly runtimes = new Map<string, TeamRuntime>();
  private readonly store: TeamStore;
  private readonly home: string;
  private readonly manager: SessionManager;
  private readonly now: () => Date;
  private readonly logger: Pick<Console, "info" | "warn" | "error">;
  private readonly defaults: TeamSettings;
  private readonly busyRetryMs: number;
  /** `shutdown()` 뒤 true. 늦게 끝나는 턴의 상태·저장·펌프를 막는다(재시작이 상태를 다시 세운다). */
  private closed = false;

  private constructor(opts: TeamManagerOptions) {
    this.store = new TeamStore(opts.dataDir, opts.logger ?? console);
    this.home = opts.home;
    this.manager = opts.manager;
    this.now = opts.now ?? (() => new Date());
    this.logger = opts.logger ?? console;
    this.defaults = { ...DEFAULT_SETTINGS, ...opts.defaults };
    this.busyRetryMs = opts.busyRetryMs ?? DEFAULT_BUSY_RETRY_MS;
  }

  /** 모든 팀을 로드하고 방을 연다. 재시작 전 running/queued/waiting_approval 흔적은 idle 로 내리고 그룹방에 알린다. */
  static async open(opts: TeamManagerOptions): Promise<TeamManager> {
    const tm = new TeamManager(opts);
    for (const record of await tm.store.list()) {
      let interrupted = false;
      for (const m of record.members) {
        if (BUSY_STATES.has(m.state)) {
          m.state = "idle";
          interrupted = true;
        }
      }
      const rt = await tm.register(record);
      if (interrupted) {
        try {
          await rt.rooms.post(tm.groupRoom(rt).id, { author: { kind: "system" }, kind: "system", text: RESTART_NOTICE });
        } catch (err) {
          tm.logger.warn(`[teams] 재시작 안내 게시 실패 team=${record.id}: ${errorMessage(err)}`);
        }
        await tm.persist(rt);
      }
    }
    return tm;
  }

  // ---- 조회 -----------------------------------------------------------------

  listTeams(cwd?: string): Team[] {
    return [...this.runtimes.values()]
      .filter((rt) => cwd === undefined || rt.record.cwd === cwd)
      .map((rt) => toTeam(rt.record))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  getTeam(teamId: string): Team {
    return toTeam(this.require(teamId).record);
  }

  detail(teamId: string): TeamDetail {
    const rt = this.require(teamId);
    return { team: toTeam(rt.record), dispatch: rt.queue.state(), changes: rt.changes.map((c) => ({ ...c, files: c.files.map((f) => ({ ...f })), conflictFiles: [...c.conflictFiles] })) };
  }

  listChanges(teamId: string): ChangeSet[] {
    return this.detail(teamId).changes;
  }

  async roomDetail(teamId: string, roomId: string, limit?: number): Promise<RoomDetailResponse> {
    return this.require(teamId).rooms.detail(roomId, limit);
  }

  async subscribeRoom(teamId: string, roomId: string, since: number, listener: (event: RoomServerEvent) => void): Promise<() => void> {
    return this.require(teamId).rooms.subscribe(roomId, since, listener);
  }

  // ---- 팀 생명주기 -------------------------------------------------------------

  async createTeam(input: CreateTeamRequest): Promise<Team> {
    if (input.members.length === 0) throw new InvalidRequestError("팀원이 최소 한 명 필요합니다");
    const cwd = await resolveInsideHome(this.home, input.cwd);
    const baseBranch = await this.baseBranchOf(cwd);
    let settings: TeamSettings = { ...this.defaults };
    if (input.templateId !== undefined) {
      const template = (await this.store.listTemplates()).find((t) => t.id === input.templateId);
      if (!template) throw new NotFoundError(`템플릿을 찾을 수 없습니다: ${input.templateId}`);
      settings = { ...settings, ...template.settings };
    }
    settings = { ...settings, ...input.settings };

    const at = this.iso();
    const teamId = newId("team");
    const inputs = input.members.map((m) => ({ ...m }));
    if (inputs.length === 1 && inputs[0]!.isLead === undefined) inputs[0]!.isLead = true;
    const leads = inputs.filter((m) => m.isLead === true).length;
    if (leads !== 1) throw new InvalidRequestError(`팀장은 정확히 1명이어야 합니다 (현재 ${leads}명)`);

    const record: TeamRecord = {
      id: teamId,
      name: input.name,
      cwd,
      baseBranch,
      settings,
      members: [],
      rooms: [{ id: newId("room"), teamId, kind: "group", memberId: null, name: GROUP_ROOM_NAME, lastSeq: 0, lastMessageAt: null }],
      createdAt: at,
      updatedAt: at,
    };
    for (const m of inputs) {
      const member = await this.prepareMember(record, m);
      record.members.push(member);
      record.rooms.push(this.dmRoomFor(record, member));
    }

    await this.store.save(record);
    const created: TeamMemberRecord[] = [];
    try {
      for (const member of record.members) {
        await this.provisionMember(record, member);
        created.push(member);
      }
    } catch (err) {
      await this.rollbackMembers(record, created);
      await this.store.remove(teamId);
      await rm(join(this.store.teamDir(teamId), "worktrees"), { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
    const rt = await this.register(record);
    await this.persist(rt);
    return toTeam(rt.record);
  }

  async patchTeam(teamId: string, patch: PatchTeamRequest): Promise<Team> {
    const rt = this.require(teamId);
    if (patch.name !== undefined) rt.record.name = patch.name;
    if (patch.settings !== undefined) {
      rt.record.settings = { ...rt.record.settings, ...patch.settings };
      rt.queue.setMaxConcurrent(rt.record.settings.maxConcurrent);
    }
    this.touch(rt);
    await this.persist(rt);
    this.pump(rt);
    return toTeam(rt.record);
  }

  /** 더러운 worktree 가 있으면(keepWorktrees 없을 때) 아무것도 지우지 않고 409. */
  async deleteTeam(teamId: string, opts: { keepWorktrees?: boolean } = {}): Promise<void> {
    const rt = this.require(teamId);
    if (!opts.keepWorktrees) await this.assertClean(rt.record.members);
    await this.stop(teamId);
    for (const m of rt.record.members) await this.closeSession(m);
    if (!opts.keepWorktrees) {
      for (const m of rt.record.members) await this.dropWorktree(rt.record, m);
      await rm(join(this.store.teamDir(teamId), "worktrees"), { recursive: true, force: true }).catch(() => undefined);
    }
    await rt.persistChain;
    await rt.changesChain;
    await rt.rooms.flush();
    this.runtimes.delete(teamId);
    await this.store.remove(teamId);
  }

  // ---- 팀원 -------------------------------------------------------------------

  async addMember(teamId: string, input: MemberInput): Promise<Team> {
    const rt = this.require(teamId);
    if (input.isLead) throw new InvalidRequestError("팀장은 이미 있습니다");
    const member = await this.prepareMember(rt.record, { ...input, isLead: false });
    const room = this.dmRoomFor(rt.record, member);
    try {
      await this.provisionMember(rt.record, member);
    } catch (err) {
      await this.rollbackMembers(rt.record, [member]);
      throw err;
    }
    rt.record.members.push(member);
    rt.record.rooms.push(room);
    await rt.rooms.addRoom(room);
    this.refreshInstructions(rt);
    this.touch(rt);
    await this.persist(rt);
    return toTeam(rt.record);
  }

  async patchMember(teamId: string, memberId: string, patch: PatchMemberRequest): Promise<Team> {
    const rt = this.require(teamId);
    const member = this.requireMember(rt, memberId);
    if (patch.name !== undefined && nameKey(patch.name) !== nameKey(member.name)) {
      if (rt.record.members.some((m) => m.id !== memberId && nameKey(m.name) === nameKey(patch.name!))) {
        throw new ConflictError(`같은 이름의 팀원이 있습니다: ${patch.name}`);
      }
    }
    if (patch.name !== undefined) member.name = patch.name;
    if (patch.emoji !== undefined) member.emoji = patch.emoji;
    if (patch.prompt !== undefined) member.prompt = patch.prompt;
    if (patch.mode !== undefined || patch.model !== undefined || patch.effort !== undefined) {
      const sessionId = await this.ensureSession(rt, member);
      const session = await this.manager.patch(sessionId, {
        ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
        ...(patch.model !== undefined ? { model: patch.model } : {}),
        ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
      });
      member.mode = session.mode;
      member.model = session.model;
      member.effort = session.effort ?? null;
    }
    member.updatedAt = this.iso();
    // 이름·프롬프트는 모든 팀원의 지시문(동료 목록)에 영향을 준다. 다음 세션부터 적용된다.
    this.refreshInstructions(rt);
    this.touch(rt);
    await this.persist(rt);
    return toTeam(rt.record);
  }

  /** 팀장은 제거할 수 없다(400). DM 방은 memberId 를 유지한 채 남긴다. */
  async removeMember(teamId: string, memberId: string, opts: { keepWorktree?: boolean } = {}): Promise<Team> {
    const rt = this.require(teamId);
    const member = this.requireMember(rt, memberId);
    if (member.isLead) throw new InvalidRequestError("팀장은 제거할 수 없습니다");
    if (!opts.keepWorktree) await this.assertClean([member]);
    await this.interrupt(teamId, memberId);
    rt.queue.removeQueued(memberId);
    await this.closeSession(member);
    if (!opts.keepWorktree) await this.dropWorktree(rt.record, member);
    rt.record.members = rt.record.members.filter((m) => m.id !== memberId);
    this.refreshInstructions(rt);
    this.touch(rt);
    await this.persist(rt);
    await this.emitStatus(rt, [this.groupRoom(rt).id]);
    return toTeam(rt.record);
  }

  /** 세션을 닫고 같은 worktree 로 새 지연 세션을 만든다. lastSeen 은 유지한다. */
  async resetMember(teamId: string, memberId: string): Promise<Team> {
    const rt = this.require(teamId);
    const member = this.requireMember(rt, memberId);
    await this.interrupt(teamId, memberId);
    await this.closeSession(member);
    member.sessionId = null;
    member.state = "idle";
    await this.ensureSession(rt, member);
    this.touch(rt);
    await this.persist(rt);
    await this.emitStatus(rt, this.statusRooms(rt, memberId));
    return toTeam(rt.record);
  }

  // ---- 메시지·디스패치 ----------------------------------------------------------

  async postUserMessage(teamId: string, roomId: string, input: { text: string; attachments?: Attachment[] }): Promise<{ message: RoomMessage; dispatches: string[] }> {
    const rt = this.require(teamId);
    const room = rt.record.rooms.find((r) => r.id === roomId);
    if (!room) throw new RoomNotFoundError(roomId);
    rt.paused = false;
    const mentions = parseMentions(input.text, rt.record.members);
    const message = await rt.rooms.post(roomId, {
      author: { kind: "user" },
      kind: "text",
      text: input.text,
      mentions: room.kind === "group" ? mentions.memberIds : [],
      hop: 0,
      dispatchId: null,
    });
    if (room.kind === "group" && mentions.unknown.length > 0) {
      await rt.rooms.error(roomId, `멘션한 팀원을 찾을 수 없습니다: ${mentions.unknown.map((u) => `@${u}`).join(", ")}`, true);
    }
    const targets = route({ team: rt.record, room, author: { kind: "user" }, mentions });
    const dispatches: string[] = [];
    for (const target of targets) {
      const { item } = rt.queue.enqueue({ rootId: message.id, memberId: target.memberId, roomId, sourceMessageId: message.id, hop: nextHop(message.hop) });
      dispatches.push(item.dispatchId);
      if (input.attachments && input.attachments.length > 0) rt.attachments.set(item.dispatchId, input.attachments);
      this.markQueued(rt, target.memberId);
    }
    if (targets.length === 0 && room.kind === "group") await rt.rooms.error(roomId, "메시지를 받을 팀원이 없습니다", true);
    await this.emitStatus(rt, [roomId]);
    await this.persist(rt);
    this.pump(rt);
    return { message, dispatches };
  }

  /** 실행 중 턴 전부 interrupt, 대기열 비움. 끝날 때까지(최대 5초) 기다린다. */
  async stop(teamId: string): Promise<DispatchState> {
    const rt = this.require(teamId);
    const cleared = rt.queue.clear();
    for (const item of cleared) {
      const m = rt.record.members.find((x) => x.id === item.memberId);
      if (m && m.state === "queued") m.state = "idle";
      rt.attachments.delete(item.dispatchId);
      await this.postSystem(rt, item.roomId, `${m?.name ?? item.memberId}의 대기 중 작업을 취소했습니다`);
    }
    const runs = [...rt.active.values()];
    for (const run of runs) {
      run.interrupted = true;
      await this.manager.interrupt(run.item.sessionId).catch((err) => {
        this.logger.warn(`[teams] interrupt 실패 team=${teamId} dispatch=${run.item.dispatchId}: ${errorMessage(err)}`);
      });
    }
    await withTimeout(Promise.all(runs.map((r) => r.done)), STOP_WAIT_MS);
    if (cleared.length > 0) {
      this.touch(rt);
      await this.persist(rt);
      await this.emitStatus(rt, [...new Set(cleared.map((c) => c.roomId))]);
    }
    return rt.queue.state();
  }

  /** memberId 가 있으면 그 팀원의 실행 중 턴만, 없으면 팀 전체(`stop`). */
  async interrupt(teamId: string, memberId?: string): Promise<void> {
    if (memberId === undefined) {
      await this.stop(teamId);
      return;
    }
    const rt = this.require(teamId);
    const run = [...rt.active.values()].find((r) => r.item.memberId === memberId);
    if (!run) return;
    run.interrupted = true;
    await this.manager.interrupt(run.item.sessionId).catch((err) => {
      this.logger.warn(`[teams] interrupt 실패 team=${teamId} dispatch=${run.item.dispatchId}: ${errorMessage(err)}`);
    });
    await withTimeout(run.done, STOP_WAIT_MS);
  }

  /** 실행 중 턴은 건드리지 않고 구독만 해제한다. 파일을 flush 한 뒤에는 더 저장하지 않는다(멱등). */
  async shutdown(): Promise<void> {
    // 먼저 닫아 새 저장·상태 발행·펌프를 막고, 이미 예약된 저장만 기다린다.
    this.closed = true;
    for (const rt of this.runtimes.values()) {
      for (const run of rt.active.values()) {
        run.unsubscribe?.();
        run.unsubscribe = undefined;
      }
      await rt.persistChain;
      await rt.changesChain;
      await rt.rooms.flush();
    }
  }

  // ---- internals: 등록·조회 ------------------------------------------------------

  private async register(record: TeamRecord): Promise<TeamRuntime> {
    const rooms = await RoomManager.open({ teamDir: this.store.teamDir(record.id), team: record, now: this.now, logger: this.logger });
    // RoomManager 가 로그에서 복원한 lastSeq/lastMessageAt 를 레코드에 반영한다.
    for (const room of record.rooms) {
      const { room: current } = await rooms.detail(room.id, 0);
      room.lastSeq = current.lastSeq;
      room.lastMessageAt = current.lastMessageAt;
    }
    const rt: TeamRuntime = {
      record,
      rooms,
      queue: new DispatchQueue({ maxConcurrent: record.settings.maxConcurrent, now: this.now, newId: (p) => newId(p) }),
      changes: await this.store.loadChanges(record.id),
      paused: false,
      active: new Map(),
      attachments: new Map(),
      pumping: false,
      pumpAgain: false,
      persistDirty: false,
      persistChain: Promise.resolve(),
      changesChain: Promise.resolve(),
    };
    rooms.onRoomChanged = (room: Room) => {
      const target = rt.record.rooms.find((r) => r.id === room.id);
      if (!target) return;
      target.lastSeq = room.lastSeq;
      target.lastMessageAt = room.lastMessageAt;
      void this.persist(rt);
    };
    this.runtimes.set(record.id, rt);
    return rt;
  }

  private require(teamId: string): TeamRuntime {
    const rt = this.runtimes.get(teamId);
    if (!rt) throw new NotFoundError(`팀을 찾을 수 없습니다: ${teamId}`);
    return rt;
  }

  private requireMember(rt: TeamRuntime, memberId: string): TeamMemberRecord {
    const member = rt.record.members.find((m) => m.id === memberId);
    if (!member) throw new NotFoundError(`팀원을 찾을 수 없습니다: ${memberId}`);
    return member;
  }

  private groupRoom(rt: TeamRuntime): Room {
    return rt.record.rooms.find((r) => r.kind === "group") ?? rt.record.rooms[0]!;
  }

  private dmRoom(rt: TeamRuntime, memberId: string): Room | undefined {
    return rt.record.rooms.find((r) => r.kind === "dm" && r.memberId === memberId);
  }

  /** 팀원 상태를 보여줄 방: 그룹방 + 그 팀원의 DM 방. */
  private statusRooms(rt: TeamRuntime, memberId: string): string[] {
    const ids = [this.groupRoom(rt).id];
    const dm = this.dmRoom(rt, memberId);
    if (dm) ids.push(dm.id);
    return ids;
  }

  private iso(): string {
    return this.now().toISOString();
  }

  private touch(rt: TeamRuntime): void {
    rt.record.updatedAt = this.iso();
  }

  /** `team.json` 저장(tmp+rename). 연속 호출은 한 번으로 모은다. */
  private persist(rt: TeamRuntime): Promise<void> {
    if (this.closed) return rt.persistChain;
    if (!rt.persistDirty) {
      rt.persistDirty = true;
      rt.persistChain = rt.persistChain.then(async () => {
        rt.persistDirty = false;
        if (!this.runtimes.has(rt.record.id)) return;
        try {
          await this.store.save(rt.record);
        } catch (err) {
          this.logger.warn(`[teams] 팀 레코드 저장 실패 team=${rt.record.id}: ${errorMessage(err)}`);
        }
      });
    }
    return rt.persistChain;
  }

  private persistChanges(rt: TeamRuntime): Promise<void> {
    if (this.closed) return rt.changesChain;
    const snapshot = rt.changes.map((c) => ({ ...c }));
    rt.changesChain = rt.changesChain.then(async () => {
      try {
        await this.store.saveChanges(rt.record.id, snapshot);
      } catch (err) {
        this.logger.warn(`[teams] changes.json 저장 실패 team=${rt.record.id}: ${errorMessage(err)}`);
      }
    });
    return rt.changesChain;
  }

  // ---- internals: 팀원 준비 -------------------------------------------------------

  private async baseBranchOf(cwd: string): Promise<string> {
    try {
      return await detectBaseBranch(cwd);
    } catch (err) {
      if (err instanceof WorktreeError) {
        if (err.code === "not_repo") throw new InvalidRequestError("cwd 가 git 저장소가 아닙니다");
        if (err.code === "detached") throw new InvalidRequestError("cwd 의 HEAD 가 브랜치를 가리키지 않습니다(detached)");
      }
      throw err;
    }
  }

  private teamSlug(record: TeamRecord): string {
    const s = slug(record.name);
    return s === "team" && !/[a-z0-9]/i.test(record.name.normalize("NFKD")) ? `team-${record.id.slice(-8).toLowerCase()}` : s;
  }

  /** 입력을 검증하고 ID·핸들·브랜치·worktree 경로를 정한 레코드를 만든다(파일·git·세션은 건드리지 않는다). */
  private async prepareMember(record: TeamRecord, input: MemberInput): Promise<TeamMemberRecord> {
    const preset = rolePreset(input.role);
    const roleLabel = input.roleLabel ?? (input.role === "custom" ? undefined : preset.label);
    if (roleLabel === undefined || roleLabel === "") throw new InvalidRequestError("custom 역할은 roleLabel 이 필요합니다");
    if (record.members.some((m) => nameKey(m.name) === nameKey(input.name))) throw new ConflictError(`같은 이름의 팀원이 있습니다: ${input.name}`);
    const taken = new Set(record.members.map((m) => m.handle));
    const handle = input.handle ?? makeHandle(input.name, taken, record.members.length + 1);
    if (taken.has(handle)) throw new ConflictError(`같은 핸들의 팀원이 있습니다: ${handle}`);

    const base = `mam/${this.teamSlug(record)}/${handle}`;
    let branch = base;
    for (let n = 2; await branchExists(record.cwd, branch); n += 1) branch = `${base}-${n}`;

    const id = newId("agt");
    const worktreesDir = join(this.store.teamDir(record.id), "worktrees");
    await mkdir(worktreesDir, { recursive: true, mode: 0o700 });
    const worktreePath = await resolveInsideHome(this.home, join(worktreesDir, id));
    const at = this.iso();
    return {
      id,
      name: input.name,
      handle,
      role: input.role,
      roleLabel,
      emoji: input.emoji ?? preset.emoji,
      agent: input.agent,
      prompt: input.prompt ?? preset.prompt,
      mode: input.mode ?? DEFAULT_MODE,
      model: input.model ?? null,
      effort: input.effort ?? null,
      sessionId: null,
      branch,
      worktreePath,
      isLead: input.isLead === true,
      state: "idle",
      createdAt: at,
      updatedAt: at,
      lastSeen: {},
    };
  }

  private dmRoomFor(record: TeamRecord, member: TeamMemberRecord): Room {
    return { id: newId("room"), teamId: record.id, kind: "dm", memberId: member.id, name: member.name, lastSeq: 0, lastMessageAt: null };
  }

  /** 브랜치·worktree 를 만들고 지연 시작 세션을 등록한다. 어댑터 프로세스는 띄우지 않는다. */
  private async provisionMember(record: TeamRecord, member: TeamMemberRecord): Promise<void> {
    await addWorktree({ repo: record.cwd, path: member.worktreePath, branch: member.branch, base: record.baseBranch });
    member.sessionId = await this.createSession(record, member);
  }

  private async createSession(record: TeamRecord, member: TeamMemberRecord): Promise<string> {
    const session = await this.manager.create({
      agent: member.agent,
      cwd: member.worktreePath,
      title: member.name,
      mode: member.mode,
      ...(member.model !== null ? { model: member.model } : {}),
      ...(member.effort !== null ? { effort: member.effort } : {}),
      instructions: this.instructionsFor(record, member),
      team: { teamId: record.id, memberId: member.id },
      deferStart: true,
    });
    return session.id;
  }

  private instructionsFor(record: TeamRecord, member: TeamMemberRecord): string {
    return buildInstructions({
      member: { name: member.name, handle: member.handle, roleLabel: member.roleLabel, prompt: member.prompt, branch: member.branch, worktreePath: member.worktreePath, role: member.role },
      team: { name: record.name, cwd: record.cwd },
      teammates: record.members.map((m) => ({ name: m.name, handle: m.handle, roleLabel: m.roleLabel, isLead: m.isLead })),
    });
  }

  /** 모든 팀원 세션의 지시문을 다시 계산해 레코드에 반영한다(다음 세션부터 적용). */
  private refreshInstructions(rt: TeamRuntime): void {
    for (const m of rt.record.members) {
      if (!m.sessionId || !this.manager.get(m.sessionId)) continue;
      try {
        this.manager.setInstructions(m.sessionId, this.instructionsFor(rt.record, m));
      } catch (err) {
        this.logger.warn(`[teams] 지시문 갱신 실패 team=${rt.record.id} member=${m.id}: ${errorMessage(err)}`);
      }
    }
  }

  /** 팀원 세션이 없거나 닫혔으면 새 지연 세션을 만든다. */
  private async ensureSession(rt: TeamRuntime, member: TeamMemberRecord): Promise<string> {
    if (member.sessionId) {
      const session = this.manager.get(member.sessionId);
      if (session && session.status !== "closed") return member.sessionId;
    }
    member.sessionId = await this.createSession(rt.record, member);
    member.updatedAt = this.iso();
    void this.persist(rt);
    return member.sessionId;
  }

  private async closeSession(member: TeamMemberRecord): Promise<void> {
    if (!member.sessionId || !this.manager.get(member.sessionId)) return;
    try {
      await this.manager.close(member.sessionId);
    } catch (err) {
      this.logger.warn(`[teams] 세션 종료 실패 session=${member.sessionId}: ${errorMessage(err)}`);
    }
  }

  private async assertClean(members: TeamMemberRecord[]): Promise<void> {
    for (const m of members) {
      let dirty = false;
      try {
        dirty = await worktreeIsDirty(m.worktreePath);
      } catch {
        dirty = false; // worktree 가 이미 없으면 지울 것도 없다
      }
      if (dirty) throw new ConflictError(`${m.name}의 worktree 에 커밋되지 않은 변경이 있습니다`);
    }
  }

  private async dropWorktree(record: TeamRecord, member: TeamMemberRecord): Promise<void> {
    try {
      await removeWorktree(record.cwd, member.worktreePath);
    } catch (err) {
      if (err instanceof WorktreeError && err.code === "dirty") throw new ConflictError(`${member.name}의 worktree 에 커밋되지 않은 변경이 있습니다`);
      if (err instanceof WorktreeError && err.code === "not_repo") return;
      this.logger.warn(`[teams] worktree 제거 실패 team=${record.id} member=${member.id}: ${errorMessage(err)}`);
    }
  }

  private async rollbackMembers(record: TeamRecord, members: TeamMemberRecord[]): Promise<void> {
    for (const m of members) {
      await this.closeSession(m);
      await this.dropWorktree(record, m).catch(() => undefined);
    }
  }

  // ---- internals: 상태·방 이벤트 ---------------------------------------------------

  private markQueued(rt: TeamRuntime, memberId: string): void {
    const m = rt.record.members.find((x) => x.id === memberId);
    if (m && (m.state === "idle" || m.state === "error")) {
      m.state = "queued";
      m.updatedAt = this.iso();
    }
  }

  private setState(rt: TeamRuntime, memberId: string, state: TeamMemberState): void {
    const m = rt.record.members.find((x) => x.id === memberId);
    if (!m || m.state === state) return;
    m.state = state;
    m.updatedAt = this.iso();
  }

  private memberStatuses(rt: TeamRuntime): RoomMemberStatus[] {
    return rt.record.members.map((m) => ({ memberId: m.id, state: m.state, sessionId: m.sessionId }));
  }

  private async emitStatus(rt: TeamRuntime, roomIds: string[]): Promise<void> {
    if (this.closed) return;
    for (const roomId of new Set(roomIds)) {
      try {
        await rt.rooms.status(roomId, rt.queue.state(), this.memberStatuses(rt));
      } catch (err) {
        this.logger.warn(`[teams] room.status 발행 실패 team=${rt.record.id} room=${roomId}: ${errorMessage(err)}`);
      }
    }
  }

  private async postSystem(rt: TeamRuntime, roomId: string, text: string): Promise<void> {
    try {
      await rt.rooms.post(roomId, { author: { kind: "system" }, kind: "system", text });
    } catch (err) {
      this.logger.warn(`[teams] 시스템 메시지 게시 실패 team=${rt.record.id} room=${roomId}: ${errorMessage(err)}`);
    }
  }

  // ---- internals: 큐 펌프·디스패치 실행 -----------------------------------------------

  /** 실행 가능한 항목을 running 으로 옮겨 실행한다. 재진입은 한 번 더 돌게 표시한다. */
  private pump(rt: TeamRuntime): void {
    if (this.closed) return;
    if (rt.pumping) {
      rt.pumpAgain = true;
      return;
    }
    rt.pumping = true;
    void (async () => {
      try {
        do {
          rt.pumpAgain = false;
          if (rt.paused) break;
          for (;;) {
            const item = rt.queue.next();
            if (!item) break;
            const member = rt.record.members.find((m) => m.id === item.memberId);
            if (!member) {
              rt.queue.removeQueued(item.memberId);
              continue;
            }
            let sessionId: string;
            try {
              sessionId = await this.ensureSession(rt, member);
            } catch (err) {
              rt.queue.removeQueued(member.id);
              this.setState(rt, member.id, "error");
              await this.postSystem(rt, item.roomId, `${member.name}의 세션을 준비하지 못했습니다: ${errorMessage(err)}`);
              await this.emitStatus(rt, this.statusRooms(rt, member.id));
              continue;
            }
            let running: RunningItem;
            try {
              running = rt.queue.markRunning(item.dispatchId, sessionId);
            } catch {
              continue; // 기다리는 사이 stop/제거로 사라진 항목
            }
            const run: ActiveRun = { item: running, interrupted: false, done: Promise.resolve() };
            rt.active.set(running.dispatchId, run);
            run.done = this.runDispatch(rt, run).catch((err) => {
              this.logger.warn(`[teams] 디스패치 실행 오류 team=${rt.record.id} dispatch=${running.dispatchId}: ${errorMessage(err)}`);
            });
          }
        } while (rt.pumpAgain);
      } finally {
        rt.pumping = false;
      }
    })();
  }

  private async runDispatch(rt: TeamRuntime, run: ActiveRun): Promise<void> {
    const item = run.item;
    const member = rt.record.members.find((m) => m.id === item.memberId)!;
    const sessionId = item.sessionId;
    let outcome: Outcome | null = null;
    try {
      this.setState(rt, member.id, "running");
      await this.persist(rt);
      await this.emitStatus(rt, this.statusRooms(rt, member.id));

      const conflictNote = await this.syncWorktree(rt, member);
      const { input, seen, trigger } = await this.buildInput(rt, member, item, conflictNote);
      if (!trigger) {
        outcome = { kind: "error", turnId: null, message: "디스패치 원인 메시지를 찾을 수 없습니다" };
      } else {
        const started = await this.executeTurn(rt, run, member, input);
        if (started === "busy") {
          rt.active.delete(item.dispatchId);
          rt.queue.requeue(item.dispatchId);
          this.setState(rt, member.id, "queued");
          await this.persist(rt);
          await this.emitStatus(rt, this.statusRooms(rt, member.id));
          const timer = setTimeout(() => this.pump(rt), this.busyRetryMs);
          timer.unref?.();
          return;
        }
        outcome = started;
        // 시작도 못 하고 중단된 턴은 메시지를 보지 못했으니 lastSeen 을 올리지 않는다.
        if (!(outcome.kind === "interrupted" && outcome.turnId === null)) {
          for (const [roomId, seq] of seen) member.lastSeen[roomId] = Math.max(member.lastSeen[roomId] ?? 0, seq);
        }
      }
      await this.finishTurn(rt, run, member, outcome, trigger ?? null);
    } catch (err) {
      this.logger.warn(`[teams] 디스패치 처리 실패 team=${rt.record.id} dispatch=${item.dispatchId}: ${errorMessage(err)}`);
      this.setState(rt, member.id, "error");
      await this.postSystem(rt, item.roomId, `${member.name}의 작업 처리 중 오류가 났습니다: ${errorMessage(err)}`);
    } finally {
      run.unsubscribe?.();
      run.unsubscribe = undefined;
      if (rt.active.get(item.dispatchId) === run) {
        rt.active.delete(item.dispatchId);
        rt.queue.markDone(item.dispatchId);
        rt.attachments.delete(item.dispatchId);
        if (member.state === "running" || member.state === "waiting_approval") this.setState(rt, member.id, "idle");
        this.touch(rt);
        await this.persist(rt);
        await this.emitStatus(rt, this.statusRooms(rt, member.id));
        this.pump(rt);
      }
    }
  }

  /** 깨끗하고 머지 중이 아닐 때만 베이스를 머지한다. 충돌이면 안내문을 돌려준다(세부 흐름은 step 6). */
  private async syncWorktree(rt: TeamRuntime, member: TeamMemberRecord): Promise<string | undefined> {
    try {
      if (await worktreeIsDirty(member.worktreePath)) return undefined;
      if (await hasMergeInProgress(member.worktreePath)) return undefined;
      const result = await syncFromBase(member.worktreePath, rt.record.baseBranch);
      if (result.status === "conflict") {
        const files = (result.conflictFiles ?? []).join(", ");
        return `[#전체] 시스템: 베이스 브랜치(${rt.record.baseBranch})를 worktree 에 머지하다 충돌이 났습니다${files ? `: ${files}` : ""}. 충돌을 정리한 뒤 작업하세요.`;
      }
    } catch (err) {
      this.logger.warn(`[teams] worktree 동기화 실패 team=${rt.record.id} member=${member.id}: ${errorMessage(err)}`);
    }
    return undefined;
  }

  /** 그룹방 + 자기 DM 방의 `lastSeen` 이후 메시지를 createdAt 순으로 모아 턴 텍스트를 만든다. */
  private async buildInput(
    rt: TeamRuntime,
    member: TeamMemberRecord,
    item: RunningItem,
    conflictNote: string | undefined,
  ): Promise<{ input: TurnInput; seen: Map<string, number>; trigger: RoomMessage | undefined }> {
    const roomIds = this.statusRooms(rt, member.id);
    const context: RoomMessage[] = [];
    const seen = new Map<string, number>();
    for (const roomId of roomIds) {
      const messages = await rt.rooms.messagesSince(roomId, member.lastSeen[roomId] ?? 0);
      for (const m of messages) seen.set(roomId, Math.max(seen.get(roomId) ?? 0, m.seq));
      context.push(...messages);
    }
    context.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.seq - b.seq));
    let trigger = context.find((m) => m.id === item.sourceMessageId);
    if (!trigger) trigger = (await rt.rooms.messagesSince(item.roomId, 0)).find((m) => m.id === item.sourceMessageId);
    if (!trigger) return { input: { text: "" }, seen, trigger: undefined };
    seen.set(trigger.roomId, Math.max(seen.get(trigger.roomId) ?? 0, trigger.seq));
    const { text } = buildTurnText({
      member,
      members: rt.record.members,
      rooms: rt.record.rooms,
      context,
      trigger,
      maxMessages: rt.record.settings.contextMaxMessages,
      maxChars: CONTEXT_MAX_CHARS,
      ...(conflictNote !== undefined ? { conflictNote } : {}),
    });
    const attachments = rt.attachments.get(item.dispatchId);
    return { input: { text, ...(attachments ? { attachments } : {}) }, seen, trigger };
  }

  /** 턴 동안만 세션을 구독하고 승인을 방에 미러링한다. 세션이 바쁘면 "busy". */
  private async executeTurn(rt: TeamRuntime, run: ActiveRun, member: TeamMemberRecord, input: TurnInput): Promise<Outcome | "busy"> {
    const item = run.item;
    const sessionId = item.sessionId;
    const session = this.manager.get(sessionId);
    if (!session) return { kind: "error", turnId: null, message: "세션이 없습니다" };
    let turnId: string | null = null;
    let started = false;
    let finished = false;
    let finish!: (o: Outcome) => void;
    const outcome = new Promise<Outcome>((resolve) => {
      finish = (o) => {
        if (finished) return;
        finished = true;
        resolve(o);
      };
    });
    const approvalMessages = new Map<string, string>();
    let side = Promise.resolve();
    const queueSide = (fn: () => Promise<void>): void => {
      side = side.then(fn).catch((err) => {
        this.logger.warn(`[teams] 승인 미러링 실패 team=${rt.record.id} dispatch=${item.dispatchId}: ${errorMessage(err)}`);
      });
    };
    const noteTurn = (id: string | null): void => {
      if (turnId !== null || id === null) return;
      turnId = id;
      try {
        rt.queue.setTurn(item.dispatchId, id);
      } catch {
        // stop 뒤에 늦게 온 이벤트
      }
    };
    const listener = (event: ServerEvent): void => {
      switch (event.type) {
        case "item.started":
        case "item.completed":
          noteTurn(event.item.turnId);
          return;
        case "approval.requested": {
          const approval = event.approval;
          queueSide(async () => {
            const msg = await rt.rooms.post(item.roomId, {
              author: { kind: "agent", memberId: member.id },
              kind: "approval",
              text: approval.title,
              hop: item.hop,
              dispatchId: item.dispatchId,
              approval: { memberId: member.id, sessionId, approval, resolution: null },
            });
            approvalMessages.set(approval.approvalId, msg.id);
            this.setState(rt, member.id, "waiting_approval");
            await this.emitStatus(rt, this.statusRooms(rt, member.id));
          });
          return;
        }
        case "approval.resolved": {
          const resolution = { optionId: event.optionId, by: event.by, at: event.ts };
          queueSide(async () => {
            const messageId = approvalMessages.get(event.approvalId);
            if (messageId) {
              const current = (await rt.rooms.messagesSince(item.roomId, 0)).find((m) => m.id === messageId);
              if (current?.approval) await rt.rooms.update(item.roomId, messageId, { approval: { ...current.approval, resolution } });
            }
            if (member.state === "waiting_approval" && (this.manager.get(sessionId)?.pendingApprovals ?? 0) === 0) {
              this.setState(rt, member.id, "running");
              await this.emitStatus(rt, this.statusRooms(rt, member.id));
            }
          });
          return;
        }
        case "turn.completed":
          noteTurn(event.turnId);
          finish({ kind: "completed", turnId: event.turnId });
          return;
        case "error":
          if (!event.recoverable) finish({ kind: "error", turnId, message: event.message });
          return;
        case "session.status":
          if (event.status === "running" || event.status === "waiting_approval") started = true;
          else if (event.status === "error") finish({ kind: "error", turnId, message: event.reason ?? "세션 오류" });
          else if (event.status === "closed") finish({ kind: "interrupted", turnId });
          else if (event.status === "idle" && started) finish({ kind: run.interrupted ? "interrupted" : "ended", turnId });
          return;
        default:
          return;
      }
    };
    // 턴을 보내기 전에 stop/interrupt 가 들어왔으면 시작하지 않는다(세션이 idle 이라 manager.interrupt 는 무시됐다).
    if (run.interrupted) return { kind: "interrupted", turnId: null };
    run.unsubscribe = await this.manager.subscribe(sessionId, session.lastSeq, listener);
    if (run.interrupted) {
      run.unsubscribe();
      run.unsubscribe = undefined;
      return { kind: "interrupted", turnId: null };
    }
    try {
      await this.manager.startTurn(sessionId, input);
    } catch (err) {
      if (err instanceof SessionBusyError) {
        run.unsubscribe();
        run.unsubscribe = undefined;
        return "busy";
      }
      finish({ kind: "error", turnId, message: errorMessage(err) });
    }
    // 시작하는 동안(어댑터 기동 중) interrupt 가 들어왔으면 이제 세션이 살아 있으니 실제로 끊는다.
    if (run.interrupted && !finished) {
      await this.manager.interrupt(sessionId).catch((err) => {
        this.logger.warn(`[teams] 늦은 interrupt 실패 team=${rt.record.id} dispatch=${item.dispatchId}: ${errorMessage(err)}`);
      });
    }
    const result = await outcome;
    run.unsubscribe?.();
    run.unsubscribe = undefined;
    await side;
    return result;
  }

  /** 답변 게시 → 연쇄 디스패치 → 자동 커밋·ChangeSet → 상태. */
  private async finishTurn(rt: TeamRuntime, run: ActiveRun, member: TeamMemberRecord, outcome: Outcome, trigger: RoomMessage | null): Promise<void> {
    const item = run.item;
    const roomId = item.roomId;
    const turnId = outcome.turnId;
    if (outcome.kind === "interrupted") {
      await this.postSystem(rt, roomId, `${member.name}의 작업을 중단했습니다`);
      this.setState(rt, member.id, "idle");
      return;
    }
    if (outcome.kind === "error") {
      await this.postSystem(rt, roomId, `${member.name}의 턴이 오류로 끝났습니다: ${outcome.message}`);
      this.setState(rt, member.id, "error");
      if (RATE_LIMIT_RE.test(outcome.message)) {
        rt.paused = true;
        await this.postSystem(rt, this.groupRoom(rt).id, RATE_LIMIT_NOTICE);
      }
      return;
    }

    const items = turnId ? (await this.manager.detail(item.sessionId, DETAIL_LIMIT)).items : [];
    const reply = turnId ? extractReply(items, turnId) : null;
    let replyMessage: RoomMessage | null = null;
    if (reply === null || turnId === null) {
      await this.postSystem(rt, roomId, `${member.name}가 답변 없이 턴을 끝냈습니다`);
    } else {
      const mentions = parseMentions(reply, rt.record.members, { excludeMemberId: member.id });
      replyMessage = await rt.rooms.post(roomId, {
        author: { kind: "agent", memberId: member.id },
        kind: "text",
        text: reply,
        mentions: mentions.memberIds,
        hop: item.hop,
        dispatchId: item.dispatchId,
        work: { sessionId: item.sessionId, turnId, ...summarizeWork(items, turnId) },
      });
      const room = rt.record.rooms.find((r) => r.id === roomId) ?? this.groupRoom(rt);
      const targets = route({ team: rt.record, room, author: { kind: "agent", memberId: member.id }, mentions });
      const hop = nextHop(item.hop);
      if (targets.length > 0 && hopExceeded(hop, rt.record.settings.maxHops)) {
        await this.postSystem(rt, roomId, `자동 연쇄 상한(${rt.record.settings.maxHops})에 도달했습니다. 계속하려면 직접 지시하세요`);
      } else {
        for (const target of targets) {
          rt.queue.enqueue({ rootId: item.rootId, memberId: target.memberId, roomId, sourceMessageId: replyMessage.id, hop });
          this.markQueued(rt, target.memberId);
        }
      }
    }
    if (turnId !== null) await this.commitTurn(rt, member, item.sessionId, turnId, reply ?? (trigger ? trigger.text : null));
    this.setState(rt, member.id, "idle");
  }

  /** 턴 종료 자동 커밋. 커밋이 생기고 베이스보다 앞서면 ChangeSet(ready)을 그룹방에 올리고 이전 ready 는 stale 로 바꾼다. */
  private async commitTurn(rt: TeamRuntime, member: TeamMemberRecord, sessionId: string, turnId: string, subjectSource: string | null): Promise<void> {
    try {
      const subject = (subjectSource !== null ? firstLine(subjectSource) : "") || turnId;
      const sha = await commitAll(member.worktreePath, {
        message: `${member.name}(${member.roleLabel}): ${subject.slice(0, COMMIT_SUBJECT_MAX)}`,
        author: `${member.name} (mam-team) <${member.handle}@mam.local>`,
      });
      if (sha === null) return;
      const diff = await changesVsBase(rt.record.cwd, rt.record.baseBranch, member.branch);
      if (diff.commits <= 0) return;
      const kinds = await changedFileKinds(rt.record.cwd, rt.record.baseBranch, member.branch);
      const at = this.iso();
      const groupId = this.groupRoom(rt).id;
      const messageId = newId("msg");
      const change: ChangeSet = {
        id: newId("chg"),
        teamId: rt.record.id,
        memberId: member.id,
        sessionId,
        turnId,
        branch: member.branch,
        baseBranch: rt.record.baseBranch,
        commit: diff.head,
        files: diff.files.map((f) => ({ path: f.path, kind: kinds.get(f.path) ?? "modify", additions: f.additions, deletions: f.deletions })),
        commits: diff.commits,
        status: "ready",
        conflictFiles: [],
        messageId,
        createdAt: at,
        updatedAt: at,
      };
      for (const prev of rt.changes) {
        if (prev.memberId !== member.id || prev.status !== "ready") continue;
        prev.status = "stale";
        prev.updatedAt = at;
        try {
          await rt.rooms.update(groupId, prev.messageId, { changes: { ...prev } });
        } catch (err) {
          this.logger.warn(`[teams] stale 카드 갱신 실패 team=${rt.record.id} change=${prev.id}: ${errorMessage(err)}`);
        }
      }
      rt.changes.push(change);
      await rt.rooms.post(groupId, {
        id: messageId,
        author: { kind: "agent", memberId: member.id },
        kind: "changes",
        text: `${member.name}의 변경 준비됨: ${change.files.length}개 파일, 커밋 ${change.commits}개`,
        hop: 0,
        changes: change,
      });
      await this.persistChanges(rt);
    } catch (err) {
      this.logger.warn(`[teams] 자동 커밋 실패 team=${rt.record.id} member=${member.id}: ${errorMessage(err)}`);
      await this.postSystem(rt, this.groupRoom(rt).id, `${member.name}의 변경을 커밋하지 못했습니다: ${errorMessage(err)}`);
    }
  }
}

