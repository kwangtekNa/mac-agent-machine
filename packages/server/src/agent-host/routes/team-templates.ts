import type { FastifyInstance } from "fastify";
import {
  CreateTeamTemplateRequestSchema,
  OkResponseSchema,
  PatchTeamTemplateRequestSchema,
  TeamTemplateSchema,
  TeamTemplatesResponseSchema,
  type CreateTeamTemplateRequest,
  type PatchTeamTemplateRequest,
} from "@mam/protocol";
import { send, validate, type AgentHostRuntime } from "../http.js";

interface IdParams {
  id: string;
}

/** PROTOCOL 6.2 템플릿 CRUD. 사용자별 저장(`~/.mam/team-templates/`). */
export function registerTeamTemplatesRoutes(app: FastifyInstance, host: AgentHostRuntime): void {
  app.get("/team-templates", async (_request, reply) => {
    return send(host, reply, TeamTemplatesResponseSchema, { templates: await host.teams.templates.list() });
  });

  app.post("/team-templates", { preHandler: validate({ body: CreateTeamTemplateRequestSchema }) }, async (request, reply) => {
    const template = await host.teams.templates.create(request.body as CreateTeamTemplateRequest);
    return send(host, reply, TeamTemplateSchema, template, 201);
  });

  app.patch<{ Params: IdParams }>("/team-templates/:id", { preHandler: validate({ body: PatchTeamTemplateRequestSchema }) }, async (request, reply) => {
    const template = await host.teams.templates.patch(request.params.id, request.body as PatchTeamTemplateRequest);
    return send(host, reply, TeamTemplateSchema, template);
  });

  app.delete<{ Params: IdParams }>("/team-templates/:id", async (request, reply) => {
    await host.teams.templates.remove(request.params.id);
    return send(host, reply, OkResponseSchema, { ok: true });
  });
}
