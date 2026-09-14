import { execFile, spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import {
  FsMkdirResponseSchema,
  FsRenderResponseSchema,
  GitInitResponseSchema,
  MeResponseSchema,
  ModelsResponseSchema,
  NetPortsResponseSchema,
  ProjectsResponseSchema,
  SessionDetailResponseSchema,
  SessionsResponseSchema,
  TeamSchema,
  UsageResponseSchema,
  type Session,
} from "@mam/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/agent-host/app.js";
import { DEV_GATEWAY_PORT, gatewayPorts } from "../../src/agent-host/routes/net.js";
import { limitStatus, toAgentUsage } from "../../src/agent-host/routes/usage.js";
import type { AgentAdapter } from "../../src/agents/types.js";
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
    teams: fx.teams,
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
  it("auth routes: unknown flow is 404, real flows are covered in test/agent-host/auth", async () => {
    expect((await post("/api/v1/auth/claude/login/flw_01J8ZQ4K5N7P9R3S6T8V0W2XZZ/code", { code: "x" })).statusCode).toBe(404);
    const res = await get("/api/v1/auth/claude/login/flw_01J8ZQ4K5N7P9R3S6T8V0W2XZZ");
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
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

describe("usage, models, mkdir and patch model/effort (2026-09-10)", () => {
  it("POST /fs/mkdir creates a directory (201), then 409/403/400", async () => {
    const res = await post("/api/v1/fs/mkdir", { path: "~/work/newdir" });
    expect(res.statusCode).toBe(201);
    const body = FsMkdirResponseSchema.parse(res.json());
    expect(body.entry).toMatchObject({ name: "newdir", path: join(fx.workspaceRoot, "newdir"), type: "dir", gitStatus: null });
    expect((await post("/api/v1/fs/mkdir", { path: "~/work/newdir" })).json().error.code).toBe("conflict");
    expect((await post("/api/v1/fs/mkdir", { path: "/etc/mam-x" })).statusCode).toBe(403);
    expect((await post("/api/v1/fs/mkdir", { path: "~/work/a//b" })).statusCode).toBe(400);
    expect((await post("/api/v1/fs/mkdir", {})).statusCode).toBe(400);
  });

  it("GET /usage reports fake limits with computed status and labels; a failing adapter yields limits []", async () => {
    const res = await get("/api/v1/usage");
    expect(res.statusCode).toBe(200);
    const body = UsageResponseSchema.parse(res.json());
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]).toMatchObject({ kind: "claude", plan: "fake", live: true });
    expect(body.agents[0]!.observedAt).not.toBeNull();
    expect(body.agents[0]!.limits).toMatchObject([
      { id: "five_hour", label: "5시간", usedPercent: 42, windowMinutes: 300, status: "ok" },
      { id: "seven_day", label: "주간", usedPercent: 81, windowMinutes: 10080, status: "warning" },
    ]);
    expect(body.agents[0]!.limits.every((l) => l.resetsAt !== null)).toBe(true);

    expect(limitStatus(79, false)).toBe("ok");
    expect(limitStatus(80, false)).toBe("warning");
    expect(limitStatus(100, false)).toBe("exceeded");
    expect(limitStatus(5, true)).toBe("exceeded");
    expect(toAgentUsage("codex", { plan: null, live: true, observedAt: null, limits: [{ id: "primary", usedPercent: 12.6, windowMinutes: 60, resetsAt: null }] })).toEqual({
      kind: "codex", plan: null, live: true, observedAt: null,
      limits: [{ id: "primary", label: "1시간", usedPercent: 13, windowMinutes: 60, resetsAt: null, status: "ok" }],
    });

    const failing: AgentAdapter = {
      kind: "codex",
      probe: () => fx.adapter.probe(),
      start: (o) => fx.adapter.start(o),
      listModels: () => fx.adapter.listModels(),
      usage: () => Promise.reject(new Error("boom")),
    };
    const app2 = buildApp({ user: USER, email: null, home: fx.home, workspaceRoot: fx.workspaceRoot, manager: fx.manager, adapters: { claude: fx.adapter, codex: failing }, serverVersion: "x" });
    try {
      const res2 = await app2.inject({ method: "GET", url: "/api/v1/usage", headers: H });
      const body2 = UsageResponseSchema.parse(res2.json());
      expect(body2.agents.map((a) => a.kind)).toEqual(["claude", "codex"]);
      expect(body2.agents[1]).toEqual({ kind: "codex", plan: null, live: false, observedAt: null, limits: [] });
    } finally {
      await app2.close();
    }
  });

  it("GET /models validates the query and lists adapter models", async () => {
    const res = await get("/api/v1/models?agent=claude");
    expect(res.statusCode).toBe(200);
    const { models } = ModelsResponseSchema.parse(res.json());
    expect(models.map((m) => m.id)).toEqual(["fake-1", "fake-mini"]);
    expect(models[0]).toMatchObject({ isDefault: true, efforts: ["low", "medium", "high"] });
    expect(models[1]).toMatchObject({ isDefault: false, efforts: [], defaultEffort: null });
    expect((await get("/api/v1/models?agent=codex")).statusCode).toBe(503);
    expect((await get("/api/v1/models")).statusCode).toBe(400);
    expect((await get("/api/v1/models?agent=gpt")).statusCode).toBe(400);
  });

  it("PATCH model/effort and session responses carry usage/effort that pass the schema", async () => {
    const { id } = await createSession();
    const patch = (payload: unknown) => app.inject({ method: "PATCH", url: `/api/v1/sessions/${id}`, headers: H, payload });
    expect((await patch({ effort: "high" })).json()).toMatchObject({ model: null, effort: "high" });
    expect((await patch({ model: "fake-mini" })).json()).toMatchObject({ model: "fake-mini", effort: null });
    expect((await patch({ effort: "low" })).statusCode).toBe(400);
    expect((await patch({ model: "nope" })).statusCode).toBe(400);
    expect((await patch({ model: "fake-1", effort: "medium" })).json()).toMatchObject({ model: "fake-1", effort: "medium" });

    await fx.manager.startTurn(id, { text: "run" });
    await until(() => fx.manager.pendingApprovals(id).length > 0);
    await fx.manager.respondApproval(id, fx.manager.pendingApprovals(id)[0]!.approvalId, "allow");
    await until(() => fx.manager.get(id)!.usage?.inputTokens === 1200 && fx.manager.get(id)!.status === "idle");

    const list = SessionsResponseSchema.parse((await get("/api/v1/sessions")).json());
    expect(list.sessions[0]!.usage).toMatchObject({ turns: 1, inputTokens: 1200, context: { percent: 3 } });
    expect(list.sessions[0]).toMatchObject({ model: "fake-1", effort: "medium" });
    const detail = SessionDetailResponseSchema.parse((await get(`/api/v1/sessions/${id}`)).json());
    expect(detail.session.usage!.costUsd).toBeCloseTo(0.012, 6);
  });
});

describe("POST /git/init (2026-09-13)", () => {
  async function exists(p: string): Promise<boolean> {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  }

  it("dryRun → 200 without touching cwd; real → 201 with a commit; again → 409", async () => {
    const lib = join(fx.workspaceRoot, "lib");
    const dry = await post("/api/v1/git/init", { cwd: "~/work/lib", dryRun: true });
    expect(dry.statusCode).toBe(200);
    const dryBody = GitInitResponseSchema.parse(dry.json());
    expect(dryBody).toEqual({ initialized: false, branch: "main", commit: null, files: 0, bytes: 0, createdGitignore: true });
    expect(await exists(join(lib, ".git"))).toBe(false);
    expect(await exists(join(lib, ".gitignore"))).toBe(false);

    const res = await post("/api/v1/git/init", { cwd: "~/work/lib" });
    expect(res.statusCode).toBe(201);
    const body = GitInitResponseSchema.parse(res.json());
    expect(body).toMatchObject({ initialized: true, branch: "main", files: 0, bytes: 0, createdGitignore: true });
    expect(body.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await exists(join(lib, ".git"))).toBe(true);
    expect((await get(`/api/v1/git/status?cwd=${encodeURIComponent(lib)}`)).json()).toMatchObject({ isRepo: true, branch: "main", entries: [] });

    const again = await post("/api/v1/git/init", { cwd: "~/work/lib" });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatchObject({ code: "conflict", message: expect.stringContaining(lib) });
  });

  it("403 outside home, 400 for a missing path, a file, or a bad body, 409 inside an existing repo", async () => {
    expect((await post("/api/v1/git/init", { cwd: "/etc" })).statusCode).toBe(403);
    expect((await post("/api/v1/git/init", { cwd: "/tmp/mam-should-not-exist" })).statusCode).toBe(403);
    const missing = await post("/api/v1/git/init", { cwd: "~/nope" });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe("invalid_request");
    expect((await post("/api/v1/git/init", { cwd: `${fx.app}/index.ts` })).statusCode).toBe(400);
    expect((await post("/api/v1/git/init", {})).statusCode).toBe(400);
    expect((await post("/api/v1/git/init", { cwd: "~/work/lib", dryRun: "yes" })).statusCode).toBe(400);
    // 이미 저장소인 곳과 그 하위 디렉토리
    const repo = await post("/api/v1/git/init", { cwd: fx.app });
    expect(repo.statusCode).toBe(409);
    expect(repo.json().error.message).toContain(fx.app);
    const nested = await post("/api/v1/fs/mkdir", { path: "~/work/app/sub" });
    expect(nested.statusCode).toBe(201);
    const inside = await post("/api/v1/git/init", { cwd: "~/work/app/sub" });
    expect(inside.statusCode).toBe(409);
    expect(inside.json().error.message).toContain(fx.app);
  });

  it("after init, POST /teams accepts the directory (base branch main)", async () => {
    const before = await post("/api/v1/teams", { cwd: "~/work/lib", name: "libteam", members: [{ name: "민수", handle: "minsu", role: "team-lead", agent: "claude", isLead: true }] });
    expect(before.statusCode).toBe(400);
    expect((await post("/api/v1/git/init", { cwd: "~/work/lib" })).statusCode).toBe(201);
    const after = await post("/api/v1/teams", { cwd: "~/work/lib", name: "libteam", members: [{ name: "민수", handle: "minsu", role: "team-lead", agent: "claude", isLead: true }] });
    expect(after.statusCode).toBe(201);
    const team = TeamSchema.parse(after.json());
    expect(team.cwd).toBe(join(fx.workspaceRoot, "lib"));
    expect(team.baseBranch).toBe("main");
    expect(team.members[0]?.branch).toBe("mam/libteam/minsu");
  });
});

describe("GET /net/ports (2026-09-13)", () => {
  /** `lsof` 가 없는 환경에서는 목록 내용을 확인할 수 없다. */
  async function hasLsof(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn("lsof", ["-v"], { stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("close", () => resolve(true));
    });
  }

  it("200 + 스키마 통과. 테스트가 띄운 임시 포트는 담고 앱 자신의 포트(gateway 포트로 지정)는 뺀다", async () => {
    const tmp = createServer();
    await new Promise<void>((resolve) => tmp.listen(0, "127.0.0.1", resolve));
    const tmpPort = (tmp.address() as AddressInfo).port;
    // 앱을 실제 TCP 포트에 띄우고 그 포트를 개발 모드 gateway 포트로 세워 제외 규칙을 확인한다.
    await app.listen({ host: "127.0.0.1", port: 0 });
    const appPort = (app.server.address() as AddressInfo).port;
    const previous = process.env.MAM_DEV_PORT;
    process.env.MAM_DEV_PORT = String(appPort);
    try {
      const res = await get("/api/v1/net/ports");
      expect(res.statusCode).toBe(200);
      const { ports } = NetPortsResponseSchema.parse(res.json());
      expect(ports.map((p) => p.port)).not.toContain(appPort);
      expect(ports.map((p) => p.port)).toEqual([...ports.map((p) => p.port)].sort((a, b) => a - b));
      if (await hasLsof()) {
        expect(ports.find((p) => p.port === tmpPort)).toMatchObject({ pid: process.pid, address: "127.0.0.1" });
      }
    } finally {
      if (previous === undefined) delete process.env.MAM_DEV_PORT;
      else process.env.MAM_DEV_PORT = previous;
      await new Promise<void>((resolve) => tmp.close(() => resolve()));
    }
  });

  it("gatewayPorts: 개발 모드 단서가 있으면 그 포트(기본 7777)를, 없으면 아무것도 빼지 않는다", () => {
    expect(gatewayPorts({})).toEqual([]);
    expect(gatewayPorts({ MAM_DEV_PORT: "7778" })).toEqual([7778]);
    expect(gatewayPorts({ MAM_DEV_BIND: "tailscale" })).toEqual([DEV_GATEWAY_PORT]);
    expect(gatewayPorts({ MAM_DEV_PORT: "nope" })).toEqual([DEV_GATEWAY_PORT]);
    expect(gatewayPorts({ MAM_DEV_PORT: "70000" })).toEqual([DEV_GATEWAY_PORT]);
  });
});

describe("GET /fs/download and /fs/render (2026-09-13)", () => {
  const execFileAsync = promisify(execFile);
  const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n", "binary");

  /** `zip` CLI 로 최소 HWPX 를 만든다. 셸을 거치지 않고 인자 배열만 쓴다. */
  async function makeHwpx(target: string): Promise<void> {
    const src = `${target}-src`;
    const files: Record<string, string> = {
      mimetype: "application/hwp+zip",
      "Contents/header.xml":
        '<?xml version="1.0" encoding="UTF-8"?><hh:head xmlns:hh="h"><hh:refList><hh:styles>' +
        '<hh:style id="0" name="바탕글"/></hh:styles></hh:refList></hh:head>',
      "Contents/section0.xml":
        '<?xml version="1.0" encoding="UTF-8"?><hs:sec xmlns:hs="s" xmlns:hp="p">' +
        '<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>한글 본문</hp:t></hp:run></hp:p></hs:sec>',
    };
    for (const [rel, content] of Object.entries(files)) {
      const file = join(src, rel);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    await execFileAsync("zip", ["-q", "-r", "-X", target, ...Object.keys(files)], { cwd: src });
  }

  it("download streams the raw bytes with type, length and RFC 5987 disposition", async () => {
    await writeFile(join(fx.app, "보고서.pdf"), PDF);
    const res = await get(`/api/v1/fs/download?path=${encodeURIComponent(fx.app + "/보고서.pdf")}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-length"]).toBe(String(PDF.length));
    expect(res.headers["content-disposition"]).toBe(
      `inline; filename*=UTF-8''${encodeURIComponent("보고서.pdf")}`,
    );
    expect(res.rawPayload).toEqual(PDF);
  });

  it("download maps 403/404/400 like the other file routes", async () => {
    expect((await get("/api/v1/fs/download?path=/etc/hosts")).statusCode).toBe(403);
    expect((await get(`/api/v1/fs/download?path=${encodeURIComponent("~/work/nope.pdf")}`)).statusCode).toBe(404);
    const dir = await get(`/api/v1/fs/download?path=${encodeURIComponent(fx.app)}`);
    expect(dir.statusCode).toBe(400);
    expect(dir.json().error.code).toBe("invalid_request");
    expect((await get("/api/v1/fs/download")).statusCode).toBe(400);
  });

  it("render converts hwpx to self-contained html", async () => {
    const doc = join(fx.app, "문서.hwpx");
    await makeHwpx(doc);
    const res = await get(`/api/v1/fs/render?path=${encodeURIComponent(doc)}`);
    expect(res.statusCode).toBe(200);
    const body = FsRenderResponseSchema.parse(res.json());
    expect(body).toMatchObject({ path: doc, kind: "hwpx" });
    expect(body.html).toContain("한글 본문");
    expect(body.html).not.toContain("<script");
  });

  it("render rejects other extensions with 400", async () => {
    const res = await get(`/api/v1/fs/render?path=${encodeURIComponent(fx.app + "/index.ts")}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
  });

  it("render answers 501 agent_unavailable when the hwp converter is missing", async () => {
    await writeFile(join(fx.app, "old.hwp"), Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
    const previous = process.env.MAM_HWP5HTML_BIN;
    process.env.MAM_HWP5HTML_BIN = join(fx.home, "no-such-hwp5html");
    try {
      const res = await get(`/api/v1/fs/render?path=${encodeURIComponent(fx.app + "/old.hwp")}`);
      expect(res.statusCode).toBe(501);
      expect(res.json().error.code).toBe("agent_unavailable");
      expect(res.json().error.message).toContain("pyhwp");
    } finally {
      if (previous === undefined) delete process.env.MAM_HWP5HTML_BIN;
      else process.env.MAM_HWP5HTML_BIN = previous;
    }
  });
});
