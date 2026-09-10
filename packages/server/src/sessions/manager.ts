import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  SessionSchema,
  type Approval,
  type CreateSessionRequest,
  type PatchSessionRequest,
  type ServerEvent,
  type Session,
  type SessionContext,
  type SessionMode,
  type SessionStatus,
  type SessionUsage,
  type TimelineItem,
  type TurnInput,
} from "@mam/protocol";
import type { AgentAdapter, AgentEvent, AgentKind, AgentModel, AgentSession, ContextSnapshot, DistributiveOmit } from "../agents/types.js";
import {
  AgentUnavailableError,
  ApprovalAlreadyResolvedError,
  ApprovalNotFoundError,
  ConflictError,
  InvalidRequestError,
  MamError,
  SessionBusyError,
  SessionClosedError,
  SessionNotFoundError,
} from "../errors.js";
import { newId } from "../ids.js";
import { EventLog } from "./event-log.js";

export interface SessionManagerOptions {
  dataDir: string;
  adapters: Partial<Record<AgentKind, AgentAdapter>>;
  idleTimeoutMs?: number;
  ringBufferSize?: number;
  now?: () => Date;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

export interface SessionDetail {
  session: Session;
  items: TimelineItem[];
  truncated: boolean;
}

type Listener = (event: ServerEvent) => void;
type EventBody = DistributiveOmit<ServerEvent, "seq" | "sessionId" | "ts">;

interface Live {
  agent: AgentSession;
  closing: boolean;
}

interface Runtime {
  session: Session;
  log: EventLog;
  ring: ServerEvent[];
  items: Map<string, TimelineItem>;
  loaded: boolean;
  loading?: Promise<void>;
  pending: Map<string, Approval>;
  resolved: Set<string>;
  subscribers: Set<Listener>;
  live?: Live;
  idleTimer?: NodeJS.Timeout;
  /** 마지막 활동 시각(ms). 이벤트 발행과 마지막 구독자 이탈이 갱신한다. 유휴 타이머의 기준. */
  lastActivityAt: number;
  persistDirty: boolean;
  persistChain: Promise<void>;
  /** session.usage 디바운스: 마지막 발행 시각(ms)과 대기 중인 타이머. */
  lastUsageEmitAt?: number;
  usageTimer?: NodeJS.Timeout;
}

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_RING_BUFFER_SIZE = 500;
const DEFAULT_DETAIL_LIMIT = 200;
const PREVIEW_MAX = 120;
/** 300ms 안에 연속으로 온 usage 관측은 마지막 것만 발행한다. */
const USAGE_DEBOUNCE_MS = 300;
const BUSY_STATUSES: ReadonlySet<SessionStatus> = new Set(["starting", "running", "waiting_approval"]);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function emptyUsage(at: string): SessionUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, turns: 0, context: null, updatedAt: at };
}

/** `percent = round(tokens/window*100)` 을 0~100 으로 클램프. 창을 모르면 null. */
function toContext(snapshot: ContextSnapshot | null): SessionContext | null {
  if (!snapshot || !(snapshot.window > 0)) return null;
  const tokens = Math.max(0, Math.round(snapshot.tokens));
  const window = Math.max(1, Math.round(snapshot.window));
  return { tokens, window, percent: Math.min(100, Math.max(0, Math.round((tokens / window) * 100))) };
}

function cloneUsage(usage: SessionUsage): SessionUsage {
  return { ...usage, context: usage.context ? { ...usage.context } : null };
}

export class SessionManager {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly sessionsDir: string;
  private readonly adapters: Partial<Record<AgentKind, AgentAdapter>>;
  private readonly idleTimeoutMs: number;
  private readonly ringSize: number;
  private readonly now: () => Date;
  private readonly logger: Pick<Console, "info" | "warn" | "error">;

  private constructor(opts: SessionManagerOptions) {
    this.sessionsDir = join(opts.dataDir, "sessions");
    this.adapters = opts.adapters;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.ringSize = opts.ringBufferSize ?? DEFAULT_RING_BUFFER_SIZE;
    this.now = opts.now ?? (() => new Date());
    this.logger = opts.logger ?? console;
  }

