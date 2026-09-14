import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  RoomMessageSchema,
  RoomServerEventSchema,
  type DispatchState,
  type Room,
  type RoomApproval,
  type RoomAuthor,
  type RoomMemberStatus,
  type RoomMessage,
  type RoomMessageKind,
  type RoomServerEvent,
  type WorkSummary,
  type ChangeSet,
} from "@mam/protocol";
import type { DistributiveOmit } from "../agents/types.js";
import { InvalidRequestError, RoomMessageNotFoundError, RoomNotFoundError } from "../errors.js";
import { newId } from "../ids.js";
import { JsonlLog } from "../sessions/event-log.js";
import type { TeamRecord } from "./types.js";

/**
 * 한 팀의 방 스트림: 방마다 독립된 seq, 링 버퍼, JSONL 로그(`<teamDir>/rooms/<roomId>.events.jsonl`), 구독 팬아웃.
 * seq 는 이 클래스의 `emit()` 한 곳에서만 발급하며 세션 seq(SessionManager)와 무관하다(ADR-017, CRITICAL 7).
 * 세션·디스패치·git 은 모른다. 메시지 본문은 로그(logger)에 남기지 않는다(CRITICAL 6).
 */

export interface RoomManagerOptions {
  /** `<dataDir>/teams/<teamId>` */
  teamDir: string;
  team: TeamRecord;
  ringBufferSize?: number;
  now?: () => Date;
  logger?: Pick<Console, "warn">;
}

export interface RoomMessageDraft {
  /** 호출자가 미리 만든 `msg_` ID(ChangeSet.messageId 처럼 본문이 자기 ID 를 참조할 때). 생략하면 발급한다. */
  id?: string;
  author: RoomAuthor;
  kind: RoomMessageKind;
  text: string;
  mentions?: string[];
  hop?: number;
  dispatchId?: string | null;
  work?: WorkSummary | null;
  approval?: RoomApproval | null;
  changes?: ChangeSet | null;
}

export type RoomMessagePatch = Partial<Pick<RoomMessage, "text" | "work" | "approval" | "changes">>;

export interface RoomDetail {
  room: Room;
  messages: RoomMessage[];
  truncated: boolean;
}

type Listener = (event: RoomServerEvent) => void;
type EventBody = DistributiveOmit<RoomServerEvent, "seq" | "roomId" | "teamId" | "ts">;

interface RoomState {
  room: Room;
  log: JsonlLog<RoomServerEvent>;
  ring: RoomServerEvent[];
  /** 메시지의 현재 상태(`room.message` 에 `room.message.updated` 를 덮어쓴 것). 삽입 순서 = 게시 순서 = seq 순. */
  messages: Map<string, RoomMessage>;
  subscribers: Set<Listener>;
}

const DEFAULT_RING_BUFFER_SIZE = 500;
const DEFAULT_DETAIL_LIMIT = 200;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function cloneMessage(m: RoomMessage): RoomMessage {
  return structuredClone(m);
}

export class RoomManager {
  /** TeamManager 가 연결한다: 방 메타(`lastSeq`, `lastMessageAt`)가 바뀔 때마다 복사본으로 호출된다. */
  onRoomChanged?: (room: Room) => void;

  private readonly rooms = new Map<string, RoomState>();
  private readonly teamId: string;
  private readonly roomsDir: string;
  private readonly ringSize: number;
  private readonly now: () => Date;
  private readonly logger: Pick<Console, "warn">;

  private constructor(opts: RoomManagerOptions) {
    this.teamId = opts.team.id;
    this.roomsDir = join(opts.teamDir, "rooms");
    this.ringSize = opts.ringBufferSize ?? DEFAULT_RING_BUFFER_SIZE;
    this.now = opts.now ?? (() => new Date());
    this.logger = opts.logger ?? console;
  }

  /** 방마다 로그 전체를 한 번 읽어 메시지 맵·링·lastSeq(team.json 값과 로그의 큰 쪽)를 복원한다. */
  static async open(opts: RoomManagerOptions): Promise<RoomManager> {
    const manager = new RoomManager(opts);
    await mkdir(manager.roomsDir, { recursive: true, mode: 0o700 });
    for (const room of opts.team.rooms) await manager.addRoom(room);
    return manager;
  }

