import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  Attachment,
  ChangeSet,
  CreateTeamRequest,
  DispatchState,
  MemberInput,
  MergeResult,
  PatchMemberRequest,
  PatchTeamRequest,
  Room,
  RoomApproval,
  RoomAuthor,
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
  isAncestor,
  mergeIntoBase,
  removeWorktree,
  syncFromBase,
  unmergedFiles,
  worktreeIsDirty,
} from "../git/worktree.js";
import { newId } from "../ids.js";
import type { SessionManager } from "../sessions/manager.js";
import { ChangeStore, conflictNoteFor } from "./changes.js";
import { DispatchQueue, hopExceeded, nextHop, route, sideRoomParticipants, type DispatchTarget, type RunningItem } from "./dispatcher.js";
import { buildTurnText } from "./format.js";
import { parseMentions } from "./mentions.js";
import { buildInstructions, rolePreset } from "./roles.js";
import { RoomManager } from "./room-manager.js";
import { TeamStore, makeHandle, slug, toTeam } from "./store.js";
import { extractReply, summarizeWork } from "./summary.js";
import { DEFAULT_TEAM_SETTINGS, TeamTemplates } from "./templates.js";
import type { TeamMemberRecord, TeamRecord } from "./types.js";

/**
 * 팀·팀원 생명주기(worktree + 지연 시작 세션), 방 메시지 → 디스패치 → 세션 턴 → 답변 게시, 승인 미러링,
 * 턴 종료 자동 커밋과 "변경 준비됨" ChangeSet, 사용자 승인 머지(`--no-ff`)·dismiss·충돌 해결 턴·stale 정리(PROTOCOL 6, ADR-017). HTTP/WS 는 step 7.
 * 머지는 `merge()` 호출(사용자 액션)로만 일어나고 자동 머지는 없다. 충돌 시 베이스 체크아웃은 `merge --abort` 로 되돌리고
 * 그 팀원 worktree 에만 마커를 남긴 뒤 DM 방에서 해결 턴을 디스패치한다. 서버는 마커를 직접 해결하지 않는다.
 * 에이전트가 에이전트를 부르면 그 연쇄를 곁방(`kind: "side"`)으로 옮긴다(PROTOCOL 6.6): 원본 답변은 그 방에 그대로 두고 같은 본문을
 * 곁방에 트리거로 한 번 복사하며, 그룹방에는 열림·닫힘 연결 카드만 남긴다. 곁방은 참가자 집합이 신원이라 같은 조합이면 재사용하고 지우지 않는다.
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

const CONTEXT_MAX_CHARS = 12_000;
const GROUP_ROOM_NAME = "전체";
/** 곁방 이름은 참가자 이름을 이 구분자로 잇는다(PROTOCOL 6.1·6.6). */
const SIDE_ROOM_NAME_SEP = " ↔ ";
/** `closed` 연결 카드에 넣는 마지막 답변 첫 줄의 길이 상한. */
const SIDE_ROOM_CONCLUSION_MAX = 80;
const DEFAULT_MODE = "auto-edit" as const;
const COMMIT_SUBJECT_MAX = 72;
const DETAIL_LIMIT = 100_000;
const STOP_WAIT_MS = 5_000;
const DEFAULT_BUSY_RETRY_MS = 2_000;
const RATE_LIMIT_RE = /rate limit|usage limit|too many requests|429/i;
const RESTART_NOTICE = "서버가 다시 시작되어 진행 중이던 작업은 취소됐습니다";
const RATE_LIMIT_NOTICE = "구독 사용 한도에 걸려 팀 작업을 멈췄습니다. 한도가 풀리면 메시지를 보내 다시 시작하세요";
const BUSY_STATES: ReadonlySet<TeamMemberState> = new Set(["queued", "running", "waiting_approval"]);
/** `GET /teams/:id` 의 `changes` 에 넣는 종료 상태(merged/dismissed/stale) ChangeSet 의 최대 수. 나머지는 파일에만 남는다. */
const DETAIL_TERMINAL_CHANGES = 20;
const TERMINAL_CHANGE_STATUSES: ReadonlySet<ChangeSet["status"]> = new Set(["merged", "dismissed", "stale"]);
const MERGE_DIRTY_MESSAGE = "프로젝트에 커밋되지 않은 변경이 있어 머지할 수 없습니다. 먼저 커밋하거나 stash 하세요";