  /** `dataDir/sessions/*.json` 을 로드한다. 죽었던 세션은 `closed` 가 아니면 `idle` 로 둔다. */
  static async open(opts: SessionManagerOptions): Promise<SessionManager> {
    const manager = new SessionManager(opts);
    await mkdir(manager.sessionsDir, { recursive: true });
    for (const name of await readdir(manager.sessionsDir)) {
      if (!name.endsWith(".json")) continue;
      const path = join(manager.sessionsDir, name);
      try {
        const parsed = SessionSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
        if (!parsed.success) {
          manager.logger.warn(`[sessions] 세션 메타 스키마 불일치, 건너뜀: ${name}`);
          continue;
        }
        const session = parsed.data;
        if (session.status !== "closed") session.status = "idle";
        session.pendingApprovals = 0;
        session.effort ??= null;
        session.usage ??= null;
        manager.runtimes.set(session.id, manager.newRuntime(session, false));
      } catch (err) {
        manager.logger.warn(`[sessions] 세션 메타 로드 실패, 건너뜀: ${name}: ${errorMessage(err)}`);
      }
    }
    return manager;
  }

  list(filter?: { cwd?: string; status?: SessionStatus }): Session[] {
    return [...this.runtimes.values()]
      .map((rt) => ({ ...rt.session }))
      .filter((s) => (filter?.cwd === undefined || s.cwd === filter.cwd) && (filter?.status === undefined || s.status === filter.status))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  }

  get(id: string): Session | undefined {
    const rt = this.runtimes.get(id);
    return rt ? { ...rt.session } : undefined;
  }

  async create(req: CreateSessionRequest): Promise<Session> {
    const adapter = this.adapters[req.agent];
    if (!adapter) throw new AgentUnavailableError(`${req.agent} 어댑터를 사용할 수 없습니다`);
    await this.assertDirectory(req.cwd);
    const at = this.iso();
    const session: Session = {
      id: newId("ses"),
      agent: req.agent,
      cwd: req.cwd,
      title: req.title ?? basename(req.cwd),
      mode: req.mode ?? "ask",
      model: req.model ?? null,
      effort: null,
      status: "starting",
      nativeId: req.resumeNativeId ?? null,
      createdAt: at,
      updatedAt: at,
      lastSeq: 0,
      pendingApprovals: 0,
      preview: null,
      usage: null,
    };
    const rt = this.newRuntime(session, true);
    this.runtimes.set(session.id, rt);
    this.schedulePersist(rt);
    try {
      await this.startAgent(rt, req.resumeNativeId);
    } catch (err) {
      this.setStatus(rt, "error", errorMessage(err));
      throw err instanceof MamError ? err : new AgentUnavailableError(`에이전트 시작 실패: ${errorMessage(err)}`);
    }
    this.setStatus(rt, "idle");
    return { ...rt.session };
  }

  async patch(id: string, patch: PatchSessionRequest): Promise<Session> {
    const rt = this.require(id);
    if (patch.title !== undefined && patch.title !== rt.session.title) {
      rt.session.title = patch.title;
      rt.session.updatedAt = this.iso();
      this.schedulePersist(rt);
    }
    if (patch.mode !== undefined) await this.setMode(id, patch.mode);
    if (patch.model !== undefined || patch.effort !== undefined) await this.setModelEffort(rt, patch.model, patch.effort);
    return { ...rt.session };
  }

