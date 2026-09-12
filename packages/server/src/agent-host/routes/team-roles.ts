import type { FastifyInstance } from "fastify";
import { TeamRolesResponseSchema } from "@mam/protocol";
import { ROLE_PRESETS } from "../../teams/roles.js";
import { send, type AgentHostRuntime } from "../http.js";

export function registerTeamRolesRoutes(app: FastifyInstance, host: AgentHostRuntime): void {
  app.get("/team-roles", async (_request, reply) => send(host, reply, TeamRolesResponseSchema, { roles: ROLE_PRESETS }));
}