  /** open 이후 생긴 방(새 DM)을 등록한다. 이미 있으면 아무것도 하지 않는다. */
  async addRoom(room: Room): Promise<void> {
    if (this.rooms.has(room.id)) return;
    const state: RoomState = {
      room: { ...room, teamId: this.teamId },
      log: new JsonlLog<RoomServerEvent>(join(this.roomsDir, `${room.id}.events.jsonl`), RoomServerEventSchema, this.logger),
      ring: [],
      messages: new Map(),
      subscribers: new Set(),
    };
    let maxSeq = 0;
    let lastMessageAt: string | null = null;
    for await (const event of state.log.readSince(0)) {
      this.applyToIndex(state, event);
      this.pushRing(state, event);
      if (event.seq > maxSeq) maxSeq = event.seq;
      if (event.type === "room.message") lastMessageAt = event.message.createdAt;
    }
    if (maxSeq > state.room.lastSeq) state.room.lastSeq = maxSeq;
    if (lastMessageAt !== null && (state.room.lastMessageAt === null || state.room.lastMessageAt < lastMessageAt)) {
      state.room.lastMessageAt = lastMessageAt;
    }
    this.rooms.set(room.id, state);
  }

  lastSeq(roomId: string): number {
    return this.require(roomId).room.lastSeq;
  }

  /** `msg_` ID 와 seq 를 발급해 `room.message` 를 기록·팬아웃한다. 초안이 `RoomMessage` 스키마에 맞지 않으면 seq 를 쓰지 않고 400. */
  async post(roomId: string, draft: RoomMessageDraft): Promise<RoomMessage> {
    const rs = this.require(roomId);
    // 검증용으로 다음 seq 를 미리 본다. 발급(lastSeq 갱신)은 아래 emit() 이 동기적으로 이어서 하므로 같은 값이다.
    const seq = this.peekSeq(rs);
    const createdAt = this.iso();
    const candidate: RoomMessage = {
      id: draft.id ?? newId("msg"),
      roomId,
      seq,
      author: draft.author,
      kind: draft.kind,
      text: draft.text,
      mentions: draft.mentions ?? [],
      hop: draft.hop ?? 0,
      dispatchId: draft.dispatchId ?? null,
      createdAt,
      work: draft.work ?? null,
      approval: draft.approval ?? null,
      changes: draft.changes ?? null,
      // 곁방 연결 카드는 아직 만들지 않는다(PROTOCOL 6.6 은 계약만 있고 서버 동작은 다음 step).
      sideRoom: null,
    };
    const message = this.validate(candidate);
    const event = this.emit(rs, { type: "room.message", message });
    await this.persist(rs, event);
    return cloneMessage(message);
  }

  /** 기존 메시지 갱신(승인 resolution, ChangeSet status). 이벤트는 새 seq, `message.seq` 는 원래 값. */
  async update(roomId: string, messageId: string, patch: RoomMessagePatch): Promise<RoomMessage> {
    const rs = this.require(roomId);
    const existing = rs.messages.get(messageId);
    if (!existing) throw new RoomMessageNotFoundError(messageId);
    const next = this.validate({ ...existing, ...patch, id: existing.id, seq: existing.seq, roomId: existing.roomId });
    const event = this.emit(rs, { type: "room.message.updated", message: next });
    await this.persist(rs, event);
    return cloneMessage(next);
  }

  async status(roomId: string, dispatch: DispatchState, members: RoomMemberStatus[]): Promise<void> {
    const rs = this.require(roomId);
    const event = this.emit(rs, { type: "room.status", dispatch: structuredClone(dispatch), members: members.map((m) => ({ ...m })) });
    await this.persist(rs, event);
  }

  async error(roomId: string, message: string, recoverable: boolean): Promise<void> {
    const rs = this.require(roomId);
    const event = this.emit(rs, { type: "room.error", message, recoverable });
    await this.persist(rs, event);
  }

