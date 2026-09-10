import type { AgentKind } from "@mam/protocol";
import type { AgentAdapter, AgentModel, AgentProbe, AgentUsageSnapshot, StartOptions } from "../types.js";
import { defaultScript, type FakeScript } from "./script.js";
import { FAKE_MODELS, FakeSession } from "./session.js";

export interface FakeAdapterOptions {
  /** 어댑터 종류. 기본 `claude`. */
  kind?: AgentKind;
  /** 승인 요청 없이 진행한다. */
  autoApprove?: boolean;
  /** 스크립트 단계 사이 지연(ms). 기본 0(마이크로태스크만). */
  delayMs?: number;
  /** 턴마다 재생할 커스텀 스크립트. 기본 `defaultScript`. */
  script?: FakeScript;
  now?: () => Date;
  probe?: Partial<AgentProbe>;
}

/** 테스트·개발 스모크용 어댑터. 스크립트된 이벤트를 재생하고 승인 요청을 만든다. */
export class FakeAdapter implements AgentAdapter {
  readonly kind: AgentKind;
  /** 테스트 검증용: `start()` 가 받은 옵션 이력. */
  readonly startCalls: StartOptions[] = [];
  readonly sessions: FakeSession[] = [];

  constructor(private readonly options: FakeAdapterOptions = {}) {
    this.kind = options.kind ?? "claude";
  }

  async probe(): Promise<AgentProbe> {
    return {
      available: true,
      version: "fake",
      loggedIn: true,
      account: "fake@example.com",
      ...this.options.probe,
    };
  }

  async start(opts: StartOptions): Promise<FakeSession> {
    this.startCalls.push({ ...opts });
    const session = new FakeSession(opts, {
      autoApprove: this.options.autoApprove ?? false,
      delayMs: this.options.delayMs ?? 0,
      script: this.options.script ?? defaultScript,
      now: this.options.now ?? (() => new Date()),
    });
    this.sessions.push(session);
    return session;
  }

  async listModels(): Promise<AgentModel[]> {
    return FAKE_MODELS.map((m) => ({ ...m, efforts: [...m.efforts] }));
  }

  /** 고정 한도 두 개: 5시간 42%(ok), 주간 81%(warning). */
  async usage(): Promise<AgentUsageSnapshot> {
    const now = (this.options.now ?? (() => new Date()))();
    const at = now.getTime();
    return {
      plan: "fake",
      live: true,
      observedAt: now,
      limits: [
        { id: "five_hour", usedPercent: 42, windowMinutes: 300, resetsAt: new Date(at + 3 * 3600_000) },
        { id: "seven_day", usedPercent: 81, windowMinutes: 10080, resetsAt: new Date(at + 4 * 86400_000) },
      ],
    };
  }
}

export { FAKE_MODELS, FakeSession } from "./session.js";
export { defaultScript, FAKE_FAIL_MESSAGE } from "./script.js";
export type { ApprovalResponse, FakeScript, ScriptContext } from "./script.js";
