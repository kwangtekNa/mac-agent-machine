import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ApprovalRespondRequestSchema,
  CreateSessionRequestSchema,
  OkResponseSchema,
  PatchSessionRequestSchema,
  SessionDetailResponseSchema,
  SessionSchema,
  SessionStatusSchema,
  SessionsResponseSchema,
  type ApprovalRespondRequest,
  type CreateSessionRequest,
  type PatchSessionRequest,
} from "@mam/protocol";
import { InvalidRequestError } from "../../errors.js";
import { resolveInsideHome, statResolved } from "../../fs/sandbox.js";
import { send, validate, type AgentHostRuntime } from "../http.js";

const ListQuerySchema = z.object({
  cwd: z.string().min(1).optional(),
  status: SessionStatusSchema.optional(),
});
type ListQuery = z.infer<typeof ListQuerySchema>;

interface IdParams {
  id: string;
}

export function registerSessionsRoutes(app: FastifyInstance, host: AgentHostRuntime): void {
  app.get("/sessions", { preHandler: validate({ query: ListQuerySchema }) }, async (request, reply) => {
    const query = request.query as ListQuery;
    return send(host, reply, SessionsResponseSchema, { sessions: host.manager.list(query) });
  });

  app.post("/sessions", { preHandler: validate({ body: CreateSessionRequestSchema }) }, async (request, reply) => {
    const body = request.body as CreateSessionRequest;
    // CRITICAL 3: cwd 는 홈 안의 실제 디렉토리여야 한다(403/404/400).
    const cwd = await resolveInsideHome(host.home, body.cwd);
    if (!(await statResolved(cwd)).isDirectory()) throw new InvalidRequestError("cwd 는 디렉토리여야 합니다");
    const session = await host.manager.create({ ...body, cwd, mode: body.mode ?? "ask" });
    return send(host, reply, SessionSchema, session, 201);
  });

  app.get<{ Params: IdParams }>("/sessions/:id", async (request, reply) => {
    return send(host, reply, SessionDetailResponseSchema, await host.manager.detail(request.params.id));
  });

  app.patch<{ Params: IdParams }>(
    "/sessions/:id",
    { preHandler: validate({ body: PatchSessionRequestSchema }) },
    async (request, reply) => {
      const session = await host.manager.patch(request.params.id, request.body as PatchSessionRequest);
      return send(host, reply, SessionSchema, session);
    },
  );

  app.post<{ Params: IdParams }>("/sessions/:id/close", async (request, reply) => {
    return send(host, reply, SessionSchema, await host.manager.close(request.params.id));
  });

  app.post<{ Params: IdParams & { approvalId: string } }>(
    "/sessions/:id/approvals/:approvalId",
    { preHandler: validate({ body: ApprovalRespondRequestSchema }) },
    async (request, reply) => {
      const body = request.body as ApprovalRespondRequest;
      const { id, approvalId } = request.params;
      if (body.approvalId !== undefined && body.approvalId !== approvalId) {
        throw new InvalidRequestError("approvalId 가 URL 과 다릅니다");
      }
      await host.manager.respondApproval(id, approvalId, body.optionId, body.inputs, body.message);
      return send(host, reply, OkResponseSchema, { ok: true });
    },
  );
}
