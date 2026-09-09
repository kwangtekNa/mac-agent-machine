import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { LoginStartResponseSchema, LoginStatusResponseSchema } from "@mam/protocol";
import { buildApp } from "../../../src/agent-host/app.js";
import { FlowRegistry, type LoginFlow, type LoginStarter } from "../../../src/agent-host/auth/flows.js";
import { AgentUnavailableError } from "../../../src/errors.js";
import { H, makeFixture, type Fixture } from "../helpers.js";

const flows: LoginFlow[] = [];
const claudeStarter: LoginStarter = async (id) => {
  const flow: LoginFlow = {
    id,
    agent: "claude",
    url: "https://claude.com/cai/oauth/authorize?code=true",
    instructions: "링크를 열어 로그인한 뒤 표시되는 코드를 붙여넣으세요",
    needsCode: true,
    status: "pending",
    createdAt: Date.now(),
    submitCode: async (code) => {
      flow.status = code === "good" ? "done" : "error";
      flow.message = code === "good" ? "로그인 완료" : "invalid code";
    },
    cancel: () => {
      if (flow.status === "pending") flow.status = "error";
    },
  };
  flows.push(flow);
  return flow;
};
const codexStarter: LoginStarter = async (id) => ({
  id,
  agent: "codex",
  url: "https://auth.openai.com/codex/device",
  instructions: "링크를 열고 코드 ABCD-EFGH 를 입력하세요",
  needsCode: false,
  status: "pending",
  createdAt: Date.now(),
  cancel() {},
});

let fx: Fixture;
let app: FastifyInstance;
let noBin: FastifyInstance;

beforeAll(async () => {
  fx = await makeFixture();
  const base = { user: H["x-mam-user"], email: "alice@example.com", home: fx.home, workspaceRoot: fx.workspaceRoot, manager: fx.manager, adapters: { claude: fx.adapter }, serverVersion: "0.1.0-test" };
  app = buildApp({ ...base, login: { registry: new FlowRegistry(), starters: { claude: claudeStarter, codex: codexStarter } } });
  noBin = buildApp({
    ...base,
    login: {
      starters: {
        claude: async () => {
          throw new AgentUnavailableError("claude 실행파일을 찾을 수 없습니다");
        },
        codex: async () => {
          throw new AgentUnavailableError("codex 실행파일을 찾을 수 없습니다");
        },
      },
    },
  });
  await app.ready();
  await noBin.ready();
});

afterAll(async () => {
  await app?.close();
  await noBin?.close();
  await fx?.cleanup();
});

describe("auth routes", () => {
  it("claude: start 201 → code → status done (스키마 검증)", async () => {
    const start = await app.inject({ method: "POST", url: "/api/v1/auth/claude/login", headers: H });
    expect(start.statusCode).toBe(201);
    const body = LoginStartResponseSchema.parse(start.json());
    expect(body.needsCode).toBe(true);
    expect(body.url).toMatch(/^https:\/\//);
    const pending = await app.inject({ method: "GET", url: `/api/v1/auth/claude/login/${body.flowId}`, headers: H });
    expect(LoginStatusResponseSchema.parse(pending.json())).toEqual({ status: "pending", message: expect.any(String) });
    const code = await app.inject({ method: "POST", url: `/api/v1/auth/claude/login/${body.flowId}/code`, headers: H, payload: { code: "good" } });
    expect(code.statusCode).toBe(200);
    expect(code.json()).toEqual({ ok: true });
    const done = await app.inject({ method: "GET", url: `/api/v1/auth/claude/login/${body.flowId}`, headers: H });
    expect(LoginStatusResponseSchema.parse(done.json())).toEqual({ status: "done", message: "로그인 완료" });
  });

  it("codex: needsCode false 플로우에 code 를 보내면 400", async () => {
    const start = await app.inject({ method: "POST", url: "/api/v1/auth/codex/login", headers: H });
    expect(start.statusCode).toBe(201);
    const body = LoginStartResponseSchema.parse(start.json());
    expect(body.needsCode).toBe(false);
    expect(body.instructions).toContain("ABCD-EFGH");
    const code = await app.inject({ method: "POST", url: `/api/v1/auth/codex/login/${body.flowId}/code`, headers: H, payload: { code: "x" } });
    expect(code.statusCode).toBe(400);
    expect(code.json().error.code).toBe("invalid_request");
  });

  it("지원하지 않는 agent 400, 없는 flow 404, 빈 code 400", async () => {
    const bad = await app.inject({ method: "POST", url: "/api/v1/auth/gemini/login", headers: H });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({ method: "GET", url: "/api/v1/auth/claude/login/flw_01J8ZQ4K5N7P9R3S6T8V0W2XZZ", headers: H });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("not_found");
    const missingCode = await app.inject({ method: "POST", url: "/api/v1/auth/claude/login/flw_01J8ZQ4K5N7P9R3S6T8V0W2XZZ/code", headers: H, payload: { code: "x" } });
    expect(missingCode.statusCode).toBe(404);
    const start = await app.inject({ method: "POST", url: "/api/v1/auth/claude/login", headers: H });
    const { flowId } = LoginStartResponseSchema.parse(start.json());
    const empty = await app.inject({ method: "POST", url: `/api/v1/auth/claude/login/${flowId}/code`, headers: H, payload: { code: "" } });
    expect(empty.statusCode).toBe(400);
  });

  it("같은 에이전트 재시작 시 이전 pending 플로우는 취소·교체된다", async () => {
    const first = LoginStartResponseSchema.parse((await app.inject({ method: "POST", url: "/api/v1/auth/claude/login", headers: H })).json());
    const second = LoginStartResponseSchema.parse((await app.inject({ method: "POST", url: "/api/v1/auth/claude/login", headers: H })).json());
    expect(second.flowId).not.toBe(first.flowId);
    const old = flows.find((f) => f.id === first.flowId);
    expect(old?.status).toBe("error");
    const gone = await app.inject({ method: "GET", url: `/api/v1/auth/claude/login/${first.flowId}`, headers: H });
    expect(gone.statusCode).toBe(404);
    const alive = await app.inject({ method: "GET", url: `/api/v1/auth/claude/login/${second.flowId}`, headers: H });
    expect(alive.statusCode).toBe(200);
  });

  it("바이너리가 없으면 501 agent_unavailable + SSH 안내", async () => {
    const res = await noBin.inject({ method: "POST", url: "/api/v1/auth/claude/login", headers: H });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual({ error: { code: "agent_unavailable", message: "ssh 로 접속해 직접 로그인하세요: claude setup-token / codex login" } });
    const codex = await noBin.inject({ method: "POST", url: "/api/v1/auth/codex/login", headers: H });
    expect(codex.statusCode).toBe(501);
  });
});

describe("FlowRegistry", () => {
  it("TTL 이 지난 플로우는 cancel 되고 get 이 undefined", async () => {
    let now = 1000;
    const reg = new FlowRegistry({ ttlMs: 100, now: () => now });
    const flow = await reg.start("claude", claudeStarter);
    expect(reg.get(flow.id)).toBe(flow);
    now = 1101;
    expect(reg.get(flow.id)).toBeUndefined();
    expect(flow.status).toBe("error");
  });
});
