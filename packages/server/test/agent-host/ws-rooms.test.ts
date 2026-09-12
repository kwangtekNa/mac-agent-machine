import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { parseRoomServerEvent, type RoomServerEvent, type Team } from "@mam/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildApp } from "../../src/agent-host/app.js";
import { startAgentHost } from "../../src/agent-host/server.js";
import { FakeAdapter } from "../../src/agents/fake/index.js";
import { TEAM_MEMBERS, makeTeamFixture, type TeamFixture } from "../helpers/team-fixture.js";
import { makeTmpHome, removeTmp } from "../helpers/tmp-home.js";
import { H, USER } from "./helpers.js";

let fx: TeamFixture;
let app: FastifyInstance;
let sock: string;

beforeEach(async () => {
  fx = await makeTeamFixture();
  sock = join(fx.tmp, "a.sock");
  app = buildApp(
    {
      user: USER,
      email: null,
      home: fx.home,
      workspaceRoot: fx.workspaceRoot,
      manager: fx.manager,
      teams: fx.teams,
      adapters: { claude: fx.claude, codex: fx.codex },
      serverVersion: "0.1.0-test",
    },
    { ws: { pingIntervalMs: 200 } },
  );
  await app.listen({ path: sock });
});

afterEach(async () => {
  await app.close();
  await fx.cleanup();
});

type Pred = (e: RoomServerEvent) => boolean;

function connect(teamId: string, roomId: string, since?: number | string) {
  const url = `ws+unix://${sock}:/api/v1/teams/${teamId}/rooms/${roomId}/ws${since === undefined ? "" : `?since=${since}`}`;
  const ws = new WebSocket(url, { headers: H });
  const events: RoomServerEvent[] = [];
  const waiters: Array<{ pred: Pred; resolve: (e: RoomServerEvent) => void }> = [];
  ws.on("message", (data) => {
    events.push(parseRoomServerEvent(JSON.parse(data.toString())));
    for (const w of waiters.splice(0)) {
      const hit = events.find(w.pred);
      if (hit) w.resolve(hit);
      else waiters.push(w);
    }
  });
  const waitFor = (pred: Pred, timeoutMs = 5000): Promise<RoomServerEvent> => {
    const hit = events.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("waitFor timeout")), timeoutMs);
      waiters.push({ pred, resolve: (e) => (clearTimeout(t), resolve(e)) });
    });
  };
  const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
  const send = (m: unknown) => ws.send(JSON.stringify(m));
  return { ws, events, waitFor, closed, send };
}

async function createTeam(): Promise<Team> {
  return fx.teams.createTeam({ cwd: fx.repo, name: "backend", members: TEAM_MEMBERS });
}

const groupRoom = (team: Team) => team.rooms.find((r) => r.kind === "group")!;
const seqs = (events: RoomServerEvent[]) => events.filter((e) => e.seq > 0).map((e) => e.seq);
const isIncreasing = (nums: number[]) => nums.every((n, i) => i === 0 || n > nums[i - 1]!);