type Outcome =
  | { kind: "completed" | "ended" | "interrupted"; turnId: string | null }
  | { kind: "error"; turnId: string | null; message: string };

interface ActiveRun {
  item: RunningItem;
  interrupted: boolean;
  done: Promise<void>;
  unsubscribe?: () => void;
}

/** 한 연쇄(뿌리)가 갈라져 나간 곁방. 연쇄가 끝나면 `closed` 연결 카드를 한 번 남긴다(PROTOCOL 6.6). */
interface SideRoot {
  roomId: string;
  participants: string[];
  /** 갈라진 시점의 곁방 `lastSeq`. 이 뒤의 메시지가 이 연쇄의 대화다. */
  startSeq: number;
  posted: boolean;
}

interface TeamRuntime {
  record: TeamRecord;
  rooms: RoomManager;
  queue: DispatchQueue;
  changes: ChangeSet[];
  changeStore: ChangeStore;
  paused: boolean;
  active: Map<string, ActiveRun>;
  attachments: Map<string, Attachment[]>;
  pumping: boolean;
  pumpAgain: boolean;
  persistDirty: boolean;
  persistChain: Promise<void>;
  changesChain: Promise<void>;
  /** merge/dismiss 는 팀 단위로 직렬화한다(같은 ChangeSet 에 대한 동시 호출·베이스 체크아웃 경합 방지). */
  mergeChain: Promise<void>;
  /** 연쇄 뿌리 → 그 연쇄가 처음 갈라져 나간 곁방(2026-09-14). */
  sideRoots: Map<string, SideRoot>;
}

