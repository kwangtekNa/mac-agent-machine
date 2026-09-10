import type { Approval, SessionMode, TurnInput } from "@mam/protocol";
import { ulid } from "ulid";
import { newId } from "../../ids.js";
import type { AgentEvent, AgentModel, AgentSession, ItemDraft, StartOptions } from "../types.js";
import { AsyncQueue } from "./async-queue.js";
import type { ApprovalResponse, FakeScript, ScriptContext } from "./script.js";

/** Fake 모델 목록. `fake-1` 기본(effort 지원), `fake-mini` 는 effort 미지원. */
export const FAKE_MODELS: readonly AgentModel[] = [
  { id: "fake-1", displayName: "Fake 1", description: "테스트용 기본 모델", isDefault: true, efforts: ["low", "medium", "high"], defaultEffort: "medium" },
  { id: "fake-mini", displayName: "Fake Mini", description: null, isDefault: false, efforts: [], defaultEffort: null },
];

function supportsEffort(model: string): boolean {
  return (FAKE_MODELS.find((m) => m.id === model)?.efforts.length ?? 0) > 0;
}

export interface FakeSessionConfig {
  autoApprove: boolean;
  delayMs: number;
  script: FakeScript;
  now: () => Date;
}

interface PendingApproval {
  approval: Approval;
  resolve: (response: ApprovalResponse) => void;
  reject: (error: Error) => void;
}

interface Turn {
  abort: AbortController;
  /** 시작됐지만 완료되지 않은 아이템. interrupt 시 `cancelled` 로 닫는다. */
  open: Map<string, ItemDraft>;
  done: Promise<void>;
}

function abortError(): Error {
  const err = new Error("interrupted");
  err.name = "AbortError";
  return err;
}

export class FakeSession implements AgentSession {
  readonly nativeId: string;
  readonly events: AsyncIterable<AgentEvent>;
  /** 테스트 검증용: 받은 턴 입력과 모드 변경 이력. */
  readonly turns: TurnInput[] = [];
  readonly modes: SessionMode[] = [];
  /** 테스트 검증용: setModel/setEffort 이력. */
  readonly models: string[] = [];
  readonly efforts: string[] = [];

  private readonly queue = new AsyncQueue<AgentEvent>();
  private readonly pending = new Map<string, PendingApproval>();
  private mode: SessionMode;
  private model: string;
  private effort: string | undefined;
  private turn: Turn | undefined;
  private closedFlag = false;

  constructor(
    readonly options: StartOptions,
    private readonly config: FakeSessionConfig,
  ) {
    this.nativeId = options.resumeNativeId ?? `fake-${ulid()}`;
    this.mode = options.mode;
    this.model = options.model ?? FAKE_MODELS[0]!.id;
    this.effort = supportsEffort(this.model) ? options.effort : undefined;
    this.events = this.queue;
    this.queue.push({ type: "native_id", nativeId: this.nativeId });
  }

  get closed(): boolean {
    return this.closedFlag;
  }

  get currentMode(): SessionMode {
    return this.mode;
  }

  async sendTurn(input: TurnInput): Promise<void> {
    if (this.closedFlag) throw new Error("fake session is closed");
    if (this.turn) throw new Error("fake session is busy");
    this.turns.push(input);

    const abort = new AbortController();
    const turn: Turn = { abort, open: new Map(), done: Promise.resolve() };
    this.turn = turn;
    const ctx = this.makeContext(input, turn);
    turn.done = this.run(ctx, turn);
  }

  async interrupt(): Promise<void> {
    const turn = this.turn;
    if (!turn) return;
    turn.abort.abort();
    for (const p of this.pending.values()) p.reject(abortError());
    this.pending.clear();
    await turn.done;
  }

  async respondApproval(
    approvalId: string,
    optionId: string,
    inputs?: Record<string, string>,
    message?: string,
  ): Promise<void> {
    const pending = this.pending.get(approvalId);
    if (!pending) throw new Error(`unknown approval: ${approvalId}`);
    if (!pending.approval.options.some((o) => o.id === optionId)) {
      throw new Error(`unknown option ${optionId} for approval ${approvalId}`);
    }
    this.pending.delete(approvalId);
    pending.resolve({ optionId, inputs, message });
  }

  async setMode(mode: SessionMode): Promise<void> {
    this.mode = mode;
    this.modes.push(mode);
  }

  /** 기록만 하고 다음 usage 이벤트의 `model` 에 반영. effort 미지원 모델이면 effort 를 지운다. */
  async setModel(model: string): Promise<void> {
    this.model = model;
    this.models.push(model);
    if (!supportsEffort(model)) this.effort = undefined;
  }

  async setEffort(effort: string): Promise<void> {
    this.effort = effort;
    this.efforts.push(effort);
  }

  async close(): Promise<void> {
    if (this.closedFlag) return;
    this.closedFlag = true;
    await this.interrupt();
    this.queue.end();
  }

  private makeContext(input: TurnInput, turn: Turn): ScriptContext {
    const { signal } = turn.abort;
    const emit = (event: AgentEvent): void => {
      if (signal.aborted || this.closedFlag) return;
      this.track(turn, event);
      this.queue.push(event);
    };
    return {
      input,
      turnId: newId("trn"),
      nativeId: this.nativeId,
      mode: this.mode,
      turnNumber: this.turns.length,
      model: this.model,
      effort: this.effort,
      autoApprove: this.config.autoApprove,
      signal,
      now: () => this.config.now().toISOString(),
      emit,
      delay: () => this.delay(signal),
      requestApproval: (approval) =>
        new Promise<ApprovalResponse>((resolve, reject) => {
          if (signal.aborted) {
            reject(abortError());
            return;
          }
          this.pending.set(approval.approvalId, { approval, resolve, reject });
        }),
    };
  }

  private track(turn: Turn, event: AgentEvent): void {
    if (event.type === "item.started" && event.item.status === "running") {
      turn.open.set(event.item.id, event.item);
    } else if (event.type === "item.completed") {
      turn.open.delete(event.item.id);
    }
  }

  private async run(ctx: ScriptContext, turn: Turn): Promise<void> {
    try {
      await this.config.script(ctx);
    } catch (err) {
      if (turn.abort.signal.aborted) {
        if (!this.closedFlag) {
          const at = this.config.now().toISOString();
          for (const item of turn.open.values()) {
            this.queue.push({
              type: "item.completed",
              item: { ...item, status: "cancelled", completedAt: at } as ItemDraft,
            });
          }
          this.queue.push({ type: "status", status: "idle", reason: "interrupted" });
        }
      } else {
        const message = err instanceof Error ? err.message : String(err);
        this.queue.push({ type: "error", message, recoverable: true });
        this.queue.push({ type: "status", status: "idle", reason: "script_error" });
      }
    } finally {
      if (this.turn === turn) this.turn = undefined;
    }
  }

  private async delay(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw abortError();
    if (this.config.delayMs <= 0) {
      await Promise.resolve();
      if (signal.aborted) throw abortError();
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, this.config.delayMs);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
