import type { DispatchState, Room, RoomAuthor, Team } from "@mam/protocol";
import type { MentionResult } from "./mentions.js";

/**
 * 디스패치의 순수 로직(PROTOCOL 6.4): 라우팅(`route`), 팀별 FIFO 큐(`DispatchQueue`), 홉 계산.
 * 세션·방·git·파일·타이머를 모른다. step 5 의 TeamManager 가 이 함수들을 조립한다.
 */

export interface DispatchTarget {
  memberId: string;
  reason: "mention" | "lead" | "dm" | "all";
}

export interface RouteInput {
  team: Pick<Team, "members">;
  room: Pick<Room, "kind" | "memberId">;
  author: RoomAuthor;
  mentions: MentionResult;
}

/**
 * 그룹방: 멘션된 팀원 각각(`@all` 은 작성자 제외 전원). 멘션이 없으면 사용자 메시지는 팀장, 에이전트 답변은 대상 없음(연쇄 종료).
 * DM 방: 사용자 메시지만 그 방의 팀원에게, 다른 멘션은 무시. 시스템 메시지는 어디서도 디스패치하지 않는다. 자기 멘션·팀에 없는 ID 는 버린다.
 */
export function route(input: RouteInput): DispatchTarget[] {
  const { team, room, author, mentions } = input;
  if (author.kind === "system") return [];
  const known = new Set(team.members.map((m) => m.id));
  const self = author.kind === "agent" ? author.memberId : null;

  if (room.kind === "dm") {
    if (author.kind !== "user" || room.memberId === null || !known.has(room.memberId)) return [];
    return [{ memberId: room.memberId, reason: "dm" }];
  }

  const reason: DispatchTarget["reason"] = mentions.all ? "all" : "mention";
  const targets: DispatchTarget[] = [];
  const seen = new Set<string>();
  for (const memberId of mentions.memberIds) {
    if (memberId === self || !known.has(memberId) || seen.has(memberId)) continue;
    seen.add(memberId);
    targets.push({ memberId, reason });
  }
  if (targets.length > 0 || author.kind !== "user") return targets;
  const lead = team.members.find((m) => m.isLead);
  return lead ? [{ memberId: lead.id, reason: "lead" }] : [];
}

export interface DispatchItem {
  dispatchId: string;
  /** 연쇄의 뿌리(사용자 메시지 ID). 같은 뿌리 안에서 `(memberId, sourceMessageId)` 중복을 제거한다. */
  rootId: string;
  memberId: string;
  roomId: string;
  /** 이 디스패치를 일으킨 방 메시지(턴 입력의 마지막 줄). */
  sourceMessageId: string;
  hop: number;
  enqueuedAt: string;
}

export interface RunningItem extends DispatchItem {
  sessionId: string;
  turnId: string | null;
  startedAt: string;
}

export interface DispatchQueueOptions {
  maxConcurrent: number;
  now?: () => Date;
  newId: (prefix: "dsp") => string;
}

/**
 * 팀 하나의 FIFO 디스패치 큐. 팀 전체 `running` 은 `maxConcurrent` 이하, 팀원은 동시에 하나만 실행한다.
 * 이미 실행·대기 중인 팀원에게 온 새 트리거는 대기 항목 하나로 합쳐진다(맥락에 어차피 누적된다).
 * `next()` 는 큐를 바꾸지 않는다. 실제 전이는 `markRunning`(대기 → 실행)과 `markDone`(실행 → 제거)뿐이다.
 */
export class DispatchQueue {
  private readonly queued: DispatchItem[] = [];
  private readonly running = new Map<string, RunningItem>();
  private maxConcurrent: number;
  private readonly now: () => Date;
  private readonly newId: (prefix: "dsp") => string;

  constructor(opts: DispatchQueueOptions) {
    this.maxConcurrent = opts.maxConcurrent;
    this.now = opts.now ?? (() => new Date());
    this.newId = opts.newId;
  }

  /** 합치기·중복 제거 후 큐에 넣는다. 합쳐졌으면(또는 같은 뿌리의 중복이면) 기존 항목을 돌려준다. */
  enqueue(input: Omit<DispatchItem, "dispatchId" | "enqueuedAt">): { item: DispatchItem; coalesced: boolean } {
    const duplicate = (d: DispatchItem): boolean =>
      d.memberId === input.memberId && d.rootId === input.rootId && d.sourceMessageId === input.sourceMessageId;
    for (const r of this.running.values()) if (duplicate(r)) return { item: this.strip(r), coalesced: true };
    const waiting = this.queued.find((d) => d.memberId === input.memberId);
    if (waiting) return { item: { ...waiting }, coalesced: true };
    const item: DispatchItem = { ...input, dispatchId: this.newId("dsp"), enqueuedAt: this.now().toISOString() };
    this.queued.push(item);
    return { item: { ...item }, coalesced: false };
  }

