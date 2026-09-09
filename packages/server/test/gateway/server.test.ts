import { mkdir } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startAgentHost, type AgentHostHandle } from "../../src/agent-host/server.js";
import { FakeAdapter } from "../../src/agents/fake/index.js";
import { devConfig } from "../../src/config.js";
import { type Identity, type IdentityResolver } from "../../src/gateway/identity.js";
import { startGateway, type GatewayHandle } from "../../src/gateway/server.js";
import { SupervisorBackoffError, type AgentHostSupervisor } from "../../src/gateway/supervisor.js";
import { UserDirectory } from "../../src/gateway/users.js";
import { makeTmpHome, removeTmp } from "../helpers/tmp-home.js";

const USER = userInfo().username;
const EMAIL = "me@dev.local";
let tmp: string;
let host: AgentHostHandle;
let gw: GatewayHandle;
let identity: Identity | null = { email: EMAIL };
let socketPath: string;
let fail: "none" | "missing" | "backoff" = "none";
const tracked: string[] = [];

beforeAll(async () => {
  tmp = await makeTmpHome("mam-gw-");
  await mkdir(join(tmp, "work", "app"), { recursive: true });
  socketPath = join(tmp, "agent.sock");
  // prod 에서는 supervisor 가 --email 로 넘기는 값. /me.email 은 헤더가 아니라 이 옵션에서 온다.
  host = await startAgentHost({ socketPath, dataDir: join(tmp, ".mam"), adapters: { claude: new FakeAdapter() }, workspaceRoot: join(tmp, "work"), email: EMAIL });
  const resolver: IdentityResolver = { resolve: async () => identity };
  const supervisor = {
    ensure: async () => {
      if (fail === "backoff") throw new SupervisorBackoffError(USER, 0);
      return { socketPath: fail === "missing" ? join(tmp, "nope.sock") : socketPath };
    },
    noteActivity() {},
    trackConnection: (u: string) => (tracked.push(`+${u}`), () => tracked.push(`-${u}`)),
    status: () => [],
    shutdown: async () => {},
  } as unknown as AgentHostSupervisor;
  gw = await startGateway({
    config: devConfig({ port: 0, users: [{ macUser: USER, email: EMAIL, workspaceRoot: "~/work" }] }),
    identity: resolver,
    users: new UserDirectory([{ macUser: USER, email: EMAIL, workspaceRoot: "~/work" }]),
    supervisor,
    dev: true,
  });
});
afterAll(async () => {
  await gw?.close();
  await host?.close();
  await removeTmp(tmp);
});

const base = () => `http://127.0.0.1:${gw.address.port}`;
const forged = { "X-MAM-Protocol": "1", "X-MAM-User": "someone-else", "X-MAM-Email": "evil@x" };

describe("gateway (dev) + real agent-host", () => {
  it("/healthz needs no identity; non-api paths get a placeholder", async () => {
    identity = null;
    const h = await fetch(`${base()}/healthz`);
    expect(h.status).toBe(200);
    expect(await h.json()).toEqual({ ok: true, version: "0.1.0" });
    const root = await fetch(`${base()}/`);
    expect(root.headers.get("content-type")).toContain("text/plain");
    expect(await root.text()).toBe("mac-agent-machine gateway");
  });
  it("forged x-mam-* headers are overwritten with the transport identity", async () => {
    identity = { email: EMAIL };
    const res = await fetch(`${base()}/api/v1/me`, { headers: forged });
    expect(res.status).toBe(200);
    const me = await res.json();
    expect(me.user).toBe(USER);
    expect(me.email).toBe(EMAIL);
    const bad = await fetch(`${base()}/api/v1/sessions`, { method: "POST", headers: { ...forged, "content-type": "application/json" }, body: JSON.stringify({ agent: "nope" }) });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("invalid_request");
    const v = await fetch(`${base()}/api/v1/me`, { headers: { "X-MAM-Protocol": "9" } });
    expect(v.status).toBe(426);
  });
  it("403 for unknown identity and unmapped email, 502 for a dead socket, 503 during backoff", async () => {
    identity = null;
    let r = await fetch(`${base()}/api/v1/me`);
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: { code: "forbidden", message: "unknown tailnet identity" } });
    identity = { email: "bob@example.com" };
    r = await fetch(`${base()}/api/v1/me`);
    expect(r.status).toBe(403);
    expect((await r.json()).error.message).toBe("no account mapped for bob@example.com");
    identity = { email: EMAIL };
    fail = "missing";
    r = await fetch(`${base()}/api/v1/me`);
    expect(r.status).toBe(502);
    expect((await r.json()).error.code).toBe("agent_unavailable");
    fail = "backoff";
    r = await fetch(`${base()}/api/v1/me`);
    expect(r.status).toBe(503);
    expect((await r.json()).error.code).toBe("agent_unavailable");
    fail = "none";
  });
  it("proxies websocket upgrades and tracks the connection", async () => {
    identity = { email: EMAIL };
    const session = await host.manager.create({ agent: "claude", cwd: join(tmp, "work", "app") });
    const ws = new WebSocket(`ws://127.0.0.1:${gw.address.port}/api/v1/sessions/${session.id}/ws`, { headers: forged });
    const first = await new Promise<unknown>((resolve, reject) => {
      ws.once("message", (d) => resolve(JSON.parse(d.toString())));
      ws.once("error", reject);
    });
    expect(first).toMatchObject({ type: "session.snapshot", sessionId: session.id });
    expect(tracked).toEqual([`+${USER}`]);
    ws.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(tracked).toEqual([`+${USER}`, `-${USER}`]);
    identity = null;
    const denied = new WebSocket(`ws://127.0.0.1:${gw.address.port}/api/v1/sessions/${session.id}/ws`);
    const status = await new Promise<number>((resolve) => {
      denied.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      denied.once("error", () => resolve(-1));
    });
    expect(status).toBe(403);
  });
});
