import type { FastifyInstance } from "fastify";
import type { AgentHostRuntime } from "../http.js";

/** step 9 가 실제 로그인 플로우로 교체한다. 지금은 501 + SSH 안내. */
export function registerAuthRoutes(app: FastifyInstance, _host: AgentHostRuntime): void {
  const notAvailable = { error: { code: "internal", message: "login flow not available; use ssh" } };
  app.post("/auth/:agent/login", async (_request, reply) => reply.code(501).send(notAvailable));
  app.post("/auth/:agent/login/:flowId/code", async (_request, reply) => reply.code(501).send(notAvailable));
  app.get("/auth/:agent/login/:flowId", async (_request, reply) => reply.code(501).send(notAvailable));
}
