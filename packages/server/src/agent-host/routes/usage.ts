import type { FastifyInstance } from "fastify";
import { AgentKindSchema, UsageResponseSchema, type AgentKind, type AgentUsage, type UsageLimit, type UsageLimitStatus } from "@mam/protocol";
import type { AgentAdapter, AgentUsageSnapshot } from "../../agents/types.js";
import { send, type AgentHostRuntime } from "../http.js";

const EMPTY: AgentUsageSnapshot = { plan: null, live: false, observedAt: null, limits: [] };

/** PROTOCOL 1절: `< 80` ok, `>= 80` warning, `>= 100` 또는 거부 상태면 exceeded. */
export function limitStatus(usedPercent: number, rejected: boolean): UsageLimitStatus {
  if (rejected || usedPercent >= 100) return "exceeded";
  if (usedPercent >= 80) return "warning";
  return "ok";
}

/** 창 길이로 라벨을 만들고, 모르면 id 관례(five_hour/primary, seven_day/secondary)를 쓴다. */
export function limitLabel(id: string, windowMinutes: number | null): string {
  if (windowMinutes !== null && windowMinutes > 0) {
    if (windowMinutes === 10080) return "주간";
    if (windowMinutes % 1440 === 0) return `${windowMinutes / 1440}일`;
    if (windowMinutes % 60 === 0) return `${windowMinutes / 60}시간`;
    return `${windowMinutes}분`;
  }
  if (id === "five_hour" || id === "primary") return "5시간";
  if (id === "seven_day" || id === "secondary") return "주간";
  return id;
}

export function toAgentUsage(kind: AgentKind, snapshot: AgentUsageSnapshot): AgentUsage {
  const limits: UsageLimit[] = snapshot.limits.map((l) => {
    const usedPercent = Math.max(0, Math.round(l.usedPercent));
    const windowMinutes = l.windowMinutes !== null && l.windowMinutes >= 1 ? Math.round(l.windowMinutes) : null;
    return {
      id: l.id,
      label: limitLabel(l.id, windowMinutes),
      usedPercent,
      windowMinutes,
      resetsAt: l.resetsAt ? l.resetsAt.toISOString() : null,
      status: limitStatus(usedPercent, l.rejected === true),
    };
  });
  return { kind, plan: snapshot.plan, live: snapshot.live, observedAt: snapshot.observedAt ? snapshot.observedAt.toISOString() : null, limits };
}

async function usageOrEmpty(adapter: AgentAdapter, warn: (msg: string) => void): Promise<AgentUsageSnapshot> {
  try {
    return await adapter.usage();
  } catch (err) {
    warn(`usage 조회 실패 agent=${adapter.kind}: ${err instanceof Error ? err.message : String(err)}`);
    return EMPTY;
  }
}

export function registerUsageRoutes(app: FastifyInstance, host: AgentHostRuntime): void {
  app.get("/usage", async (request, reply) => {
    const kinds = AgentKindSchema.options.filter((kind) => host.adapters[kind] !== undefined);
    const snapshots = await Promise.all(kinds.map((kind) => usageOrEmpty(host.adapters[kind]!, (msg) => request.log.warn(msg))));
    return send(host, reply, UsageResponseSchema, { agents: kinds.map((kind, i) => toAgentUsage(kind, snapshots[i]!)) });
  });
}