function cloneChange(c: ChangeSet): ChangeSet {
  return { ...c, files: c.files.map((f) => ({ ...f })), conflictFiles: [...c.conflictFiles] };
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
  /** 팀 템플릿 CRUD(`/team-templates`). 검증·id 발급은 `templates.ts`. */
  readonly templates: TeamTemplates;
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
    this.defaults = { ...DEFAULT_TEAM_SETTINGS, ...opts.defaults };
    this.templates = new TeamTemplates(this.store, { now: this.now, defaults: this.defaults });
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
      await tm.reconcileChanges(rt);
      // 재시작 직후에는 모든 세션의 대기 승인이 0 이라 방에 남은 미해결 카드는 전부 유령이다(ADR-019).
      // 여기서 던진 예외가 기동을 막으면 안 된다.
      await tm.reconcileApprovals(rt).catch((err) => {
        tm.logger.warn(`[teams] 승인 카드 재조정 실패 team=${record.id}: ${errorMessage(err)}`);
        return 0;
      });
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

  /** `changes` 는 ready/conflict/merging 전부 + 종료 상태(merged/dismissed/stale) 최근 20개(원래 순서 유지). */
  detail(teamId: string): TeamDetail {
    const rt = this.require(teamId);
    const terminal = rt.changes.filter((c) => TERMINAL_CHANGE_STATUSES.has(c.status));
    const keep = new Set(terminal.slice(-DETAIL_TERMINAL_CHANGES).map((c) => c.id));
    const changes = rt.changes.filter((c) => !TERMINAL_CHANGE_STATUSES.has(c.status) || keep.has(c.id)).map(cloneChange);
    return { team: toTeam(rt.record), dispatch: rt.queue.state(), changes };
  }

  /** `GET /teams/:id/changes`: 전부. */
  listChanges(teamId: string): ChangeSet[] {
    return this.require(teamId).changes.map(cloneChange);
  }

  async roomDetail(teamId: string, roomId: string, limit?: number): Promise<RoomDetailResponse> {
    return this.require(teamId).rooms.detail(roomId, limit);
  }

  async subscribeRoom(teamId: string, roomId: string, since: number, listener: (event: RoomServerEvent) => void): Promise<() => void> {
    return this.require(teamId).rooms.subscribe(roomId, since, listener);
  }

  /** 이 방에 미러링된 승인 중 아직 응답이 없는 것(`room.snapshot.pendingApprovals`). */
  async roomPendingApprovals(teamId: string, roomId: string): Promise<RoomApproval[]> {
    const messages = await this.require(teamId).rooms.messagesSince(roomId, 0);
    return messages.flatMap((m) => (m.kind === "approval" && m.approval !== null && m.approval.resolution === null ? [m.approval] : []));
  }

  /** `room.snapshot`·`room.status` 의 `members[]`. */
  memberStates(teamId: string): RoomMemberStatus[] {
    return this.memberStatuses(this.require(teamId));
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
    await this.reconcileApprovals(rt);
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
    await this.reconcileApprovals(rt);
    member.sessionId = null;
    member.state = "idle";
    await this.ensureSession(rt, member);
    this.touch(rt);
    await this.persist(rt);
    await this.emitStatus(rt, this.statusRooms(rt, memberId));
    return toTeam(rt.record);
  }

  // ---- 변경 머지·거절 ----------------------------------------------------------

  /**
   * 사용자가 승인한 ChangeSet 을 베이스에 `--no-ff` 머지한다(PROTOCOL 6.5). `ready` 가 아니면 409.
   * merging → mergeIntoBase → merged(팀원 worktree 동기화) | conflict(베이스 abort, 팀원 worktree 에 마커 + DM 해결 턴) |
   * dirty/wrong_branch(ready 로 되돌리고 409). 브랜치는 유지한다.
   */
  async merge(teamId: string, changeId: string): Promise<MergeResult> {
    const rt = this.require(teamId);
    return this.serializeMerge(rt, () => this.mergeChange(rt, changeId));
  }

  /** `ready`·`conflict` → `dismissed`. 브랜치·커밋·worktree 는 그대로. 그 외 상태면 409. */
  async dismiss(teamId: string, changeId: string): Promise<ChangeSet> {
    const rt = this.require(teamId);
    return this.serializeMerge(rt, async () => {
      const change = this.requireChange(rt, changeId);
      if (change.status !== "ready" && change.status !== "conflict") {
        throw new ConflictError(`ready 또는 conflict 상태의 변경만 거절할 수 있습니다 (현재 ${change.status})`);
      }
      await this.updateChange(rt, change, { status: "dismissed" });
      return cloneChange(change);
    });
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
      // DM 은 멘션을 무시한다(PROTOCOL 6.4). 그룹방·곁방은 해석된 멘션을 그대로 담는다.
      mentions: room.kind === "dm" ? [] : mentions.memberIds,
      hop: 0,
      dispatchId: null,
    });
    if (room.kind !== "dm" && mentions.unknown.length > 0) {
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
    if (targets.length === 0 && room.kind !== "dm") await rt.rooms.error(roomId, "메시지를 받을 팀원이 없습니다", true);
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
    const changeStore = new ChangeStore(this.store.teamDir(record.id), this.logger);
    const rt: TeamRuntime = {
      record,
      rooms,
      queue: new DispatchQueue({ maxConcurrent: record.settings.maxConcurrent, now: this.now, newId: (p) => newId(p) }),
      changes: await changeStore.load(),
      changeStore,
      paused: false,
      active: new Map(),
      attachments: new Map(),
      pumping: false,
      pumpAgain: false,
      persistDirty: false,
      persistChain: Promise.resolve(),
      changesChain: Promise.resolve(),
      mergeChain: Promise.resolve(),
      sideRoots: new Map(),
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

  /** 팀원의 맥락·상태 방: 그룹방 + 그 팀원의 DM 방 + 그 팀원이 참가한 곁방 전부(PROTOCOL 6.4 "턴 입력", 6.6). */
  private statusRooms(rt: TeamRuntime, memberId: string): string[] {
    const ids = [this.groupRoom(rt).id];
    const dm = this.dmRoom(rt, memberId);
    if (dm) ids.push(dm.id);
    for (const room of rt.record.rooms) {
      if (room.kind === "side" && (room.participants ?? []).includes(memberId)) ids.push(room.id);
    }
    return ids;
  }

  private memberName(rt: TeamRuntime, memberId: string): string {
    return rt.record.members.find((m) => m.id === memberId)?.name ?? memberId;
  }

  /** 참가자 집합(정렬)으로 곁방을 찾는다. 이 집합이 곁방의 신원이다(PROTOCOL 6.6). */
  private findSideRoom(rt: TeamRuntime, participants: string[]): Room | undefined {
    const key = participants.join(",");
    return rt.record.rooms.find((r) => r.kind === "side" && (r.participants ?? []).join(",") === key);
  }

  /**
   * 곁방을 찾고 없으면 만든다(PROTOCOL 6.6). 새로 만들면 참가자들의 `lastSeen` 을 0 으로 두고 즉시 영속화한 뒤
   * 그룹방에 `opened` 연결 카드를 남긴다. 이름은 참가자 이름을 `↔` 로 이은 것이고, 방은 대화가 끝나도 지우지 않는다.
   */
  private async ensureSideRoom(rt: TeamRuntime, participants: string[]): Promise<Room> {
    const ids = [...new Set(participants)].sort();
    if (ids.length < 2) throw new InvalidRequestError("곁방은 참가자가 2명 이상이어야 합니다");
    const existing = this.findSideRoom(rt, ids);
    if (existing) return existing;
    const name = ids.map((id) => this.memberName(rt, id)).join(SIDE_ROOM_NAME_SEP);
    const room: Room = { id: newId("room"), teamId: rt.record.id, kind: "side", memberId: null, name, lastSeq: 0, lastMessageAt: null, participants: ids };
    rt.record.rooms.push(room);
    await rt.rooms.addRoom(room);
    for (const m of rt.record.members) if (ids.includes(m.id)) m.lastSeen[room.id] = 0;
    this.touch(rt);
    await this.persist(rt);
    await rt.rooms.post(this.groupRoom(rt).id, {
      author: { kind: "system" },
      kind: "system",
      text: `${name} 곁방을 열었습니다`,
      sideRoom: { roomId: room.id, participants: [...ids], kind: "opened", messages: 0 },
    });
    return room;
  }

  /** 이 연쇄 뿌리가 갈라져 나간 첫 곁방을 기억한다(뿌리별 `closed` 카드 1건). */
  private noteSideRoot(rt: TeamRuntime, rootId: string, room: Room): void {
    if (rt.sideRoots.has(rootId)) return;
    rt.sideRoots.set(rootId, { roomId: room.id, participants: [...(room.participants ?? [])], startSeq: rt.rooms.lastSeq(room.id), posted: false });
  }

  /**
   * 연쇄가 끝났으면(그 뿌리의 실행·대기 항목이 없다) 곁방 대화를 그룹방에 한 줄로 닫는다(PROTOCOL 6.6):
   * 대화 수와 마지막 에이전트 답변의 첫 줄. 뿌리별로 한 번만 남기고 곁방은 지우지 않는다(같은 조합이면 재사용).
   */
  private async closeSideRoomIfDone(rt: TeamRuntime, rootId: string): Promise<void> {
    if (this.closed) return;
    const root = rt.sideRoots.get(rootId);
    if (!root || root.posted || rt.queue.hasRoot(rootId)) return;
    root.posted = true;
    try {
      const messages = await rt.rooms.messagesSince(root.roomId, root.startSeq);
      const last = [...messages].reverse().find((m) => m.kind === "text" && m.author.kind === "agent");
      const name = root.participants.map((id) => this.memberName(rt, id)).join(SIDE_ROOM_NAME_SEP);
      const conclusion = firstLine(last?.text ?? "").slice(0, SIDE_ROOM_CONCLUSION_MAX);
      await rt.rooms.post(this.groupRoom(rt).id, {
        author: { kind: "system" },
        kind: "system",
        text: `${name} 곁방 대화 ${messages.length}건 · 결론: ${conclusion}`,
        sideRoom: { roomId: root.roomId, participants: [...root.participants], kind: "closed", messages: messages.length },
      });
    } catch (err) {
      this.logger.warn(`[teams] 곁방 종료 카드 게시 실패 team=${rt.record.id} room=${root.roomId}: ${errorMessage(err)}`);
    }
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
    const snapshot = rt.changes.map(cloneChange);
    rt.changesChain = rt.changesChain.then(async () => {
      try {
        await rt.changeStore.save(snapshot);
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
        await this.closeSideRoomIfDone(rt, item.rootId);
      }
    }
  }

  /**
   * 턴 전 동기화. 진행 중 머지(MERGE_HEAD)가 있으면 동기화하지 않고 남은 충돌 파일을 안내한다.
   * 깨끗할 때만 `syncFromBase`; 충돌이면 마커를 남기고 안내문(`conflictNote`)을 돌려준다. 서버는 마커를 해결하지 않는다.
   */
  private async syncWorktree(rt: TeamRuntime, member: TeamMemberRecord): Promise<string | undefined> {
    const base = rt.record.baseBranch;
    try {
      if (await hasMergeInProgress(member.worktreePath)) return conflictNoteFor(await unmergedFiles(member.worktreePath), base);
      if (await worktreeIsDirty(member.worktreePath)) return undefined;
      const result = await syncFromBase(member.worktreePath, base);
      if (result.status === "conflict") return conflictNoteFor(result.conflictFiles ?? [], base);
    } catch (err) {
      this.logger.warn(`[teams] worktree 동기화 실패 team=${rt.record.id} member=${member.id}: ${errorMessage(err)}`);
    }
    return undefined;
  }

  /** 맥락 방(그룹방 + 자기 DM + 자기가 참가한 곁방)의 `lastSeen` 이후 메시지를 createdAt 순으로 모아 턴 텍스트를 만든다. */
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
          // 턴 아이템(user_message 부터)이 보이면 턴이 진짜 시작된 것이다. 그 뒤의 idle 만 종료로 친다.
          noteTurn(event.item.turnId);
          started = true;
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
          // `running` 만으로는 시작으로 보지 않는다: 지연 시작 세션은 어댑터 기동 중 running → idle 로 잠깐 튄다
          // (Codex 어댑터가 thread/start 직후 `status: idle` 을 낸다). 아이템 없이 온 idle 은 무시한다.
          if (event.status === "waiting_approval") started = true;
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
      const author: RoomAuthor = { kind: "agent", memberId: member.id };
      const targets = route({ team: rt.record, room, author, mentions });
      const hop = nextHop(item.hop);
      if (targets.length > 0 && hopExceeded(hop, rt.record.settings.maxHops)) {
        await this.postSystem(rt, roomId, `자동 연쇄 상한(${rt.record.settings.maxHops})에 도달했습니다. 계속하려면 직접 지시하세요`);
      } else if (targets.length > 0) {
        const next = await this.dispatchRoom(rt, { item, room, author, targets, reply: replyMessage });
        for (const target of targets) {
          rt.queue.enqueue({ rootId: item.rootId, memberId: target.memberId, roomId: next.roomId, sourceMessageId: next.sourceMessageId, hop });
          this.markQueued(rt, target.memberId);
        }
      }
    }
    if (turnId !== null) await this.commitTurn(rt, member, item.sessionId, turnId, reply ?? (trigger ? trigger.text : null));
    this.setState(rt, member.id, "idle");
  }

  /**
   * 이 답변의 연쇄를 실행할 방(PROTOCOL 6.4 "곁방 분리", 6.6). 방이 그대로면 원본 답변이 트리거다.
   * 곁방으로 갈라지거나(에이전트 → 에이전트) 곁방에서 상한을 넘어 그룹방으로 나갈 때는 같은 본문을 그 방에 한 번 게시하고
   * 그 복사본을 트리거로 쓴다. 원본 답변은 지우거나 옮기지 않는다(사람이 보던 기록이 사라지지 않게).
   */
  private async dispatchRoom(
    rt: TeamRuntime,
    ctx: { item: RunningItem; room: Room; author: RoomAuthor; targets: DispatchTarget[]; reply: RoomMessage },
  ): Promise<{ roomId: string; sourceMessageId: string }> {
    const { item, room, author, targets, reply } = ctx;
    const participants = sideRoomParticipants({ author, room, targets, maxParticipants: rt.record.settings.sideRoomMaxParticipants });
    let target: Room | undefined;
    if (participants !== null) {
      target = await this.ensureSideRoom(rt, participants);
      this.noteSideRoot(rt, item.rootId, target);
    } else if (room.kind === "side" && targets.some((t) => !(room.participants ?? []).includes(t.memberId))) {
      // 곁방 안에서 상한을 넘는 조합을 부르면 공지로 보고 그룹방에서 디스패치한다.
      target = this.groupRoom(rt);
    }
    if (!target || target.id === room.id) return { roomId: room.id, sourceMessageId: reply.id };
    const copy = await rt.rooms.post(target.id, {
      author,
      kind: "text",
      text: reply.text,
      mentions: targets.map((t) => t.memberId),
      hop: reply.hop,
      dispatchId: null,
    });
    return { roomId: target.id, sourceMessageId: copy.id };
  }

  /**
   * 턴 종료 자동 커밋. 커밋이 생기고 베이스보다 앞서면 ChangeSet(ready)을 그룹방에 올리고 같은 팀원의 이전 ready/conflict 는 stale 로 바꾼다.
   * 진행 중 머지(MERGE_HEAD)가 있어도 그대로 커밋한다 — git 이 머지 커밋을 만들어 충돌 해결이 완성된다.
   */
  private async commitTurn(rt: TeamRuntime, member: TeamMemberRecord, sessionId: string, turnId: string, subjectSource: string | null): Promise<void> {
    try {
      const subject = ((subjectSource !== null ? firstLine(subjectSource) : "") || turnId).slice(0, COMMIT_SUBJECT_MAX);
      const merging = await hasMergeInProgress(member.worktreePath);
      const sha = await commitAll(member.worktreePath, {
        message: merging ? `${member.name}(${member.roleLabel}): merge ${rt.record.baseBranch} — ${subject}` : `${member.name}(${member.roleLabel}): ${subject}`,
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
        if (prev.memberId !== member.id || (prev.status !== "ready" && prev.status !== "conflict")) continue;
        await this.updateChange(rt, prev, { status: "stale" }, { persist: false });
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

  // ---- internals: 머지·ChangeSet 상태 ------------------------------------------------

  private serializeMerge<T>(rt: TeamRuntime, fn: () => Promise<T>): Promise<T> {
    const run = rt.mergeChain.then(fn, fn);
    rt.mergeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private requireChange(rt: TeamRuntime, changeId: string): ChangeSet {
    const change = rt.changes.find((c) => c.id === changeId);
    if (!change) throw new NotFoundError(`변경을 찾을 수 없습니다: ${changeId}`);
    return change;
  }

  /** 상태를 바꾸고 그룹방 카드를 `room.message.updated` 로 갱신한 뒤 changes.json 에 저장한다. 카드 갱신 실패는 경고만. */
  private async updateChange(
    rt: TeamRuntime,
    change: ChangeSet,
    patch: Partial<Pick<ChangeSet, "status" | "conflictFiles">>,
    opts: { persist?: boolean } = {},
  ): Promise<void> {
    if (patch.status !== undefined) change.status = patch.status;
    change.conflictFiles = patch.conflictFiles !== undefined ? [...patch.conflictFiles] : change.status === "conflict" ? change.conflictFiles : [];
    change.updatedAt = this.iso();
    try {
      await rt.rooms.update(this.groupRoom(rt).id, change.messageId, { changes: cloneChange(change) });
    } catch (err) {
      this.logger.warn(`[teams] 변경 카드 갱신 실패 team=${rt.record.id} change=${change.id}: ${errorMessage(err)}`);
    }
    if (opts.persist !== false) await this.persistChanges(rt);
  }

  private isRunning(rt: TeamRuntime, memberId: string): boolean {
    return [...rt.active.values()].some((r) => r.item.memberId === memberId);
  }

  private async mergeChange(rt: TeamRuntime, changeId: string): Promise<MergeResult> {
    const change = this.requireChange(rt, changeId);
    if (change.status !== "ready") throw new ConflictError(`ready 상태의 변경만 머지할 수 있습니다 (현재 ${change.status})`);
    const member = rt.record.members.find((m) => m.id === change.memberId);
    const base = rt.record.baseBranch;
    await this.updateChange(rt, change, { status: "merging" });

    let result: Awaited<ReturnType<typeof mergeIntoBase>>;
    try {
      result = await mergeIntoBase({ repo: rt.record.cwd, base, branch: change.branch, message: `Merge ${change.branch} (${member?.name ?? change.memberId})` });
    } catch (err) {
      // 실패하면 사용자가 다시 시도할 수 있게 ready 로 되돌린다. 베이스 체크아웃은 mergeIntoBase 가 건드리지 않았거나 abort 했다.
      await this.updateChange(rt, change, { status: "ready" });
      if (err instanceof WorktreeError && err.code === "detached") throw new ConflictError(`현재 브랜치가 ${base} 가 아닙니다(detached HEAD)`);
      throw err;
    }

    switch (result.status) {
      case "dirty":
        await this.updateChange(rt, change, { status: "ready" });
        throw new ConflictError(MERGE_DIRTY_MESSAGE);
      case "wrong_branch":
        await this.updateChange(rt, change, { status: "ready" });
        throw new ConflictError(`현재 브랜치가 ${base} 가 아닙니다(현재 ${result.current})`);
      case "merged":
        await this.updateChange(rt, change, { status: "merged" });
        if (member) await this.syncAfterMerge(rt, member);
        return { change: cloneChange(change), mergeCommit: result.sha };
      case "conflict":
        await this.updateChange(rt, change, { status: "conflict", conflictFiles: result.conflictFiles });
        if (member) await this.dispatchConflictFix(rt, member, result.conflictFiles);
        return { change: cloneChange(change), mergeCommit: null };
    }
  }

  /** 머지 뒤 그 팀원 worktree 를 베이스와 맞춘다(깨끗하고 실행 중이 아닐 때만). 실행 중이면 다음 턴 전 동기화가 맡는다. */
  private async syncAfterMerge(rt: TeamRuntime, member: TeamMemberRecord): Promise<void> {
    if (this.isRunning(rt, member.id)) return;
    try {
      if (await hasMergeInProgress(member.worktreePath)) return;
      if (await worktreeIsDirty(member.worktreePath)) return;
      await syncFromBase(member.worktreePath, rt.record.baseBranch);
    } catch (err) {
      this.logger.warn(`[teams] 머지 후 worktree 동기화 실패 team=${rt.record.id} member=${member.id}: ${errorMessage(err)}`);
    }
  }

  /**
   * 충돌: 그 팀원 worktree 에 `syncFromBase` 로 마커를 남기고(깨끗하고 실행 중이 아닐 때만; 아니면 다음 턴 전 동기화가 남긴다),
   * DM 방에 system 메시지(루트, hop 0)를 올려 그 팀원에게 해결 턴을 디스패치한다. 실행 중이면 큐에 들어간다.
   */
  private async dispatchConflictFix(rt: TeamRuntime, member: TeamMemberRecord, conflictFiles: string[]): Promise<void> {
    const base = rt.record.baseBranch;
    if (!this.isRunning(rt, member.id)) {
      try {
        if (!(await hasMergeInProgress(member.worktreePath)) && !(await worktreeIsDirty(member.worktreePath))) {
          await syncFromBase(member.worktreePath, base);
        }
      } catch (err) {
        this.logger.warn(`[teams] 충돌 마커 준비 실패 team=${rt.record.id} member=${member.id}: ${errorMessage(err)}`);
      }
    }
    const dm = this.dmRoom(rt, member.id);
    if (!dm) return;
    const message = await rt.rooms.post(dm.id, {
      author: { kind: "system" },
      kind: "system",
      text: `${base} 에 머지하는 중 충돌이 났습니다: ${conflictFiles.join(", ")}. worktree 에서 충돌을 해결하고 파일을 저장하세요.`,
      hop: 0,
      dispatchId: null,
    });
    rt.queue.enqueue({ rootId: message.id, memberId: member.id, roomId: dm.id, sourceMessageId: message.id, hop: nextHop(message.hop) });
    this.markQueued(rt, member.id);
    this.touch(rt);
    await this.persist(rt);
    await this.emitStatus(rt, this.statusRooms(rt, member.id));
    this.pump(rt);
  }

  /**
   * 재시작 시 ChangeSet 상태를 git 과 맞춘다: `merging` 은 브랜치 커밋이 베이스에 들어갔으면 merged, 아니면 ready 로.
   * ready/conflict 는 브랜치 head 가 `commit` 과 다르거나 베이스보다 앞선 커밋이 없으면(브랜치가 사라진 경우 포함) stale.
   */
  private async reconcileChanges(rt: TeamRuntime): Promise<void> {
    let changed = false;
    for (const change of rt.changes) {
      if (change.status === "merging") {
        let merged = false;
        try {
          merged = await isAncestor(rt.record.cwd, change.commit, rt.record.baseBranch);
        } catch (err) {
          this.logger.warn(`[teams] merging 상태 확인 실패 team=${rt.record.id} change=${change.id}: ${errorMessage(err)}`);
        }
        await this.updateChange(rt, change, { status: merged ? "merged" : "ready" }, { persist: false });
        changed = true;
        if (merged) continue;
      }
      if (change.status !== "ready" && change.status !== "conflict") continue;
      let stale = false;
      try {
        const diff = await changesVsBase(rt.record.cwd, rt.record.baseBranch, change.branch);
        stale = diff.head !== change.commit || diff.commits <= 0;
      } catch (err) {
        this.logger.warn(`[teams] 변경 상태 확인 실패 team=${rt.record.id} change=${change.id}: ${errorMessage(err)}`);
        stale = true;
      }
      if (stale) {
        await this.updateChange(rt, change, { status: "stale" }, { persist: false });
        changed = true;
      }
    }
    if (changed) await this.persistChanges(rt);
  }

  /**
   * 방에 미러링된 승인 카드 중 세션에 더 이상 대기 중이 아닌 것을 시스템 취소로 정리한다.
   * 서버 재시작·팀원 세션 종료 뒤 남는 유령 카드를 없앤다. 정리한 개수를 돌려준다.
   * 진실은 세션이다(ADR-019): 아직 대기 중인 승인은 건드리지 않고 사람이 답할 때까지 기다린다(시한 없음).
   * 카드는 지우지 않고 `resolution` 만 채우며, 정리할 때 추가 시스템 메시지는 남기지 않는다.
   */
  private async reconcileApprovals(rt: TeamRuntime): Promise<number> {
    let cleaned = 0;
    for (const room of rt.record.rooms) {
      try {
        for (const m of await rt.rooms.messagesSince(room.id, 0)) {
          const mirrored = m.approval;
          if (m.kind !== "approval" || mirrored === null || mirrored.resolution !== null) continue;
          if (this.approvalIsPending(mirrored.sessionId, mirrored.approval.approvalId)) continue;
          await rt.rooms.update(room.id, m.id, {
            approval: { ...mirrored, resolution: { optionId: "abort", by: "system", at: this.iso() } },
          });
          cleaned += 1;
        }
      } catch (err) {
        // 방 하나가 실패해도 나머지를 계속한다. 메시지 본문·승인 제목은 로그에 남기지 않는다(CRITICAL 6).
        this.logger.warn(`[teams] 승인 카드 재조정 실패 team=${rt.record.id} room=${room.id}: ${errorMessage(err)}`);
      }
    }
    return cleaned;
  }

  /** 그 승인이 세션에 아직 대기 중인가. 세션이 없거나 조회가 실패하면 유령이다(`pendingApprovals` 는 모르는 id 에 던진다). */
  private approvalIsPending(sessionId: string, approvalId: string): boolean {
    if (!this.manager.get(sessionId)) return false;
    try {
      return this.manager.pendingApprovals(sessionId).some((a) => a.approvalId === approvalId);
    } catch {
      return false;
    }
  }
}

