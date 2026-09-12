import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import {
  ChangeSetSchema,
  ChangesResponseSchema,
  DispatchStateSchema,
  ErrorResponseSchema,
  MergeResultSchema,
  OkResponseSchema,
  PostRoomMessageResponseSchema,
  RoomDetailResponseSchema,
  SessionDetailResponseSchema,
  SessionsResponseSchema,
  TeamDetailResponseSchema,
  TeamRolesResponseSchema,
  TeamSchema,
  TeamTemplateSchema,
  TeamTemplatesResponseSchema,
  TeamsResponseSchema,
  type MemberInput,
  type Team,
  type TeamTemplate,
} from "@mam/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/agent-host/app.js";
import { TEAM_MEMBERS, makeTeamFixture, waitUntil, type TeamFixture } from "../helpers/team-fixture.js";
import { H, USER } from "./helpers.js";

let fx: TeamFixture;
let app: FastifyInstance;

beforeEach(async () => {
  fx = await makeTeamFixture();
  app = buildApp({
    user: USER,
    email: null,
    home: fx.home,
    workspaceRoot: fx.workspaceRoot,
    manager: fx.manager,
    teams: fx.teams,
    adapters: { claude: fx.claude, codex: fx.codex },
    serverVersion: "0.1.0-test",
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await fx.cleanup();
});

const get = (url: string) => app.inject({ method: "GET", url, headers: H });
const post = (url: string, payload?: unknown) => app.inject({ method: "POST", url, headers: H, ...(payload === undefined ? {} : { payload }) });
const patch = (url: string, payload: unknown) => app.inject({ method: "PATCH", url, headers: H, payload });
const del = (url: string) => app.inject({ method: "DELETE", url, headers: H });

const TEMPLATE_MEMBERS = [
  { name: "민수", handle: "minsu", role: "team-lead", roleLabel: "팀장", emoji: "🧑‍💼", agent: "claude", prompt: "lead", mode: "auto-edit", model: null, effort: null, isLead: true },
  { name: "지연", handle: "jiyeon", role: "developer", roleLabel: "개발자", emoji: "🧑‍💻", agent: "codex", prompt: "dev", mode: "auto-edit", model: "gpt-5-codex", effort: "medium", isLead: false },
];

async function createTeam(over: Partial<{ name: string; members: MemberInput[]; cwd: string }> = {}): Promise<Team> {
  const res = await post("/api/v1/teams", { cwd: over.cwd ?? fx.repo, name: over.name ?? "backend", members: over.members ?? TEAM_MEMBERS });
  expect(res.statusCode).toBe(201);
  return TeamSchema.parse(res.json());
}

const groupRoom = (team: Team) => team.rooms.find((r) => r.kind === "group")!;
const member = (team: Team, name: string) => team.members.find((m) => m.name === name)!;

/** 실행·대기 중 디스패치가 없고 팀원이 전부 idle/error 가 될 때까지 기다린다. */
const quiet = (teamId: string) => async () => {
  const d = TeamDetailResponseSchema.parse((await get(`/api/v1/teams/${teamId}`)).json());
  return d.dispatch.running.length === 0 && d.dispatch.queued.length === 0 && d.team.members.every((m) => m.state === "idle" || m.state === "error");
};

async function readyChange(team: Team) {
  const before = ChangesResponseSchema.parse((await get(`/api/v1/teams/${team.id}/changes`)).json()).changes.length;
  const res = await post(`/api/v1/teams/${team.id}/rooms/${groupRoom(team).id}/messages`, { text: "@지연 write" });
  expect(res.statusCode).toBe(201);
  await waitUntil(quiet(team.id));
  await waitUntil(async () => ChangesResponseSchema.parse((await get(`/api/v1/teams/${team.id}/changes`)).json()).changes.length === before + 1);
  return ChangesResponseSchema.parse((await get(`/api/v1/teams/${team.id}/changes`)).json()).changes.at(-1)!;
}

describe("GET /team-roles", () => {
  it("returns the five presets", async () => {
    const res = await get("/api/v1/team-roles");
    expect(res.statusCode).toBe(200);
    const { roles } = TeamRolesResponseSchema.parse(res.json());
    expect(roles.map((r) => r.id)).toEqual(["developer", "planner", "team-lead", "code-reviewer", "custom"]);
    expect(roles.find((r) => r.id === "custom")!.prompt).toBe("");
  });
});

describe("POST /teams", () => {
  it("creates a team with rooms, worktrees and deferred sessions", async () => {
    const team = await createTeam();
    expect(team).toMatchObject({ name: "backend", cwd: fx.repo, baseBranch: "main", settings: { maxHops: 6, maxConcurrent: 2, contextMaxMessages: 40 } });
    expect(team.members.map((m) => [m.name, m.handle, m.isLead, m.state])).toEqual([
      ["민수", "minsu", true, "idle"],
      ["지연", "jiyeon", false, "idle"],
    ]);
    expect(team.members.every((m) => m.sessionId !== null)).toBe(true);
    expect(team.rooms.map((r) => r.kind)).toEqual(["group", "dm", "dm"]);
  });

  it("400 when there is no lead among several members", async () => {
    const res = await post("/api/v1/teams", { cwd: fx.repo, name: "x", members: TEAM_MEMBERS.map((m) => ({ ...m, isLead: undefined })) });
    expect(res.statusCode).toBe(400);
    expect(ErrorResponseSchema.parse(res.json()).error.code).toBe("invalid_request");
  });

  it("409 on a duplicate member name", async () => {
    const res = await post("/api/v1/teams", { cwd: fx.repo, name: "x", members: [TEAM_MEMBERS[0], { ...TEAM_MEMBERS[1], name: "민 수" }] });
    expect(res.statusCode).toBe(409);
    expect(ErrorResponseSchema.parse(res.json()).error.code).toBe("conflict");
    expect(TeamsResponseSchema.parse((await get("/api/v1/teams")).json()).teams).toEqual([]);
  });

  it("403 when cwd is outside home, 400 when it is not a git repo", async () => {
    const outside = await post("/api/v1/teams", { cwd: "/", name: "x", members: TEAM_MEMBERS });
    expect(outside.statusCode).toBe(403);
    expect(ErrorResponseSchema.parse(outside.json()).error.code).toBe("forbidden");
    const notRepo = await post("/api/v1/teams", { cwd: "~/work/lib", name: "x", members: TEAM_MEMBERS });
    expect(notRepo.statusCode).toBe(400);
    expect(ErrorResponseSchema.parse(notRepo.json()).error.code).toBe("invalid_request");
  });

  it("fills members from templateId when members are omitted; body members win; unknown template is 404", async () => {
    const tpl = TeamTemplateSchema.parse((await post("/api/v1/team-templates", { name: "백엔드 2인", settings: { maxHops: 3 }, members: TEMPLATE_MEMBERS })).json());
    const res = await post("/api/v1/teams", { cwd: "~/work/app", name: "from-template", templateId: tpl.id, members: [] });
    expect(res.statusCode).toBe(201);
    const team = TeamSchema.parse(res.json());
    expect(team.settings.maxHops).toBe(3);
    expect(team.members.map((m) => [m.name, m.handle, m.role, m.agent, m.model, m.effort, m.isLead])).toEqual([
      ["민수", "minsu", "team-lead", "claude", null, null, true],
      ["지연", "jiyeon", "developer", "codex", "gpt-5-codex", "medium", false],
    ]);

    const explicit = await post("/api/v1/teams", { cwd: fx.repo, name: "explicit", templateId: tpl.id, members: [{ name: "솔로", role: "developer", agent: "claude" }] });
    expect(explicit.statusCode).toBe(201);
    expect(TeamSchema.parse(explicit.json()).members.map((m) => m.name)).toEqual(["솔로"]);

    const missing = await post("/api/v1/teams", { cwd: fx.repo, name: "y", templateId: "tpl_01J8ZQ4K5N7P9R3S6T8V0W2XZZ", members: [] });
    expect(missing.statusCode).toBe(404);
    expect(ErrorResponseSchema.parse(missing.json()).error.code).toBe("not_found");
  });
});

describe("teams: list, detail, patch, delete", () => {
  it("GET /teams?cwd= filters, GET /teams/:id includes dispatch and changes, PATCH updates", async () => {
    const team = await createTeam();
    expect(TeamsResponseSchema.parse((await get(`/api/v1/teams?cwd=${encodeURIComponent("~/work/app")}`)).json()).teams.map((t) => t.id)).toEqual([team.id]);
    expect(TeamsResponseSchema.parse((await get(`/api/v1/teams?cwd=${encodeURIComponent(fx.lib)}`)).json()).teams).toEqual([]);
    expect(TeamsResponseSchema.parse((await get("/api/v1/teams")).json()).teams.map((t) => t.id)).toEqual([team.id]);

    const detail = TeamDetailResponseSchema.parse((await get(`/api/v1/teams/${team.id}`)).json());
    expect(detail).toEqual({ team, dispatch: { running: [], queued: [] }, changes: [] });

    const patched = await patch(`/api/v1/teams/${team.id}`, { name: "backend-2", settings: { maxConcurrent: 1 } });
    expect(patched.statusCode).toBe(200);
    expect(TeamSchema.parse(patched.json())).toMatchObject({ name: "backend-2", settings: { maxHops: 6, maxConcurrent: 1 } });

    const missing = await get("/api/v1/teams/team_01J8ZQ4K5N7P9R3S6T8V0W2XZZ");
    expect(missing.statusCode).toBe(404);
    expect(ErrorResponseSchema.parse(missing.json()).error.code).toBe("not_found");
  });

  it("DELETE /teams/:id: 409 on a dirty worktree, keepWorktrees=true unregisters only", async () => {
    const team = await createTeam();
    await writeFile(join(member(team, "지연").worktreePath, "wip.txt"), "wip\n");
    const dirty = await del(`/api/v1/teams/${team.id}`);
    expect(dirty.statusCode).toBe(409);
    expect(ErrorResponseSchema.parse(dirty.json()).error.code).toBe("conflict");
    expect((await get(`/api/v1/teams/${team.id}`)).statusCode).toBe(200);

    const kept = await del(`/api/v1/teams/${team.id}?keepWorktrees=true`);
    expect(kept.statusCode).toBe(200);
    expect(OkResponseSchema.parse(kept.json())).toEqual({ ok: true });
    expect((await get(`/api/v1/teams/${team.id}`)).statusCode).toBe(404);

    const clean = await createTeam({ name: "clean" });
    expect((await del(`/api/v1/teams/${clean.id}`)).statusCode).toBe(200);
    expect(TeamsResponseSchema.parse((await get("/api/v1/teams")).json()).teams).toEqual([]);
  });
});

describe("members", () => {
  it("add → patch → reset → remove; the lead cannot be removed", async () => {
    const team = await createTeam();
    const added = await post(`/api/v1/teams/${team.id}/members`, { name: "수진", role: "code-reviewer", agent: "claude" });
    expect(added.statusCode).toBe(201);
    const withThree = TeamSchema.parse(added.json());
    expect(withThree.members.map((m) => m.name)).toEqual(["민수", "지연", "수진"]);
    expect(withThree.rooms.filter((r) => r.kind === "dm").map((r) => r.name)).toEqual(["민수", "지연", "수진"]);
    const sujin = member(withThree, "수진");
    expect(sujin).toMatchObject({ role: "code-reviewer", roleLabel: "코드 리뷰어", isLead: false });

    const patched = await patch(`/api/v1/teams/${team.id}/members/${sujin.id}`, { name: "수진2", emoji: "🦊", mode: "plan" });
    expect(patched.statusCode).toBe(200);
    expect(member(TeamSchema.parse(patched.json()), "수진2")).toMatchObject({ emoji: "🦊", mode: "plan", handle: sujin.handle });
    const dup = await patch(`/api/v1/teams/${team.id}/members/${sujin.id}`, { name: "민수" });
    expect(dup.statusCode).toBe(409);

    const reset = await post(`/api/v1/teams/${team.id}/members/${sujin.id}/reset`);
    expect(reset.statusCode).toBe(200);
    const afterReset = member(TeamSchema.parse(reset.json()), "수진2");
    expect(afterReset.sessionId).not.toBeNull();
    expect(afterReset.sessionId).not.toBe(sujin.sessionId);
    expect(afterReset.state).toBe("idle");

    const removed = await del(`/api/v1/teams/${team.id}/members/${sujin.id}`);
    expect(removed.statusCode).toBe(200);
    expect(TeamSchema.parse(removed.json()).members.map((m) => m.name)).toEqual(["민수", "지연"]);

    const lead = await del(`/api/v1/teams/${team.id}/members/${member(team, "민수").id}`);
    expect(lead.statusCode).toBe(400);
    const missing = await patch(`/api/v1/teams/${team.id}/members/agt_01J8ZQ4K5N7P9R3S6T8V0W2XZZ`, { emoji: "x" });
    expect(missing.statusCode).toBe(404);
  });

  it("POST /teams/:id/stop returns an empty dispatch state", async () => {
    const team = await createTeam();
    const res = await post(`/api/v1/teams/${team.id}/stop`);
    expect(res.statusCode).toBe(200);
    expect(DispatchStateSchema.parse(res.json())).toEqual({ running: [], queued: [] });
  });
});

describe("rooms", () => {
  it("POST .../messages → 201, then the room detail shows the agent reply", async () => {
    const team = await createTeam();
    const room = groupRoom(team);
    const res = await post(`/api/v1/teams/${team.id}/rooms/${room.id}/messages`, { text: "hello team" });
    expect(res.statusCode).toBe(201);
    const posted = PostRoomMessageResponseSchema.parse(res.json());
    expect(posted.message).toMatchObject({ roomId: room.id, author: { kind: "user" }, kind: "text", text: "hello team", hop: 0, mentions: [] });
    expect(posted.dispatches).toHaveLength(1);

    await waitUntil(quiet(team.id));
    const detail = RoomDetailResponseSchema.parse((await get(`/api/v1/teams/${team.id}/rooms/${room.id}`)).json());
    expect(detail.truncated).toBe(false);
    const reply = detail.messages.find((m) => m.author.kind === "agent" && m.kind === "text");
    expect(reply).toBeDefined();
    expect(reply).toMatchObject({ author: { kind: "agent", memberId: member(team, "민수").id }, hop: 1, text: "완료했습니다: [#전체] 사용자: hello team" });
    expect(reply!.work).toMatchObject({ toolCalls: 1, filesChanged: [] });
    expect(detail.messages[0]).toEqual(posted.message);

    const limited = RoomDetailResponseSchema.parse((await get(`/api/v1/teams/${team.id}/rooms/${room.id}?limit=1`)).json());
    expect(limited.messages).toHaveLength(1);
    expect(limited.truncated).toBe(true);

    const missing = await post(`/api/v1/teams/${team.id}/rooms/room_01J8ZQ4K5N7P9R3S6T8V0W2XZZ/messages`, { text: "x" });
    expect(missing.statusCode).toBe(404);
    const empty = await post(`/api/v1/teams/${team.id}/rooms/${room.id}/messages`, { text: "" });
    expect(empty.statusCode).toBe(400);
  });
});

describe("changes", () => {
  it("list → merge (409 unless ready, then success) → dismiss", async () => {
    const team = await createTeam();
    const first = await readyChange(team);
    expect(first.status).toBe("ready");
    expect(ChangesResponseSchema.parse((await get(`/api/v1/teams/${team.id}/changes`)).json()).changes).toEqual([first]);

    const merged = await post(`/api/v1/teams/${team.id}/changes/${first.id}/merge`);
    expect(merged.statusCode).toBe(200);
    const result = MergeResultSchema.parse(merged.json());
    expect(result.change).toMatchObject({ id: first.id, status: "merged", conflictFiles: [] });
    expect(result.mergeCommit).toMatch(/^[0-9a-f]{40}$/);

    const again = await post(`/api/v1/teams/${team.id}/changes/${first.id}/merge`);
    expect(again.statusCode).toBe(409);
    expect(ErrorResponseSchema.parse(again.json())).toEqual({ error: { code: "conflict", message: expect.any(String) } });

    const second = await readyChange(team);
    const dismissed = await post(`/api/v1/teams/${team.id}/changes/${second.id}/dismiss`);
    expect(dismissed.statusCode).toBe(200);
    expect(ChangeSetSchema.parse(dismissed.json())).toMatchObject({ id: second.id, status: "dismissed" });
    expect((await post(`/api/v1/teams/${team.id}/changes/${second.id}/dismiss`)).statusCode).toBe(409);
    expect((await post(`/api/v1/teams/${team.id}/changes/chg_01J8ZQ4K5N7P9R3S6T8V0W2XZZ/merge`)).statusCode).toBe(404);

    const detail = TeamDetailResponseSchema.parse((await get(`/api/v1/teams/${team.id}`)).json());
    expect(detail.changes.map((c) => c.status)).toEqual(["merged", "dismissed"]);
  });
});

describe("team templates", () => {
  it("CRUD with schema-checked responses and 404s", async () => {
    expect(TeamTemplatesResponseSchema.parse((await get("/api/v1/team-templates")).json())).toEqual({ templates: [] });

    const created = await post("/api/v1/team-templates", { name: "백엔드 2인", members: TEMPLATE_MEMBERS });
    expect(created.statusCode).toBe(201);
    const tpl: TeamTemplate = TeamTemplateSchema.parse(created.json());
    expect(tpl).toMatchObject({ name: "백엔드 2인", settings: { maxHops: 6, maxConcurrent: 2, contextMaxMessages: 40 } });
    expect(tpl.members).toEqual(TEMPLATE_MEMBERS);

    const patched = await patch(`/api/v1/team-templates/${tpl.id}`, { name: "백엔드", settings: { maxHops: 2 } });
    expect(patched.statusCode).toBe(200);
    expect(TeamTemplateSchema.parse(patched.json())).toMatchObject({ id: tpl.id, name: "백엔드", settings: { maxHops: 2, maxConcurrent: 2 }, createdAt: tpl.createdAt });
    expect(TeamTemplatesResponseSchema.parse((await get("/api/v1/team-templates")).json()).templates.map((t) => t.name)).toEqual(["백엔드"]);

    const noLead = await post("/api/v1/team-templates", { name: "x", members: TEMPLATE_MEMBERS.map((m) => ({ ...m, isLead: false })) });
    expect(noLead.statusCode).toBe(400);
    const twoLeads = await patch(`/api/v1/team-templates/${tpl.id}`, { members: TEMPLATE_MEMBERS.map((m) => ({ ...m, isLead: true })) });
    expect(twoLeads.statusCode).toBe(400);

    const removed = await del(`/api/v1/team-templates/${tpl.id}`);
    expect(removed.statusCode).toBe(200);
    expect(OkResponseSchema.parse(removed.json())).toEqual({ ok: true });
    expect((await del(`/api/v1/team-templates/${tpl.id}`)).statusCode).toBe(404);
    expect((await patch(`/api/v1/team-templates/${tpl.id}`, { name: "y" })).statusCode).toBe(404);
    expect(TeamTemplatesResponseSchema.parse((await get("/api/v1/team-templates")).json()).templates).toEqual([]);
  });
});

describe("sessions of team members", () => {
  it("GET /sessions lists member sessions with `team` and without `instructions`", async () => {
    const team = await createTeam();
    const { sessions } = SessionsResponseSchema.parse((await get("/api/v1/sessions")).json());
    expect(sessions).toHaveLength(2);
    for (const m of team.members) {
      const s = sessions.find((x) => x.id === m.sessionId)!;
      expect(s).toBeDefined();
      expect(s.team).toEqual({ teamId: team.id, memberId: m.id });
      expect(s.cwd).toBe(m.worktreePath);
      expect("instructions" in s).toBe(false);
      const detail = SessionDetailResponseSchema.parse((await get(`/api/v1/sessions/${m.sessionId}`)).json());
      expect("instructions" in detail.session).toBe(false);
    }
  });
});