  /**
   * 모델·effort 변경. `listModels()` 로 검증(400)하고 라이브 어댑터 세션이 있으면 전달한다. 없으면 저장만 하고
   * 다음 `start()` 의 StartOptions 로 넘긴다. 새 모델이 현재 effort 를 지원하지 않으면 effort 를 지운다.
   */
  private async setModelEffort(rt: Runtime, model: string | undefined, effort: string | undefined): Promise<void> {
    if (rt.session.status === "closed") throw new SessionClosedError(rt.session.id);
    const models = await this.listModelsForValidation(rt.session.agent);
    let nextEffort: string | null | undefined = effort;
    if (models) {
      if (model !== undefined && !models.some((m) => m.id === model)) throw new InvalidRequestError(`지원하지 않는 모델입니다: ${model}`);
      const targetId = model ?? rt.session.model;
      const target = targetId === null ? models.find((m) => m.isDefault) : models.find((m) => m.id === targetId);
      if (effort !== undefined) {
        const allowed = target ? target.efforts : models.flatMap((m) => m.efforts);
        if (!allowed.includes(effort)) throw new InvalidRequestError(`지원하지 않는 사고 수준입니다: ${effort}`);
      } else if (model !== undefined && rt.session.effort != null && target && !target.efforts.includes(rt.session.effort)) {
        nextEffort = null;
      }
    }
    const live = rt.live?.agent;
    if (live) {
      if (model !== undefined) await live.setModel(model);
      if (typeof nextEffort === "string") await live.setEffort(nextEffort);
    }
    let changed = false;
    if (model !== undefined && rt.session.model !== model) {
      rt.session.model = model;
      changed = true;
    }
    if (nextEffort !== undefined && rt.session.effort !== nextEffort) {
      rt.session.effort = nextEffort;
      changed = true;
    }
    if (changed) {
      rt.session.updatedAt = this.iso();
      this.schedulePersist(rt);
    }
  }

  private async listModelsForValidation(kind: AgentKind): Promise<AgentModel[] | undefined> {
    const adapter = this.adapters[kind];
    if (!adapter) return undefined;
    try {
      return await adapter.listModels();
    } catch (err) {
      this.logger.warn(`[sessions] 모델 목록 조회 실패, 검증 생략 agent=${kind}: ${errorMessage(err)}`);
      return undefined;
    }
  }

  async setMode(id: string, mode: SessionMode): Promise<void> {
    const rt = this.require(id);
    if (rt.session.status === "closed") throw new SessionClosedError(id);
    if (rt.session.mode === mode) return;
    rt.session.mode = mode;
    if (rt.live) await rt.live.agent.setMode(mode);
    this.emit(rt, () => ({ type: "session.status", status: rt.session.status, mode, reason: "mode_changed" }));
  }

  async close(id: string): Promise<Session> {
    const rt = this.require(id);
    if (rt.session.status === "closed") return { ...rt.session };
    this.clearIdleTimer(rt);
    this.resolvePendingBySystem(rt);
    await this.closeLive(rt);
    this.flushUsage(rt);
    this.setStatus(rt, "closed");
    await rt.persistChain;
    return { ...rt.session };
  }

  async detail(id: string, limit = DEFAULT_DETAIL_LIMIT): Promise<SessionDetail> {
    const rt = this.require(id);
    await this.ensureLoaded(rt);
    const all = [...rt.items.values()];
    return { session: { ...rt.session }, items: all.slice(-limit), truncated: all.length > limit };
  }

  /** `since` 이후 이벤트를 링버퍼 또는 파일에서 재생한 뒤 라이브 팬아웃에 붙인다. */
  async subscribe(id: string, since: number, listener: Listener): Promise<() => void> {
    const rt = this.require(id);
    await this.ensureLoaded(rt);
    this.clearIdleTimer(rt);
    let replaying = true;
    const buffered: ServerEvent[] = [];
    const wrapped: Listener = (event) => {
      if (replaying) buffered.push(event);
      else listener(event);
    };
    rt.subscribers.add(wrapped);
    let last = since;
    const deliver = (event: ServerEvent): void => {
      if (event.seq > last) {
        listener(event);
        last = event.seq;
      }
    };
    try {
      const first = rt.ring[0];
      if (first !== undefined && first.seq <= since + 1) {
        for (const event of rt.ring) deliver(event);
      } else if (since < rt.session.lastSeq) {
        for await (const event of rt.log.readSince(since)) deliver(event);
      }
      for (const event of buffered) deliver(event);
    } finally {
      replaying = false;
      buffered.length = 0;
    }
    return () => {
      if (!rt.subscribers.delete(wrapped)) return;
      // 클라이언트가 붙어 있던 시간도 활동으로 본다. 유휴 시계는 마지막 구독자가 떠난 시점부터 센다.
      if (rt.subscribers.size === 0) rt.lastActivityAt = this.now().getTime();
      this.armIdleTimer(rt);
    };
  }

