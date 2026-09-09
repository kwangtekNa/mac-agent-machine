import type { FastifyInstance } from "fastify";
import { AgentKindSchema, MeResponseSchema, PROTOCOL_VERSION, type AgentInfo } from "@mam/protocol";
import type { AgentAdapter, AgentProbe } from "../../agents/types.js";
import { send, type AgentHostRuntime } from "../http.js";

export const PROBE_CACHE_MS = 5_000;

const cache = new WeakMap<AgentAdapter, { at: number; result: Promise<AgentProbe> }>();

/** 5초 캐시된 probe. 실패하면 `available: false`. */
export function probeCached(adapter: AgentAdapter, now = Date.now()): Promise<AgentProbe> {
  const hit = cache.get(adapter);
  if (hit && now - hit.at < PROBE_CACHE_MS) return hit.result;
  const result = adapter.probe().catch((): AgentProbe => ({ available: false, loggedIn: false }));
  cache.set(adapter, { at: now, result });
  return result;
}

export function registerMeRoutes(app: FastifyInstance, host: AgentHostRuntime): void {
  app.get("/me", async (_request, reply) => {
    const agents: AgentInfo[] = [];
    for (const kind of AgentKindSchema.options) {
      const adapter = host.adapters[kind];
      if (!adapter) continue;
      const probe = await probeCached(adapter);
      agents.push({
        kind,
        available: probe.available,
        version: probe.version ?? null,
        loggedIn: probe.loggedIn,
        account: probe.account ?? null,
      });
    }
    return send(host, reply, MeResponseSchema, {
      user: host.user,
      email: host.email ?? "",
      home: host.home,
      workspaceRoot: host.workspaceRoot,
      agents,
      server: { version: host.serverVersion, protocolVersion: PROTOCOL_VERSION },
    });
  });
}
