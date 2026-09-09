import type { AgentKind } from "@mam/protocol";
import type { AgentAdapter, AgentProbe, StartOptions } from "../types.js";
import { defaultScript, type FakeScript } from "./script.js";
import { FakeSession } from "./session.js";

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
}

export { FakeSession } from "./session.js";
export { defaultScript, FAKE_FAIL_MESSAGE } from "./script.js";
export type { ApprovalResponse, FakeScript, ScriptContext } from "./script.js";
