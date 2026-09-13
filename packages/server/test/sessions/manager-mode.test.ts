import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseServerEvent, type ServerEvent } from "@mam/protocol";
import { describe, expect, it } from "vitest";
import { FakeAdapter } from "../../src/agents/fake/index.js";
import { SessionManager } from "../../src/sessions/manager.js";
import { makeTeamFixture, TEAM_MEMBERS } from "../helpers/team-fixture.js";

const silent = { info() {}, warn() {}, error() {} };

async function setup(dataDir?: string) {
  const dir = dataDir ?? (await mkdtemp(join(tmpdir(), "mam-mode-")));
  const adapter = new FakeAdapter({ autoApprove: true });
  const manager = await SessionManager.open({ dataDir: dir, adapters: { claude: adapter }, logger: silent });
  return { dataDir: dir, adapter, manager };
}

async function runTurn(manager: SessionManager, id: string): Promise<ServerEvent[]> {
  const before = manager.get(id)!.lastSeq;
  const events: ServerEvent[] = [];
  let resolveIdle: () => void = () => undefined;
  const idle = new Promise<void>((r) => {
    resolveIdle = r;
  });
  const unsubscribe = await manager.subscribe(id, before, (e) => {
    parseServerEvent(e);
    events.push(e);
    if (e.type === "session.status" && e.status === "idle" && e.seq > before + 1) resolveIdle();
  });
  await manager.startTurn(id, { text: "go" });
  await idle;
  unsubscribe();
  return events;
}

async function recordMode(dataDir: string, id: string): Promise<string> {
  const rec = JSON.parse(await readFile(join(dataDir, "sessions", `${id}.json`), "utf8")) as { mode: string };
  return rec.mode;
}

describe("SessionManager mode (PATCH mode → 레코드 + 라이브 어댑터)", () => {
  it("idle(프로세스 없음) 세션의 patch mode 는 레코드에 저장되고 다음 start 의 StartOptions.mode 로 간다", async () => {
    const { dataDir, adapter, manager } = await setup();
    const s = await manager.create({ agent: "claude", cwd: dataDir, title: "t", deferStart: true });
    expect(s.mode).toBe("ask");
    expect(adapter.startCalls).toHaveLength(0);
    const patched = await manager.patch(s.id, { mode: "full-auto" });
    expect(patched.mode).toBe("full-auto");
    const detail = await manager.detail(s.id);
    expect(detail.session.mode).toBe("full-auto");
    await manager.shutdown();
    expect(await recordMode(dataDir, s.id)).toBe("full-auto");

    const second = await setup(dataDir);
    expect(second.manager.get(s.id)!.mode).toBe("full-auto");
    await runTurn(second.manager, s.id);
    expect(second.adapter.startCalls).toHaveLength(1);
    expect(second.adapter.startCalls[0]).toMatchObject({ cwd: dataDir, mode: "full-auto" });
    expect(second.adapter.sessions[0]!.currentMode).toBe("full-auto");
    await second.manager.shutdown();
  });

  it("라이브 세션의 patch mode 는 어댑터 setMode 를 부르고 mode_changed 이벤트를 낸다", async () => {
    const { dataDir, adapter, manager } = await setup();
    const s = await manager.create({ agent: "claude", cwd: dataDir, title: "t" });
    expect(adapter.startCalls).toHaveLength(1);
    const events: ServerEvent[] = [];
    const unsubscribe = await manager.subscribe(s.id, 0, (e) => events.push(e));
    await manager.patch(s.id, { mode: "full-auto" });
    unsubscribe();
    expect(adapter.sessions[0]!.modes).toEqual(["full-auto"]);
    expect(adapter.sessions[0]!.currentMode).toBe("full-auto");
    expect(manager.get(s.id)!.mode).toBe("full-auto");
    expect(events.at(-1)).toMatchObject({ type: "session.status", status: "idle", mode: "full-auto", reason: "mode_changed" });
    // 같은 값으로 다시 patch 하면 어댑터를 부르지 않는다.
    await manager.patch(s.id, { mode: "full-auto" });
    expect(adapter.sessions[0]!.modes).toEqual(["full-auto"]);
    await manager.shutdown();
    expect(await recordMode(dataDir, s.id)).toBe("full-auto");
  });

  it("서버는 기본 모드를 ask 로 두고 스스로 full-auto 로 올리지 않는다(ADR-015)", async () => {
    const { dataDir, adapter, manager } = await setup();
    const s = await manager.create({ agent: "claude", cwd: dataDir, title: "t" });
    expect(s.mode).toBe("ask");
    await runTurn(manager, s.id);
    expect(adapter.startCalls[0]!.mode).toBe("ask");
    expect(adapter.sessions[0]!.modes).toEqual([]);
    await manager.shutdown();
  });

  it("팀원 patchMember({ mode: 'full-auto' }) 는 팀원 레코드와 세션 둘 다에 반영된다", async () => {
    const f = await makeTeamFixture();
    try {
      const team = await f.teams.createTeam({ cwd: f.repo, name: "backend", members: TEAM_MEMBERS });
      const jiyeon = team.members.find((m) => m.name === "지연")!;
      expect(jiyeon.mode).toBe("auto-edit");
      const patched = await f.teams.patchMember(team.id, jiyeon.id, { mode: "full-auto" });
      expect(patched.members.find((m) => m.id === jiyeon.id)!.mode).toBe("full-auto");
      expect(f.manager.get(jiyeon.sessionId!)!.mode).toBe("full-auto");
      // 지연 시작 세션이라 어댑터는 아직 없고, 첫 턴의 StartOptions.mode 가 full-auto 다.
      expect(f.codex.startCalls).toHaveLength(0);
      await runTurn(f.manager, jiyeon.sessionId!);
      expect(f.codex.startCalls[0]).toMatchObject({ mode: "full-auto" });
      // 팀 생성 시 full-auto 를 명시해도 받아들인다(전환 확인은 앱이 한다).
      const withMode = await f.teams.addMember(team.id, { name: "하나", role: "code-reviewer", agent: "claude", mode: "full-auto" });
      const hana = withMode.members.find((m) => m.name === "하나")!;
      expect(hana.mode).toBe("full-auto");
      expect(f.manager.get(hana.sessionId!)!.mode).toBe("full-auto");
    } finally {
      await f.cleanup();
    }
  });
});
