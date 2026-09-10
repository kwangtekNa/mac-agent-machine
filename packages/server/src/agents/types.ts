import type {
  AgentKind,
  Approval,
  SessionMode,
  SessionStatus,
  TimelineItem,
  TurnInput,
  Usage,
} from "@mam/protocol";

export type { AgentKind };

export interface AgentProbe {
  available: boolean;
  version?: string;
  loggedIn: boolean;
  account?: string | null;
  binPath?: string;
  detail?: string;
}

export interface StartOptions {
  cwd: string;
  mode: SessionMode;
  model?: string;
  /** 사고 수준(2026-09-10 추가). 재시작 시 PATCH 로 저장된 값을 넘긴다. */
  effort?: string;
  resumeNativeId?: string;
}

export interface TokenDelta { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd?: number }
export interface ContextSnapshot { tokens: number; window: number }
/** 구독 한도 창 하나. 라벨은 라우트가 붙인다. */
export interface RateLimitObservation { id: string; usedPercent: number; windowMinutes: number | null; resetsAt: Date | null; rejected?: boolean }
export interface AgentUsageSnapshot { plan: string | null; live: boolean; observedAt: Date | null; limits: RateLimitObservation[] }
export interface AgentModel { id: string; displayName: string; description: string | null; isDefault: boolean; efforts: string[]; defaultEffort: string | null }

/** 판별 유니온의 각 멤버에서 키를 제거한다(일반 `Omit` 은 유니온을 합쳐 버린다). */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** 어댑터 → 매니저. `seq` 없음. 매니저가 붙인다(CLAUDE.md CRITICAL 7). */
export type ItemDraft = DistributiveOmit<TimelineItem, "seq">;

export type AgentEvent =
  | { type: "native_id"; nativeId: string }
  | { type: "item.started"; item: ItemDraft }
  | { type: "item.delta"; itemId: string; field: "text" | "output" | "patch"; delta: string }
  | { type: "item.completed"; item: ItemDraft }
  | { type: "approval.requested"; approval: Approval }
  | { type: "status"; status: SessionStatus; reason?: string }
  | {
      type: "turn.completed";
      turnId: string;
      durationMs: number;
      usage: Usage;
      costUsd?: number;
      stopReason: string;
    }
  | { type: "error"; message: string; recoverable: boolean }
  /**
   * 사용량 관측(2026-09-10). 매니저가 `Session.usage` 에 누적하고 `session.usage` 를 발행한다.
   * `turns` 는 매니저가 `turn.completed` 에서 올리므로 턴 끝 사용량은 `turn.completed` 뒤에 보내라.
   * `context`: null 이면 "모름" 으로 덮어쓰고 undefined 면 유지. `delta` 가 없으면 컨텍스트만 갱신.
   */
  | { type: "usage"; delta?: TokenDelta; context?: ContextSnapshot | null; model?: string; effort?: string };

export interface AgentSession {
  readonly nativeId: string | undefined;
  readonly events: AsyncIterable<AgentEvent>;
  sendTurn(input: TurnInput): Promise<void>;
  interrupt(): Promise<void>;
  respondApproval(
    approvalId: string,
    optionId: string,
    inputs?: Record<string, string>,
    message?: string,
  ): Promise<void>;
  setMode(mode: SessionMode): Promise<void>;
  /** 적용 시점은 어댑터가 정한다(PROTOCOL PATCH). */
  setModel(model: string): Promise<void>;
  setEffort(effort: string): Promise<void>;
  close(): Promise<void>;
}

export interface AgentAdapter {
  readonly kind: AgentKind;
  probe(): Promise<AgentProbe>;
  start(opts: StartOptions): Promise<AgentSession>;
  listModels(): Promise<AgentModel[]>;
  /** 구독 한도. 관측값 없으면 `limits: []`. */
  usage(): Promise<AgentUsageSnapshot>;
}