  async startTurn(id: string, input: TurnInput): Promise<void> {
    const rt = this.require(id);
    await this.ensureLoaded(rt);
    if (rt.session.status === "closed") throw new SessionClosedError(id);
    if (BUSY_STATUSES.has(rt.session.status)) throw new SessionBusyError(id);
    this.setStatus(rt, "running");
    try {
      if (!rt.live) await this.startAgent(rt, rt.session.nativeId ?? undefined);
      await rt.live!.agent.sendTurn(input);
    } catch (err) {
      const message = errorMessage(err);
      this.emit(rt, () => ({ type: "error", message, recoverable: false }));
      this.failSession(rt, message);
      throw err instanceof MamError ? err : new AgentUnavailableError(`턴 시작 실패: ${message}`);
    }
  }

  async interrupt(id: string): Promise<void> {
    const rt = this.require(id);
    if (!rt.live || !BUSY_STATUSES.has(rt.session.status)) return;
    this.resolvePendingBySystem(rt);
    await rt.live.agent.interrupt();
  }

  async respondApproval(
    id: string,
    approvalId: string,
    optionId: string,
    inputs?: Record<string, string>,
    message?: string,
  ): Promise<void> {
    const rt = this.require(id);
    const approval = rt.pending.get(approvalId);
    if (!approval) {
      if (rt.resolved.has(approvalId)) throw new ApprovalAlreadyResolvedError(approvalId);
      throw new ApprovalNotFoundError(approvalId);
    }
    if (!approval.options.some((o) => o.id === optionId)) {
      throw new InvalidRequestError(`허용되지 않는 승인 옵션입니다: ${optionId}`);
    }
    if (!rt.live) throw new ConflictError("에이전트 세션이 없어 승인을 전달할 수 없습니다");
    rt.pending.delete(approvalId);
    rt.resolved.add(approvalId);
    rt.session.pendingApprovals = rt.pending.size;
    const delivery = rt.live.agent.respondApproval(approvalId, optionId, inputs, message);
    this.emit(rt, () => ({ type: "approval.resolved", approvalId, optionId, by: "client" }));
    if (rt.pending.size === 0 && rt.session.status === "waiting_approval") this.setStatus(rt, "running");
    try {
      await delivery;
    } catch (err) {
      this.logger.warn(`[sessions] 승인 응답 전달 실패 session=${id} approval=${approvalId}: ${errorMessage(err)}`);
      throw err;
    }
  }

  pendingApprovals(id: string): Approval[] {
    return [...this.require(id).pending.values()];
  }

  /** 어댑터 세션을 모두 닫고 디스크를 flush 한다. 세션 상태는 바꾸지 않는다(재개 가능). */
  async shutdown(): Promise<void> {
    for (const rt of this.runtimes.values()) {
      this.clearIdleTimer(rt);
      await this.closeLive(rt);
      this.flushUsage(rt);
      await rt.persistChain;
      await rt.log.flush();
    }
  }

  // ---- internals -------------------------------------------------------

  private require(id: string): Runtime {
    const rt = this.runtimes.get(id);
    if (!rt) throw new SessionNotFoundError(id);
    return rt;
  }

  private iso(): string {
    return this.now().toISOString();
  }

  private newRuntime(session: Session, loaded: boolean): Runtime {
    return {
      session,
      log: new EventLog(join(this.sessionsDir, `${session.id}.events.jsonl`), this.logger),
      ring: [],
      items: new Map(),
      loaded,
      pending: new Map(),
      resolved: new Set(),
      subscribers: new Set(),
      lastActivityAt: this.now().getTime(),
      persistDirty: false,
      persistChain: Promise.resolve(),
    };
  }

  private async assertDirectory(cwd: string): Promise<void> {
    try {
      if (!(await stat(cwd)).isDirectory()) throw new InvalidRequestError(`cwd가 디렉토리가 아닙니다: ${cwd}`);
    } catch (err) {
      if (err instanceof MamError) throw err;
      throw new InvalidRequestError(`cwd가 존재하지 않습니다: ${cwd}`);
    }
  }

  /** 디스크에서 로드된 세션의 아이템 인덱스·링버퍼·lastSeq 를 이벤트 로그로 복구한다. */
  private ensureLoaded(rt: Runtime): Promise<void> {
    if (rt.loaded) return Promise.resolve();
    rt.loading ??= (async () => {
      for await (const event of rt.log.readSince(0)) {
        this.applyToIndex(rt, event);
        this.pushRing(rt, event);
        if (event.type === "approval.resolved") rt.resolved.add(event.approvalId);
        if (event.seq > rt.session.lastSeq) rt.session.lastSeq = event.seq;
      }
      rt.loaded = true;
    })();
    return rt.loading;
  }