describe("room websocket", () => {
  it("closes with 4004 for an unknown team or room and 1008 for a bad since", async () => {
    const team = await createTeam();
    expect(await connect("team_01J8ZQ4K5N7P9R3S6T8V0W2XZZ", groupRoom(team).id).closed).toBe(4004);
    expect(await connect(team.id, "room_01J8ZQ4K5N7P9R3S6T8V0W2XZZ").closed).toBe(4004);
    expect(await connect(team.id, groupRoom(team).id, "abc").closed).toBe(1008);
  });

  it("sends a snapshot first: seq 0, replayFrom, members, dispatch, no pending approvals", async () => {
    const team = await createTeam();
    const room = groupRoom(team);
    const c = connect(team.id, room.id);
    const snap = await c.waitFor((e) => e.type === "room.snapshot");
    expect(c.events[0]).toBe(snap);
    if (snap.type !== "room.snapshot") throw new Error("unreachable");
    expect(snap).toMatchObject({ seq: 0, roomId: room.id, teamId: team.id, replayFrom: 0, truncated: false, messages: [], pendingApprovals: [], dispatch: { running: [], queued: [] } });
    expect(snap.room).toEqual(room);
    expect(snap.members).toEqual(team.members.map((m) => ({ memberId: m.id, state: "idle", sessionId: m.sessionId })));
    c.ws.close();
  });

  it("room.send → user message → agent reply with work → status; since replays only newer events; ping/pong; bad input → room.error", async () => {
    const team = await createTeam();
    const room = groupRoom(team);
    const c = connect(team.id, room.id);
    await c.waitFor((e) => e.type === "room.snapshot");

    c.send({ type: "room.send", text: "hello team" });
    const user = await c.waitFor((e) => e.type === "room.message" && e.message.author.kind === "user");
    if (user.type !== "room.message") throw new Error("unreachable");
    expect(user.message).toMatchObject({ text: "hello team", hop: 0, seq: user.seq, roomId: room.id });
    const reply = await c.waitFor((e) => e.type === "room.message" && e.message.author.kind === "agent" && e.message.kind === "text");
    if (reply.type !== "room.message") throw new Error("unreachable");
    expect(reply.message.text).toBe("완료했습니다: [#전체] 사용자: hello team");
    expect(reply.message.work).toMatchObject({ toolCalls: 1, filesChanged: [], usage: { inputTokens: 10, outputTokens: 5 } });
    const idle = await c.waitFor((e) => e.type === "room.status" && e.seq > reply.seq && e.members.every((m) => m.state === "idle"));
    expect(idle).toMatchObject({ dispatch: { running: [], queued: [] } });
    expect(c.events.some((e) => e.type === "room.status" && e.members.some((m) => m.state === "running"))).toBe(true);
    expect(isIncreasing(seqs(c.events))).toBe(true);

    // since 재접속: 스냅샷 메시지는 since 보다 뒤의 것만, 이벤트는 since 이후만 재생
    const r = connect(team.id, room.id, user.seq);
    const rsnap = await r.waitFor((e) => e.type === "room.snapshot");
    if (rsnap.type !== "room.snapshot") throw new Error("unreachable");
    expect(rsnap.replayFrom).toBe(user.seq);
    expect(rsnap.messages.map((m) => m.id)).toEqual([reply.message.id]);
    await r.waitFor((e) => e.type === "room.status" && e.seq === idle.seq);
    expect(seqs(r.events)).toEqual(seqs(c.events).filter((s) => s > user.seq));

    c.ws.send("not json");
    expect(await c.waitFor((e) => e.type === "room.error")).toMatchObject({ seq: 0, roomId: room.id, teamId: team.id, recoverable: true });
    c.send({ type: "bogus" });
    await c.waitFor((e) => e.type === "room.error" && e.message.startsWith("invalid message"));
    c.send({ type: "room.send", text: "" });
    await c.waitFor((e) => e.type === "room.error" && e.message.startsWith("invalid message") && e !== c.events.at(-2));
    c.send({ type: "ping" });
    expect(await c.waitFor((e) => e.type === "pong")).toMatchObject({ seq: 0, roomId: room.id, teamId: team.id });
    c.ws.close();
    r.ws.close();
    expect(await c.closed).toBe(1005);
  });

  it("mirrors approvals: room.message(approval) → POST /sessions/:id/approvals/:approvalId → room.message.updated", async () => {
    const team = await createTeam();
    const room = groupRoom(team);
    const c = connect(team.id, room.id);
    await c.waitFor((e) => e.type === "room.snapshot");
    c.send({ type: "room.send", text: "please approve this" });
    const card = await c.waitFor((e) => e.type === "room.message" && e.message.kind === "approval");
    if (card.type !== "room.message") throw new Error("unreachable");
    const approval = card.message.approval!;
    expect(approval).toMatchObject({ memberId: team.members[0]!.id, sessionId: team.members[0]!.sessionId, resolution: null });
    expect(approval.approval.title).toBe("npm test 실행");
    await c.waitFor((e) => e.type === "room.status" && e.members.some((m) => m.state === "waiting_approval"));

    // 대기 중에 새로 붙은 클라이언트의 스냅샷에는 pendingApprovals 가 있다
    const late = connect(team.id, room.id);
    const snap = await late.waitFor((e) => e.type === "room.snapshot");
    if (snap.type !== "room.snapshot") throw new Error("unreachable");
    expect(snap.pendingApprovals).toEqual([approval]);
    late.ws.close();

    const res = await app.inject({ method: "POST", url: `/api/v1/sessions/${approval.sessionId}/approvals/${approval.approval.approvalId}`, headers: H, payload: { optionId: "allow" } });
    expect(res.statusCode).toBe(200);
    const updated = await c.waitFor((e) => e.type === "room.message.updated" && e.message.id === card.message.id);
    if (updated.type !== "room.message.updated") throw new Error("unreachable");
    expect(updated.seq).toBeGreaterThan(card.seq);
    expect(updated.message.seq).toBe(card.message.seq);
    expect(updated.message.approval!.resolution).toMatchObject({ optionId: "allow", by: "client" });
    await c.waitFor((e) => e.type === "room.message" && e.message.author.kind === "agent" && e.message.kind === "text");
    const after = connect(team.id, room.id);
    const asnap = await after.waitFor((e) => e.type === "room.snapshot");
    if (asnap.type !== "room.snapshot") throw new Error("unreachable");
    expect(asnap.pendingApprovals).toEqual([]);
    after.ws.close();
    c.ws.close();
  });

  it("room.interrupt stops the member's running turn", async () => {
    const team = await createTeam();
    const room = groupRoom(team);
    const c = connect(team.id, room.id);
    await c.waitFor((e) => e.type === "room.snapshot");
    c.send({ type: "room.send", text: "wait for me" });
    await c.waitFor((e) => e.type === "room.status" && e.dispatch.running.length === 1);
    c.send({ type: "room.interrupt", memberId: team.members[0]!.id });
    const system = await c.waitFor((e) => e.type === "room.message" && e.message.kind === "system");
    if (system.type !== "room.message") throw new Error("unreachable");
    expect(system.message.text).toContain("중단");
    await c.waitFor((e) => e.type === "room.status" && e.seq > system.seq && e.dispatch.running.length === 0);
    c.ws.close();
  });
});

describe("startAgentHost wiring", () => {
  it("opens a TeamManager next to the SessionManager and serves the team routes", async () => {
    const tmp = await makeTmpHome("mam-host-teams-");
    const host = await startAgentHost({ socketPath: join(tmp, "h.sock"), dataDir: join(tmp, ".mam"), adapters: { claude: new FakeAdapter() } });
    try {
      expect(host.teams).toBeDefined();
      const res = await host.app.inject({ method: "GET", url: "/api/v1/teams", headers: H });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ teams: [] });
      const roles = await host.app.inject({ method: "GET", url: "/api/v1/team-roles", headers: H });
      expect(roles.json().roles).toHaveLength(5);
    } finally {
      await host.close();
      await removeTmp(tmp);
    }
  });
});
