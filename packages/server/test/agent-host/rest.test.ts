import type { FastifyInstance } from "fastify";
import { MeResponseSchema, ProjectsResponseSchema, type Session } from "@mam/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/agent-host/app.js";
import { H, USER, makeFixture, until, type Fixture } from "./helpers.js";

let fx: Fixture;
let app: FastifyInstance;

beforeEach(async () => {
  fx = await makeFixture();
  app = buildApp({
    user: USER,
    email: "alice@example.com",
    home: fx.home,
    workspaceRoot: fx.workspaceRoot,
    manager: fx.manager,
    adapters: { claude: fx.adapter },
    serverVersion: "0.1.0-test",
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await fx.cleanup();
});

const get = (url: string, headers: Record<string, string> = H) => app.inject({ method: "GET", url, headers });
const post = (url: string, payload?: unknown, headers: Record<string, string> = H) =>
  app.inject({ method: "POST", url, headers, ...(payload === undefined ? {} : { payload }) });

async function createSession(): Promise<Session> {
  const res = await post("/api/v1/sessions", { agent: "claude", cwd: "~/work/app" });
  expect(res.statusCode).toBe(201);
  return res.json();
}

describe("identity and protocol headers", () => {
  it("healthz needs no headers", async () => {
    const res = await get("/healthz", {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, user: USER });
  });

  it("403 when X-MAM-User is missing or different", async () => {
    const missing = await get("/api/v1/me", { "x-mam-protocol": "1" });
    expect(missing.statusCode).toBe(403);
    expect(missing.json()).toEqual({ error: { code: "forbidden", message: expect.any(String) } });
    const other = await get("/api/v1/me", { "x-mam-user": USER + "x", "x-mam-protocol": "1" });
    expect(other.statusCode).toBe(403);
  });

  it("426 on unsupported protocol version", async () => {
    const res = await get("/api/v1/me", { "x-mam-user": USER, "x-mam-protocol": "2" });
    expect(res.statusCode).toBe(426);
    expect(res.json().error.code).toBe("invalid_request");
  });

  it("404 with error shape for unknown routes", async () => {
    const res = await get("/api/v1/nope");
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });
});

describe("GET /me and /projects", () => {
  it("returns identity and probed agents", async () => {
    const res = await get("/api/v1/me");
    expect(res.statusCode).toBe(200);
    const body = MeResponseSchema.parse(res.json());
    expect(body.user).toBe(USER);
    expect(body.home).toBe(fx.home);
    expect(body.workspaceRoot).toBe(fx.workspaceRoot);
    expect(body.agents).toEqual([{ kind: "claude", available: true, version: "fake", loggedIn: true, account: "fake@example.com" }]);
    expect(body.server).toEqual({ version: "0.1.0-test", protocolVersion: 1 });
  });

  it("lists workspace dirs merged with session cwds", async () => {
    await createSession();
    const res = await get("/api/v1/projects");
    const { projects } = ProjectsResponseSchema.parse(res.json());
    expect(projects.map((p) => p.name)).toEqual(["app", "lib"]);
    expect(projects[0]).toMatchObject({ path: fx.app, isGitRepo: true, sessionCount: 1 });
    expect(projects[0]!.lastSessionAt).not.toBeNull();
    expect(projects[1]).toMatchObject({ isGitRepo: false, sessionCount: 0, lastSessionAt: null });
  });
});

describe("sessions", () => {
  it("create → list → detail → patch → close", async () => {
    const created = await createSession();
    expect(created).toMatchObject({ agent: "claude", cwd: fx.app, mode: "ask", status: "idle", title: "app" });

    const list = await get("/api/v1/sessions");
    expect(list.json().sessions.map((s: Session) => s.id)).toEqual([created.id]);
    expect((await get("/api/v1/sessions?status=closed")).json().sessions).toEqual([]);

    const detail = await get(`/api/v1/sessions/${created.id}`);
    expect(detail.json()).toEqual({ session: created, items: [], truncated: false });

    const patched = await app.inject({ method: "PATCH", url: `/api/v1/sessions/${created.id}`, headers: H, payload: { title: "t", mode: "plan" } });
    expect(patched.json()).toMatchObject({ title: "t", mode: "plan" });

    const closed = await post(`/api/v1/sessions/${created.id}/close`);
    expect(closed.json().status).toBe("closed");
  });

  it("rejects bad cwd, bad body, unknown agent adapter and unknown id", async () => {
    expect((await post("/api/v1/sessions", { agent: "claude", cwd: "/etc" })).statusCode).toBe(403);
    expect((await post("/api/v1/sessions", { agent: "claude", cwd: "~/work/app/index.ts" })).statusCode).toBe(400);
    expect((await post("/api/v1/sessions", { agent: "claude", cwd: "~/work/missing" })).statusCode).toBe(404);
    const bad = await post("/api/v1/sessions", { agent: "gpt", cwd: "~/work/app" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("invalid_request");
    const codex = await post("/api/v1/sessions", { agent: "codex", cwd: "~/work/app" });
    expect(codex.statusCode).toBe(503);
    expect(codex.json().error.code).toBe("agent_unavailable");
    expect((await get("/api/v1/sessions/ses_nope")).json()).toEqual({ error: { code: "not_found", message: expect.any(String) } });
  });

  it("responds to approvals over REST; second response is 409", async () => {
    const { id } = await createSession();
    await fx.manager.startTurn(id, { text: "run tests" });
    await until(() => fx.manager.pendingApprovals(id).length > 0);
    const approvalId = fx.manager.pendingApprovals(id)[0]!.approvalId;
    const url = `/api/v1/sessions/${id}/approvals/${approvalId}`;
    expect((await post(url, { approvalId: "apr_other", optionId: "allow" })).statusCode).toBe(400);
    const ok = await post(url, { optionId: "allow" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
    expect((await post(url, { optionId: "allow" })).statusCode).toBe(409);
  });
});

describe("fs and git", () => {
  it("fs/list merges git status; 403/404 outside home or missing", async () => {
    const res = await get(`/api/v1/fs/list?path=${encodeURIComponent("~/work/app")}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ path: fx.app, parent: fx.workspaceRoot, isGitRepo: true });
    const byName = Object.fromEntries(body.entries.map((e: { name: string; gitStatus: string | null }) => [e.name, e.gitStatus]));
    expect(byName["index.ts"]).toBe("M");
    expect(byName["new.txt"]).toBe("?");
    expect((await get("/api/v1/fs/list?path=/")).statusCode).toBe(403);
    expect((await get(`/api/v1/fs/list?path=${encodeURIComponent("~/nope")}`)).statusCode).toBe(404);
    expect((await get("/api/v1/fs/list")).statusCode).toBe(400);
  });

  it("fs/read returns text and 415 for binary", async () => {
    const res = await get(`/api/v1/fs/read?path=${encodeURIComponent(fx.app + "/index.ts")}`);
    expect(res.json()).toMatchObject({ language: "typescript", encoding: "utf8", content: "export const a = 2;\n", isBinary: false });
    const bin = await get(`/api/v1/fs/read?path=${encodeURIComponent(fx.app + "/bin.dat")}`);
    expect(bin.statusCode).toBe(415);
    expect(bin.json().error.code).toBe("unsupported_media");
  });

  it("git/status and git/diff", async () => {
    const status = await get(`/api/v1/git/status?cwd=${encodeURIComponent(fx.app)}`);
    expect(status.json()).toMatchObject({ isRepo: true, branch: "main" });
    expect(status.json().entries.map((e: { path: string }) => e.path).sort()).toEqual(["bin.dat", "index.ts", "new.txt"]);
    expect((await get(`/api/v1/git/status?cwd=${encodeURIComponent(fx.workspaceRoot + "/lib")}`)).json().isRepo).toBe(false);
    const diff = await get(`/api/v1/git/diff?cwd=${encodeURIComponent(fx.app)}&path=index.ts&staged=false`);
    expect(diff.json().patch).toContain("-export const a = 1;");
    expect((await get(`/api/v1/git/diff?cwd=${encodeURIComponent(fx.app)}&staged=true`)).json()).toEqual({ patch: "" });
    expect((await get("/api/v1/git/status?cwd=/etc")).statusCode).toBe(403);
  });
});

describe("auth stubs and response validation", () => {
  it("auth routes are 501 stubs", async () => {
    const res = await post("/api/v1/auth/claude/login");
    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual({ error: { code: "internal", message: "login flow not available; use ssh" } });
    expect((await post("/api/v1/auth/claude/login/flw_1/code", { code: "x" })).statusCode).toBe(501);
    expect((await get("/api/v1/auth/claude/login/flw_1")).statusCode).toBe(501);
  });

  it("dev-mode response validation turns a contract violation into 500", async () => {
    const fx2 = await makeFixture({ probe: { version: 123 as unknown as string } });
    const bad = buildApp({ user: USER, email: null, home: fx2.home, workspaceRoot: fx2.workspaceRoot, manager: fx2.manager, adapters: { claude: fx2.adapter }, serverVersion: "x" });
    try {
      const res = await bad.inject({ method: "GET", url: "/api/v1/me", headers: H });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: { code: "internal", message: expect.any(String) } });
    } finally {
      await bad.close();
      await fx2.cleanup();
    }
  });
});
