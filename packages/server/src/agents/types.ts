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
  resumeNativeId?: string;
}

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
  | { type: "error"; message: string; recoverable: boolean };

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
  close(): Promise<void>;
}

export interface AgentAdapter {
  readonly kind: AgentKind;
  probe(): Promise<AgentProbe>;
  start(opts: StartOptions): Promise<AgentSession>;
}
