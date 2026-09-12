import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ChangeSetSchema,
  ChangesResponseSchema,
  CreateTeamRequestSchema,
  DispatchStateSchema,
  MemberInputSchema,
  MergeResultSchema,
  OkResponseSchema,
  PatchMemberRequestSchema,
  PatchTeamRequestSchema,
  PostRoomMessageRequestSchema,
  PostRoomMessageResponseSchema,
  RoomDetailResponseSchema,
  TeamDetailResponseSchema,
  TeamSchema,
  TeamsResponseSchema,
  type MemberInput,
  type PatchMemberRequest,
  type PatchTeamRequest,
  type PostRoomMessageRequest,
  type TeamTemplateMember,
} from "@mam/protocol";
import { InvalidRequestError } from "../../errors.js";
import { resolveInsideHome, statResolved } from "../../fs/sandbox.js";
import { send, validate, type AgentHostRuntime } from "../http.js";

/**
 * PROTOCOL 6.2 팀 REST. 신원·권한 검사는 없다(agent-host 는 이미 한 사용자에 고정, CRITICAL 1).
 * `cwd` 는 `resolveInsideHome` 을 거친 realpath 만 TeamManager 에 넘긴다(CRITICAL 3). 승인 응답은 기존 `/sessions/:id/approvals/:approvalId`.
 */

/** `templateId` 로 팀원을 채울 수 있게 `members` 생략·빈 배열을 허용한다(프로토콜 스키마는 min(1)). */
const CreateTeamBodySchema = CreateTeamRequestSchema.extend({ members: z.array(MemberInputSchema).default([]) });
type CreateTeamBody = z.infer<typeof CreateTeamBodySchema>;

const ListQuerySchema = z.object({ cwd: z.string().min(1).optional() });
type ListQuery = z.infer<typeof ListQuerySchema>;
/** `"true"` 만 참. */
const KeepWorktreesQuerySchema = z.object({ keepWorktrees: z.string().optional() });
const KeepWorktreeQuerySchema = z.object({ keepWorktree: z.string().optional() });
const RoomQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(1000).optional() });
type RoomQuery = z.infer<typeof RoomQuerySchema>;

interface IdParams {
  id: string;
}
interface MemberParams extends IdParams {
  memberId: string;
}
interface RoomParams extends IdParams {
  roomId: string;
}
interface ChangeParams extends IdParams {
  changeId: string;
}

function isTrue(value: string | undefined): boolean {
  return value === "true";
}

function templateMemberToInput(m: TeamTemplateMember): MemberInput {
  return {
    name: m.name,
    handle: m.handle,
    role: m.role,
    roleLabel: m.roleLabel,
    emoji: m.emoji,
    agent: m.agent,
    prompt: m.prompt,
    mode: m.mode,
    isLead: m.isLead,
    ...(m.model !== null ? { model: m.model } : {}),
    ...(m.effort !== null ? { effort: m.effort } : {}),
  };
}