  /** `since` 이후 이벤트를 링 버퍼 또는 파일에서 재생한 뒤 라이브 팬아웃에 붙인다(세션 subscribe 와 같은 규칙). */
  async subscribe(roomId: string, since: number, listener: Listener): Promise<() => void> {
    const rs = this.require(roomId);
    let replaying = true;
    const buffered: RoomServerEvent[] = [];
    const wrapped: Listener = (event) => {
      if (replaying) buffered.push(event);
      else listener(event);
    };
    rs.subscribers.add(wrapped);
    let last = since;
    const deliver = (event: RoomServerEvent): void => {
      if (event.seq > last) {
        listener(event);
        last = event.seq;
      }
    };
    try {
      const first = rs.ring[0];
      if (first !== undefined && first.seq <= since + 1) {
        for (const event of rs.ring) deliver(event);
      } else if (since < rs.room.lastSeq) {
        for await (const event of rs.log.readSince(since)) deliver(event);
      }
      for (const event of buffered) deliver(event);
    } finally {
      replaying = false;
      buffered.length = 0;
    }
    return () => {
      rs.subscribers.delete(wrapped);
    };
  }

  /** 최신 상태의 메시지 목록(최근 `limit` 개). */
  async detail(roomId: string, limit = DEFAULT_DETAIL_LIMIT): Promise<RoomDetail> {
    const rs = this.require(roomId);
    const all = [...rs.messages.values()];
    return { room: { ...rs.room }, messages: all.slice(-limit).map(cloneMessage), truncated: all.length > limit };
  }

  /** 원래 seq 가 `seq` 보다 큰 메시지(최신 상태). 디스패처의 맥락 수집용. */
  async messagesSince(roomId: string, seq: number): Promise<RoomMessage[]> {
    const rs = this.require(roomId);
    return [...rs.messages.values()].filter((m) => m.seq > seq).map(cloneMessage);
  }

  /** 모든 방 로그의 대기 중인 append 가 끝날 때까지 기다린다. */
  async flush(): Promise<void> {
    for (const rs of this.rooms.values()) await rs.log.flush();
  }

  // ---- internals -------------------------------------------------------

  private require(roomId: string): RoomState {
    const rs = this.rooms.get(roomId);
    if (!rs) throw new RoomNotFoundError(roomId);
    return rs;
  }

  private iso(): string {
    return this.now().toISOString();
  }

  private validate(message: RoomMessage): RoomMessage {
    const parsed = RoomMessageSchema.safeParse(message);
    if (!parsed.success) {
      const path = parsed.error.issues[0]?.path.join(".") ?? "?";
      throw new InvalidRequestError(`방 메시지가 올바르지 않습니다: ${path}`);
    }
    return parsed.data;
  }

  /** seq/roomId/teamId/ts 를 붙여 인덱스 갱신 → 링 → 동기 팬아웃 → onRoomChanged. 로그 append 는 `persist()`. */
  private peekSeq(rs: RoomState): number {
    return rs.room.lastSeq + 1;
  }

  /** 방 seq 를 발급하는 유일한 곳. */
  private emit(rs: RoomState, body: EventBody): RoomServerEvent {
    const seq = this.peekSeq(rs);
    rs.room.lastSeq = seq;
    const ts = this.iso();
    const event = { ...body, seq, roomId: rs.room.id, teamId: this.teamId, ts } as RoomServerEvent;
    this.applyToIndex(rs, event);
    this.pushRing(rs, event);
    if (event.type === "room.message") rs.room.lastMessageAt = event.message.createdAt;
    for (const listener of [...rs.subscribers]) {
      try {
        listener(event);
      } catch (err) {
        this.logger.warn(`[rooms] 구독자 오류 room=${rs.room.id} seq=${seq}: ${errorMessage(err)}`);
      }
    }
    try {
      this.onRoomChanged?.({ ...rs.room });
    } catch (err) {
      this.logger.warn(`[rooms] onRoomChanged 오류 room=${rs.room.id} seq=${seq}: ${errorMessage(err)}`);
    }
    return event;
  }

  private async persist(rs: RoomState, event: RoomServerEvent): Promise<void> {
    try {
      await rs.log.append(event);
    } catch (err) {
      this.logger.warn(`[rooms] 이벤트 로그 기록 실패 room=${rs.room.id} seq=${event.seq}: ${errorMessage(err)}`);
    }
  }

  private pushRing(rs: RoomState, event: RoomServerEvent): void {
    rs.ring.push(event);
    if (rs.ring.length > this.ringSize) rs.ring.shift();
  }

  private applyToIndex(rs: RoomState, event: RoomServerEvent): void {
    if (event.type === "room.message") rs.messages.set(event.message.id, cloneMessage(event.message));
    else if (event.type === "room.message.updated" && rs.messages.has(event.message.id)) {
      rs.messages.set(event.message.id, cloneMessage(event.message));
    }
  }
}