  private async startAgent(rt: Runtime, resumeNativeId: string | undefined): Promise<void> {
    const adapter = this.adapters[rt.session.agent];
    if (!adapter) throw new AgentUnavailableError(`${rt.session.agent} 어댑터를 사용할 수 없습니다`);
    const agent = await adapter.start({
      cwd: rt.session.cwd,
      mode: rt.session.mode,
      model: rt.session.model ?? undefined,
      effort: rt.session.effort ?? undefined,
      resumeNativeId,
    });
    const live: Live = { agent, closing: false };
    rt.live = live;
    if (agent.nativeId && agent.nativeId !== rt.session.nativeId) {
      rt.session.nativeId = agent.nativeId;
      this.schedulePersist(rt);
    }
    void this.pump(rt, live);
  }

  private async pump(rt: Runtime, live: Live): Promise<void> {
    try {
      for await (const event of live.agent.events) {
        if (rt.live !== live) break;
        this.onAgentEvent(rt, event);
      }
    } catch (err) {
      if (rt.live === live) {
        const message = `에이전트 이벤트 스트림 오류: ${errorMessage(err)}`;
        this.emit(rt, () => ({ type: "error", message, recoverable: false }));
        this.failSession(rt, message);
      }
      return;
    }
    if (rt.live === live && !live.closing) {
      rt.live = undefined;
      if (BUSY_STATUSES.has(rt.session.status)) this.failSession(rt, "에이전트 프로세스가 종료되었습니다");
    }
  }

  private onAgentEvent(rt: Runtime, ev: AgentEvent): void {
    switch (ev.type) {
      case "native_id":
        if (rt.session.nativeId !== ev.nativeId) {
          rt.session.nativeId = ev.nativeId;
          this.schedulePersist(rt);
        }
        return;
      case "item.started":
        this.emit(rt, (seq) => ({ type: "item.started", item: { ...ev.item, seq } as TimelineItem }));
        return;
      case "item.delta":
        this.emit(rt, () => ({ type: "item.delta", itemId: ev.itemId, field: ev.field, delta: ev.delta }));
        return;
      case "item.completed": {
        const existing = rt.items.get(ev.item.id);
        this.emit(rt, (seq) => ({
          type: "item.completed",
          item: { ...ev.item, seq: existing?.seq ?? seq } as TimelineItem,
        }));
        return;
      }
      case "approval.requested":
        rt.pending.set(ev.approval.approvalId, ev.approval);
        rt.session.pendingApprovals = rt.pending.size;
        this.emit(rt, () => ({ type: "approval.requested", approval: ev.approval }));
        this.setStatus(rt, "waiting_approval");
        return;
      case "status":
        this.setStatus(rt, ev.status, ev.reason);
        return;
      case "turn.completed":
        this.emit(rt, () => ({
          type: "turn.completed",
          turnId: ev.turnId,
          durationMs: ev.durationMs,
          usage: ev.usage,
          ...(ev.costUsd !== undefined ? { costUsd: ev.costUsd } : {}),
          stopReason: ev.stopReason,
        }));
        this.bumpTurns(rt);
        this.setStatus(rt, "idle");
        return;
      case "error":
        this.emit(rt, () => ({ type: "error", message: ev.message, recoverable: ev.recoverable }));
        if (!ev.recoverable) this.failSession(rt, ev.message);
        return;
      case "usage":
        this.onUsageEvent(rt, ev);
        return;
    }
  }