export function registerTeamsRoutes(app: FastifyInstance, host: AgentHostRuntime): void {
  app.get("/teams", { preHandler: validate({ query: ListQuerySchema }) }, async (request, reply) => {
    const { cwd } = request.query as ListQuery;
    const resolved = cwd === undefined ? undefined : await resolveInsideHome(host.home, cwd);
    return send(host, reply, TeamsResponseSchema, { teams: host.teams.listTeams(resolved) });
  });

  app.post("/teams", { preHandler: validate({ body: CreateTeamBodySchema }) }, async (request, reply) => {
    const body = request.body as CreateTeamBody;
    // CRITICAL 3: cwd 는 홈 안의 실제 디렉토리여야 한다(403/404/400). git 검사는 TeamManager(400).
    const cwd = await resolveInsideHome(host.home, body.cwd);
    if (!(await statResolved(cwd)).isDirectory()) throw new InvalidRequestError("cwd 는 디렉토리여야 합니다");
    let members = body.members;
    if (members.length === 0) {
      if (body.templateId === undefined) throw new InvalidRequestError("팀원이 최소 한 명 필요합니다");
      members = (await host.teams.templates.get(body.templateId)).members.map(templateMemberToInput);
    }
    const team = await host.teams.createTeam({ ...body, cwd, members });
    return send(host, reply, TeamSchema, team, 201);
  });

  app.get<{ Params: IdParams }>("/teams/:id", async (request, reply) => {
    return send(host, reply, TeamDetailResponseSchema, host.teams.detail(request.params.id));
  });

  app.patch<{ Params: IdParams }>("/teams/:id", { preHandler: validate({ body: PatchTeamRequestSchema }) }, async (request, reply) => {
    return send(host, reply, TeamSchema, await host.teams.patchTeam(request.params.id, request.body as PatchTeamRequest));
  });

  app.delete<{ Params: IdParams }>("/teams/:id", { preHandler: validate({ query: KeepWorktreesQuerySchema }) }, async (request, reply) => {
    const { keepWorktrees } = request.query as z.infer<typeof KeepWorktreesQuerySchema>;
    await host.teams.deleteTeam(request.params.id, { keepWorktrees: isTrue(keepWorktrees) });
    return send(host, reply, OkResponseSchema, { ok: true });
  });

  app.post<{ Params: IdParams }>("/teams/:id/members", { preHandler: validate({ body: MemberInputSchema }) }, async (request, reply) => {
    return send(host, reply, TeamSchema, await host.teams.addMember(request.params.id, request.body as MemberInput), 201);
  });

  app.patch<{ Params: MemberParams }>("/teams/:id/members/:memberId", { preHandler: validate({ body: PatchMemberRequestSchema }) }, async (request, reply) => {
    const { id, memberId } = request.params;
    return send(host, reply, TeamSchema, await host.teams.patchMember(id, memberId, request.body as PatchMemberRequest));
  });

  app.delete<{ Params: MemberParams }>("/teams/:id/members/:memberId", { preHandler: validate({ query: KeepWorktreeQuerySchema }) }, async (request, reply) => {
    const { id, memberId } = request.params;
    const { keepWorktree } = request.query as z.infer<typeof KeepWorktreeQuerySchema>;
    return send(host, reply, TeamSchema, await host.teams.removeMember(id, memberId, { keepWorktree: isTrue(keepWorktree) }));
  });

  app.post<{ Params: MemberParams }>("/teams/:id/members/:memberId/reset", async (request, reply) => {
    const { id, memberId } = request.params;
    return send(host, reply, TeamSchema, await host.teams.resetMember(id, memberId));
  });

  app.post<{ Params: IdParams }>("/teams/:id/stop", async (request, reply) => {
    return send(host, reply, DispatchStateSchema, await host.teams.stop(request.params.id));
  });

  app.get<{ Params: RoomParams }>("/teams/:id/rooms/:roomId", { preHandler: validate({ query: RoomQuerySchema }) }, async (request, reply) => {
    const { id, roomId } = request.params;
    const { limit } = request.query as RoomQuery;
    return send(host, reply, RoomDetailResponseSchema, await host.teams.roomDetail(id, roomId, limit));
  });

  app.post<{ Params: RoomParams }>("/teams/:id/rooms/:roomId/messages", { preHandler: validate({ body: PostRoomMessageRequestSchema }) }, async (request, reply) => {
    const { id, roomId } = request.params;
    const result = await host.teams.postUserMessage(id, roomId, request.body as PostRoomMessageRequest);
    return send(host, reply, PostRoomMessageResponseSchema, result, 201);
  });

  app.get<{ Params: IdParams }>("/teams/:id/changes", async (request, reply) => {
    return send(host, reply, ChangesResponseSchema, { changes: host.teams.listChanges(request.params.id) });
  });

  // 409(ready 아님·더러운 베이스·다른 브랜치)는 TeamManager 의 ConflictError 가 그대로 봉투가 된다. 충돌은 200 + status conflict.
  app.post<{ Params: ChangeParams }>("/teams/:id/changes/:changeId/merge", async (request, reply) => {
    const { id, changeId } = request.params;
    return send(host, reply, MergeResultSchema, await host.teams.merge(id, changeId));
  });

  app.post<{ Params: ChangeParams }>("/teams/:id/changes/:changeId/dismiss", async (request, reply) => {
    const { id, changeId } = request.params;
    return send(host, reply, ChangeSetSchema, await host.teams.dismiss(id, changeId));
  });
}
