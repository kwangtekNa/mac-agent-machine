import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { ZodError } from "zod";
import { PROTOCOL_VERSION } from "@mam/protocol";
import { MamError } from "../errors.js";
import { FsError } from "../fs/read.js";
import { formatIssues, type AgentHostContext, type AgentHostRuntime } from "./http.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerFsRoutes } from "./routes/fs.js";
import { registerGitRoutes } from "./routes/git.js";
import { registerMeRoutes } from "./routes/me.js";
import { registerModelsRoutes } from "./routes/models.js";
import { registerUsageRoutes } from "./routes/usage.js";
import { registerProjectsRoutes } from "./routes/projects.js";
import { registerSessionsRoutes } from "./routes/sessions.js";
import { registerTeamRolesRoutes } from "./routes/team-roles.js";
import { registerTeamTemplatesRoutes } from "./routes/team-templates.js";
import { registerTeamsRoutes } from "./routes/teams.js";
import { registerRoomWsRoutes } from "./ws-rooms.js";
import { registerWsRoutes, type WsOptions } from "./ws.js";

export type { AgentHostContext } from "./http.js";

export const API_PREFIX = "/api/v1";

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function buildApp(ctx: AgentHostContext, opts: { ws?: WsOptions } = {}): FastifyInstance {
  const host: AgentHostRuntime = {
    ...ctx,
    validateResponses: ctx.validateResponses ?? process.env.NODE_ENV !== "production",
  };
  const logger = ctx.logger;
  const app =
    logger !== undefined && typeof logger === "object" && "info" in logger && typeof logger.info === "function"
      ? Fastify({ loggerInstance: logger, forceCloseConnections: true })
      : Fastify({ logger: (logger as Exclude<typeof logger, { info: unknown }>) ?? false, forceCloseConnections: true });

  // CRITICAL 1: 신원은 gateway 가 덮어쓴 X-MAM-User 뿐이며, 프로세스 사용자와 같은지만 확인한다.
  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/healthz") return;
    const protocol = headerValue(request.headers["x-mam-protocol"]);
    if (protocol !== undefined && protocol !== String(PROTOCOL_VERSION)) {
      reply.code(426).send({ error: { code: "invalid_request", message: "unsupported protocol version" } });
      return reply;
    }
    const user = headerValue(request.headers["x-mam-user"]);
    if (!user || user !== host.user) {
      reply.code(403).send({ error: { code: "forbidden", message: "user mismatch" } });
      return reply;
    }
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: { code: "not_found", message: `route not found: ${request.method} ${request.url}` } });
  });

  app.setErrorHandler((err: unknown, request, reply) => {
    if (err instanceof MamError) return reply.code(err.status).send(err.toResponse());
    if (err instanceof FsError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: { code: "invalid_request", message: formatIssues(err.issues) } });
    }
    const status = typeof (err as { statusCode?: unknown }).statusCode === "number" ? (err as { statusCode: number }).statusCode : 500;
    if (status >= 400 && status < 500) {
      const message = err instanceof Error ? err.message : "bad request";
      return reply.code(status).send({ error: { code: status === 404 ? "not_found" : "invalid_request", message } });
    }
    request.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: { code: "internal", message: "internal error" } });
  });

  app.get("/healthz", async () => ({ ok: true, user: host.user }));

  app.register(websocket);
  app.register(
    async (api) => {
      registerMeRoutes(api, host);
      registerProjectsRoutes(api, host);
      registerSessionsRoutes(api, host);
      registerFsRoutes(api, host);
      registerGitRoutes(api, host);
      registerAuthRoutes(api, host);
      registerUsageRoutes(api, host);
      registerModelsRoutes(api, host);
      registerWsRoutes(api, host, opts.ws);
      registerTeamRolesRoutes(api, host);
      registerTeamsRoutes(api, host);
      registerTeamTemplatesRoutes(api, host);
      registerRoomWsRoutes(api, host, opts.ws);
    },
    { prefix: API_PREFIX },
  );

  return app;
}