  /** 델타 누적, 컨텍스트 교체, 모델·effort 반영 → 영속화 → 디바운스된 `session.usage` 발행. */
  private onUsageEvent(rt: Runtime, ev: Extract<AgentEvent, { type: "usage" }>): void {
    const at = this.iso();
    const next = rt.session.usage ? cloneUsage(rt.session.usage) : emptyUsage(at);
    if (ev.delta) {
      next.inputTokens += Math.max(0, ev.delta.inputTokens);
      next.outputTokens += Math.max(0, ev.delta.outputTokens);
      next.cacheReadTokens += Math.max(0, ev.delta.cacheReadTokens);
      next.cacheWriteTokens += Math.max(0, ev.delta.cacheWriteTokens);
      // 비용은 어댑터가 준 델타만 더한다. 한 번도 안 줬으면 null 유지(Codex 구독).
      if (ev.delta.costUsd !== undefined) next.costUsd = (next.costUsd ?? 0) + Math.max(0, ev.delta.costUsd);
    }
    if (ev.context !== undefined) next.context = toContext(ev.context);
    next.updatedAt = at;
    rt.session.usage = next;
    if (ev.model !== undefined) rt.session.model = ev.model;
    if (ev.effort !== undefined) rt.session.effort = ev.effort;
    rt.session.updatedAt = at;
    this.schedulePersist(rt);
    this.scheduleUsageEmit(rt);
  }

  /** `turn.completed` 마다 turns +1. usage 가 없던 세션은 0 으로 시작하는 객체를 만든다. 발행은 usage 이벤트가 한다. */
  private bumpTurns(rt: Runtime): void {
    const at = this.iso();
    const next = rt.session.usage ? cloneUsage(rt.session.usage) : emptyUsage(at);
    next.turns += 1;
    next.updatedAt = at;
    rt.session.usage = next;
    this.schedulePersist(rt);
  }

  /** 마지막 발행 후 300ms 가 지났으면 즉시, 아니면 남은 시간 뒤에 한 번만(마지막 상태로) 발행한다. */
  private scheduleUsageEmit(rt: Runtime): void {
    if (rt.usageTimer) return;
    const elapsed = rt.lastUsageEmitAt === undefined ? Number.POSITIVE_INFINITY : this.now().getTime() - rt.lastUsageEmitAt;
    if (elapsed >= USAGE_DEBOUNCE_MS) {
      this.emitUsage(rt);
      return;
    }
    rt.usageTimer = setTimeout(() => {
      rt.usageTimer = undefined;
      this.emitUsage(rt);
    }, USAGE_DEBOUNCE_MS - elapsed);
    rt.usageTimer.unref?.();
  }

  private emitUsage(rt: Runtime): void {
    const usage = rt.session.usage;
    if (!usage) return;
    rt.lastUsageEmitAt = this.now().getTime();
    this.emit(rt, () => ({ type: "session.usage", usage: cloneUsage(usage) }));
  }

  /** 대기 중인 디바운스 발행을 지금 내보낸다(close/shutdown). */
  private flushUsage(rt: Runtime): void {
    if (!rt.usageTimer) return;
    clearTimeout(rt.usageTimer);
    rt.usageTimer = undefined;
    this.emitUsage(rt);
  }

  /** seq/sessionId/ts 를 붙여 인덱스 갱신 → 링버퍼 → 로그 append → 동기 팬아웃. */
  private emit(rt: Runtime, build: (seq: number) => EventBody): ServerEvent {
    const seq = rt.session.lastSeq + 1;
    rt.session.lastSeq = seq;
    const ts = this.iso();
    const event = { ...build(seq), seq, sessionId: rt.session.id, ts } as ServerEvent;
    this.applyToIndex(rt, event);
    this.pushRing(rt, event);
    rt.lastActivityAt = this.now().getTime();
    rt.session.updatedAt = ts;
    rt.log.append(event).catch((err) => {
      this.logger.warn(`[sessions] 이벤트 로그 기록 실패 session=${rt.session.id} seq=${seq}: ${errorMessage(err)}`);
    });
    for (const listener of [...rt.subscribers]) {
      try {
        listener(event);
      } catch (err) {
        this.logger.warn(`[sessions] 구독자 오류 session=${rt.session.id} seq=${seq}: ${errorMessage(err)}`);
      }
    }
    this.schedulePersist(rt);
    this.armIdleTimer(rt);
    return event;
  }

  private pushRing(rt: Runtime, event: ServerEvent): void {
    rt.ring.push(event);
    if (rt.ring.length > this.ringSize) rt.ring.shift();
  }