  /** 실행 가능한 다음 항목(맨 앞부터, 팀원이 실행 중이 아닌 것). running 이 상한이면 null. 큐는 바꾸지 않는다. */
  next(): DispatchItem | null {
    if (this.running.size >= this.maxConcurrent) return null;
    const runningMembers = new Set([...this.running.values()].map((r) => r.memberId));
    const item = this.queued.find((d) => !runningMembers.has(d.memberId));
    return item ? { ...item } : null;
  }

  markRunning(dispatchId: string, sessionId: string): RunningItem {
    const index = this.queued.findIndex((d) => d.dispatchId === dispatchId);
    if (index < 0) throw new Error(`대기 중인 디스패치가 아닙니다: ${dispatchId}`);
    const item = this.queued[index]!;
    if (this.isRunning(item.memberId)) throw new Error(`팀원이 이미 실행 중입니다: ${item.memberId}`);
    this.queued.splice(index, 1);
    const running: RunningItem = { ...item, sessionId, turnId: null, startedAt: this.now().toISOString() };
    this.running.set(dispatchId, running);
    return { ...running };
  }

  setTurn(dispatchId: string, turnId: string): void {
    const running = this.running.get(dispatchId);
    if (!running) throw new Error(`실행 중인 디스패치가 아닙니다: ${dispatchId}`);
    running.turnId = turnId;
  }

  /** 실행 항목을 제거한다. 모르는 ID 는 무시한다(stop 뒤에 늦게 끝나는 턴). */
  markDone(dispatchId: string): void {
    this.running.delete(dispatchId);
  }

  /**
   * 실행 항목을 같은 ID 로 큐 맨 뒤에 되돌린다(세션이 바빠 턴을 못 보냈을 때). 그 팀원의 대기 항목이 이미 있으면
   * 거기에 합쳐진 것으로 보고 버린다. 모르는 ID 는 무시한다.
   */
  requeue(dispatchId: string): void {
    const running = this.running.get(dispatchId);
    if (!running) return;
    this.running.delete(dispatchId);
    if (this.queued.some((d) => d.memberId === running.memberId)) return;
    this.queued.push({ ...this.strip(running), enqueuedAt: this.now().toISOString() });
  }

  /** 한 팀원의 대기 항목을 제거해 돌려준다(팀원 제거·세션 준비 실패). 실행 중 항목은 그대로다. */
  removeQueued(memberId: string): DispatchItem[] {
    const out: DispatchItem[] = [];
    for (let i = this.queued.length - 1; i >= 0; i -= 1) {
      if (this.queued[i]!.memberId === memberId) out.unshift(...this.queued.splice(i, 1));
    }
    return out.map((d) => ({ ...d }));
  }

  /** 대기 항목을 전부 비우고 돌려준다. 실행 중인 항목은 그대로다(중단은 TeamManager 몫). */
  clear(): DispatchItem[] {
    return this.queued.splice(0).map((d) => ({ ...d }));
  }

  /** 실행 중이거나 대기 중이면 true. */
  isBusy(memberId: string): boolean {
    return this.isRunning(memberId) || this.queued.some((d) => d.memberId === memberId);
  }

  state(): DispatchState {
    return {
      running: [...this.running.values()].map((r) => ({
        dispatchId: r.dispatchId,
        memberId: r.memberId,
        roomId: r.roomId,
        sessionId: r.sessionId,
        turnId: r.turnId,
        hop: r.hop,
      })),
      queued: this.queued.map((d) => ({ dispatchId: d.dispatchId, memberId: d.memberId, roomId: d.roomId, hop: d.hop, enqueuedAt: d.enqueuedAt })),
    };
  }

  setMaxConcurrent(n: number): void {
    this.maxConcurrent = n;
  }

  private isRunning(memberId: string): boolean {
    for (const r of this.running.values()) if (r.memberId === memberId) return true;
    return false;
  }

  private strip(r: RunningItem): DispatchItem {
    const { sessionId: _s, turnId: _t, startedAt: _a, ...item } = r;
    return item;
  }
}

/** 사용자 메시지(부모 없음)는 0, 메시지에서 파생된 디스패치는 부모 hop + 1. */
export function nextHop(parentHop: number | null): number {
  return parentHop === null ? 0 : parentHop + 1;
}

/** `hop > maxHops` 면 디스패치하지 않는다(6 은 허용, 7 은 초과). */
export function hopExceeded(hop: number, maxHops: number): boolean {
  return hop > maxHops;
}
