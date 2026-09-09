import type { AgentKind } from "@mam/protocol";
import { newId } from "../../ids.js";

export type FlowStatus = "pending" | "done" | "error";

/** 진행 중인 로그인 플로우(PROTOCOL 1절). 구현별로 `submitCode` 유무가 다르다. */
export interface LoginFlow {
  id: string;
  agent: AgentKind;
  url: string;
  instructions: string;
  needsCode: boolean;
  status: FlowStatus;
  message?: string;
  submitCode?(code: string): Promise<void>;
  cancel(): void;
  createdAt: number;
}

/** id 를 받아 플로우를 시작한다. 시작 불가(바이너리 없음 등)는 `AgentUnavailableError` 로 throw. */
export type LoginStarter = (id: string) => Promise<LoginFlow>;

export const DEFAULT_FLOW_TTL_MS = 15 * 60 * 1000;

/** 에이전트당 pending 1개. TTL 이 지난 플로우는 조회 시 cancel 후 제거한다. */
export class FlowRegistry {
  private readonly flows = new Map<string, LoginFlow>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_FLOW_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  async start(agent: AgentKind, starter: LoginStarter): Promise<LoginFlow> {
    for (const [id, existing] of this.flows) {
      if (existing.agent !== agent) continue;
      if (existing.status === "pending") existing.cancel();
      this.flows.delete(id);
    }
    const flow = await starter(newId("flw"));
    flow.createdAt = this.now();
    this.flows.set(flow.id, flow);
    return flow;
  }

  get(id: string): LoginFlow | undefined {
    const flow = this.flows.get(id);
    if (!flow) return undefined;
    if (this.now() - flow.createdAt > this.ttlMs) {
      if (flow.status === "pending") flow.cancel();
      this.flows.delete(id);
      return undefined;
    }
    return flow;
  }

  cancelAll(): void {
    for (const flow of this.flows.values()) if (flow.status === "pending") flow.cancel();
    this.flows.clear();
  }
}