  private applyToIndex(rt: Runtime, event: ServerEvent): void {
    switch (event.type) {
      case "item.started":
      case "item.completed": {
        rt.items.set(event.item.id, event.item);
        if (event.item.kind === "assistant_message" && event.item.status === "completed") {
          rt.session.preview = event.item.payload.text.slice(0, PREVIEW_MAX);
        }
        return;
      }
      case "item.delta": {
        const item = rt.items.get(event.itemId);
        if (!item) return;
        const payload = item.payload as Record<string, unknown>;
        if (typeof payload[event.field] === "string") payload[event.field] += event.delta;
        return;
      }
      case "approval.resolved": {
        for (const item of rt.items.values()) {
          if (item.kind === "approval" && item.payload.approvalId === event.approvalId && !item.payload.resolution) {
            item.payload.resolution = { optionId: event.optionId, by: event.by, at: event.ts };
          }
        }
        return;
      }
      default:
        return;
    }
  }

  private setStatus(rt: Runtime, status: SessionStatus, reason?: string, force = false): void {
    if (rt.session.status === status && !force) return;
    rt.session.status = status;
    this.emit(rt, () => ({
      type: "session.status",
      status,
      mode: rt.session.mode,
      ...(reason !== undefined ? { reason } : {}),
    }));
    if (BUSY_STATUSES.has(status)) this.clearIdleTimer(rt);
  }

  private resolvePendingBySystem(rt: Runtime): void {
    for (const approvalId of [...rt.pending.keys()]) {
      rt.pending.delete(approvalId);
      rt.resolved.add(approvalId);
      rt.session.pendingApprovals = rt.pending.size;
      this.emit(rt, () => ({ type: "approval.resolved", approvalId, optionId: "abort", by: "system" }));
    }
  }

  /** 복구 불가 오류: 대기 승인 정리, `error` 상태, 어댑터 세션 폐기. 다음 startTurn 이 nativeId 로 재개한다. */
  private failSession(rt: Runtime, reason: string): void {
    this.resolvePendingBySystem(rt);
    this.setStatus(rt, "error", reason);
    void this.closeLive(rt);
  }

  private async closeLive(rt: Runtime): Promise<void> {
    const live = rt.live;
    if (!live) return;
    live.closing = true;
    rt.live = undefined;
    try {
      await live.agent.close();
    } catch (err) {
      this.logger.warn(`[sessions] 어댑터 세션 종료 실패 session=${rt.session.id}: ${errorMessage(err)}`);
    }
  }

  private armIdleTimer(rt: Runtime): void {
    if (!rt.live || rt.subscribers.size > 0 || rt.session.status !== "idle") return;
    this.clearIdleTimer(rt);
    const remaining = Math.max(0, this.idleTimeoutMs - (this.now().getTime() - rt.lastActivityAt));
    rt.idleTimer = setTimeout(() => {
      rt.idleTimer = undefined;
      void this.onIdleTimer(rt);
    }, remaining);
    rt.idleTimer.unref?.();
  }

  private clearIdleTimer(rt: Runtime): void {
    if (rt.idleTimer) {
      clearTimeout(rt.idleTimer);
      rt.idleTimer = undefined;
    }
  }

  private async onIdleTimer(rt: Runtime): Promise<void> {
    if (!rt.live || rt.subscribers.size > 0 || rt.session.status !== "idle") return;
    if (this.now().getTime() - rt.lastActivityAt < this.idleTimeoutMs) {
      this.armIdleTimer(rt);
      return;
    }
    await this.closeLive(rt);
    this.logger.info(`[sessions] 유휴 종료 session=${rt.session.id}`);
    this.setStatus(rt, "idle", "idle_timeout", true);
  }

  /** 변경을 모아 `<id>.json` 에 원자적으로 쓴다(tmp 후 rename). 진행 중이면 한 번 더 쓴다. */
  private schedulePersist(rt: Runtime): void {
    if (rt.persistDirty) return;
    rt.persistDirty = true;
    rt.persistChain = rt.persistChain.then(async () => {
      rt.persistDirty = false;
      const path = join(this.sessionsDir, `${rt.session.id}.json`);
      const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
      try {
        await writeFile(tmp, JSON.stringify(rt.session, null, 2), "utf8");
        await rename(tmp, path);
      } catch (err) {
        this.logger.warn(`[sessions] 세션 메타 저장 실패 session=${rt.session.id}: ${errorMessage(err)}`);
      }
    });
  }
}
