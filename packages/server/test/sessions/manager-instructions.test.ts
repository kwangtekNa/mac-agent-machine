import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseServerEvent, SessionSchema, type ServerEvent } from "@mam/protocol";
import { ulid } from "ulid";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultScript, FakeAdapter, type FakeAdapterOptions, type FakeScript } from "../../src/agents/fake/index.js";
import { SessionManager, type SessionManagerOptions } from "../../src/sessions/manager.js";

const silent = { info() {}, warn() {}, error() {} };
const INSTRUCTIONS = "너는 팀 backend 의 팀장 민수다. 커밋하지 마라.";
const TEAM = { teamId: `team_${ulid()}`, memberId: `agt_${ulid()}` };

async function setup(opts: { adapter?: FakeAdapterOptions; manager?: Partial<SessionManagerOptions>; dataDir?: string } = {}) {
  const dataDir = opts.dataDir ?? (await mkdtemp(join(tmpdir(), "mam-instr-")));
  const adapter = new FakeAdapter({ autoApprove: true, ...opts.adapter });
  const manager = await SessionManager.open({ dataDir, adapters: { claude: adapter }, logger: silent, ...opts.manager });
  return { dataDir, adapter, manager };
}

type Pred = (e: ServerEvent) => boolean;

async function collect(manager: SessionManager, id: string, since = 0) {
  const events: ServerEvent[] = [];
  const waiters: Array<{ pred: Pred; resolve: () => void }> = [];
  const unsubscribe = await manager.subscribe(id, since, (e) => {
    parseServerEvent(e); // 팬아웃 이벤트는 프로토콜 스키마를 만족해야 한다
    events.push(e);
    for (const w of waiters.splice(0)) {
      if (events.some(w.pred)) w.resolve();
      else waiters.push(w);
    }
  });
  const waitFor = (pred: Pred): Promise<void> =>
    events.some(pred) ? Promise.resolve() : new Promise((resolve) => waiters.push({ pred, resolve }));
  return { events, waitFor, unsubscribe };
}

const isIdle = (e: ServerEvent) => e.type === "session.status" && e.status === "idle";
const systemTexts = (events: ServerEvent[]): string[] =>
  events.flatMap((e) => (e.type === "item.started" && e.item.kind === "system" ? [e.item.payload.text] : []));

/** 한 턴을 돌리고 그 턴의 idle 까지 기다린 뒤 이번 턴에서 본 이벤트를 돌려준다. */
async function runTurn(manager: SessionManager, id: string, text = "go"): Promise<ServerEvent[]> {
  const before = manager.get(id)!.lastSeq;
  const c = await collect(manager, id, before);
  await manager.startTurn(id, { text });
  await c.waitFor((e) => isIdle(e) && e.seq > before + 1);
  c.unsubscribe();
  return c.events;
}

async function readRecord(dataDir: string, id: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(dataDir, "sessions", `${id}.json`), "utf8")) as Record<string, unknown>;
}

afterEach(() => vi.useRealTimers());

describe("SessionManager instructions / team / deferStart", () => {
  it("deferStart 세션은 start() 없이 idle 로 등록되고 첫 startTurn 에 instructions 를 넘긴다", async () => {
    const { dataDir, manager, adapter } = await setup();
    const s = await manager.create({ agent: "claude", cwd: dataDir, title: "민수", deferStart: true, instructions: INSTRUCTIONS, team: TEAM });
    expect(s.status).toBe("idle");
    expect(s.nativeId).toBeNull();
    expect(s.team).toEqual(TEAM);
    expect(s).not.toHaveProperty("instructions");
    expect(adapter.startCalls).toHaveLength(0);
    expect(SessionSchema.safeParse(s).success).toBe(true);

    // 영속 레코드에는 instructions 와 team 이 있다.
    await manager.shutdown();
    const record = await readRecord(dataDir, s.id);
    expect(record.instructions).toBe(INSTRUCTIONS);
    expect(record.team).toEqual(TEAM);

    const events = await runTurn(manager, s.id, "hello");
    expect(adapter.startCalls).toHaveLength(1);
    expect(adapter.startCalls[0]).toMatchObject({ cwd: dataDir, mode: "ask", instructions: INSTRUCTIONS });
    expect(adapter.startCalls[0]!.resumeNativeId).toBeUndefined();
    // Fake 는 첫 턴 직전에 system 아이템으로 주입을 알린다.
    expect(systemTexts(events)).toEqual([`instructions: ${INSTRUCTIONS}`]);
    expect(manager.get(s.id)!.nativeId).toBe(adapter.sessions[0]!.nativeId);

    // 두 번째 턴에는 system 아이템이 없다.
    const second = await runTurn(manager, s.id, "again");
    expect(systemTexts(second)).toEqual([]);
    await manager.shutdown();
  });

  it("list/get/detail 의 Session 에는 team 은 있고 instructions 는 없다", async () => {
    const { dataDir, manager } = await setup();
    const s = await manager.create({ agent: "claude", cwd: dataDir, deferStart: true, instructions: INSTRUCTIONS, team: TEAM });
    const plain = await manager.create({ agent: "claude", cwd: dataDir });
    for (const session of [manager.get(s.id)!, manager.list().find((x) => x.id === s.id)!, (await manager.detail(s.id)).session]) {
      expect(session.team).toEqual(TEAM);
      expect(session).not.toHaveProperty("instructions");
    }
    expect(manager.get(plain.id)).not.toHaveProperty("team");
    expect(manager.get(plain.id)).not.toHaveProperty("instructions");
    const patched = await manager.patch(s.id, { title: "새 제목" });
    expect(patched.team).toEqual(TEAM);
    expect(patched).not.toHaveProperty("instructions");
    await manager.shutdown();
  });

  it("일반 create 에 instructions 를 주면 즉시 start() 에 넘긴다", async () => {
    const { dataDir, manager, adapter } = await setup();
    const s = await manager.create({ agent: "claude", cwd: dataDir, instructions: INSTRUCTIONS });
    expect(s.status).toBe("idle");
    expect(adapter.startCalls).toHaveLength(1);
    expect(adapter.startCalls[0]!.instructions).toBe(INSTRUCTIONS);
    expect(s).not.toHaveProperty("team");
    expect(s).not.toHaveProperty("instructions");
    await manager.shutdown();
  });

  it("유휴 종료 후 재개(resumeNativeId)에도 instructions 를 다시 넘긴다", async () => {
    vi.useFakeTimers();
    const { dataDir, manager, adapter } = await setup({ manager: { idleTimeoutMs: 1_000 } });
    const s = await manager.create({ agent: "claude", cwd: dataDir, deferStart: true, instructions: INSTRUCTIONS, team: TEAM });
    // live 가 없는 deferStart 세션은 유휴 타이머가 아무 일도 하지 않는다.
    await vi.advanceTimersByTimeAsync(1_100);
    expect(adapter.startCalls).toHaveLength(0);
    expect(manager.get(s.id)!.status).toBe("idle");

    await runTurn(manager, s.id);
    const nativeId = manager.get(s.id)!.nativeId;
    expect(nativeId).toBeTruthy();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(adapter.sessions[0]!.closed).toBe(true);

    await runTurn(manager, s.id, "resume");
    expect(adapter.startCalls).toHaveLength(2);
    expect(adapter.startCalls[1]).toMatchObject({ instructions: INSTRUCTIONS, resumeNativeId: nativeId });
    await manager.shutdown();
  });

  it("재시작(SessionManager.open 재호출) 뒤에도 instructions 와 team 이 유지된다", async () => {
    const { dataDir, manager } = await setup();
    const s = await manager.create({ agent: "claude", cwd: dataDir, deferStart: true, instructions: INSTRUCTIONS, team: TEAM });
    await manager.shutdown();

    const second = await setup({ dataDir });
    const restored = second.manager.get(s.id)!;
    expect(restored.status).toBe("idle");
    expect(restored.team).toEqual(TEAM);
    expect(restored).not.toHaveProperty("instructions");
    expect(second.manager.list()[0]).not.toHaveProperty("instructions");

    const events = await runTurn(second.manager, s.id);
    expect(second.adapter.startCalls[0]).toMatchObject({ instructions: INSTRUCTIONS });
    expect(systemTexts(events)).toEqual([`instructions: ${INSTRUCTIONS}`]);
    await second.manager.shutdown();

    // 다시 열어도 레코드는 그대로다(재저장이 키를 잃지 않는다).
    const third = await setup({ dataDir });
    expect(await readRecord(dataDir, s.id)).toMatchObject({ instructions: INSTRUCTIONS, team: TEAM });
    expect(third.manager.get(s.id)!.team).toEqual(TEAM);
    await third.manager.shutdown();
  });

  it("instructions/team 키가 없는 기존 레코드도 그대로 로드한다", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "mam-instr-legacy-"));
    const first = await setup({ dataDir });
    const s = await first.manager.create({ agent: "claude", cwd: dataDir });
    await first.manager.shutdown();
    const path = join(dataDir, "sessions", `${s.id}.json`);
    const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(record).not.toHaveProperty("instructions");
    expect(record).not.toHaveProperty("team");
    delete record.effort;
    delete record.usage;
    await writeFile(path, JSON.stringify(record), "utf8");

    const second = await setup({ dataDir });
    const restored = second.manager.get(s.id)!;
    expect(restored.status).toBe("idle");
    expect(restored).not.toHaveProperty("team");
    expect(restored).not.toHaveProperty("instructions");
    await runTurn(second.manager, s.id);
    expect(second.adapter.startCalls[0]).not.toHaveProperty("instructions");
    expect(second.adapter.startCalls[0]!.resumeNativeId).toBe(s.nativeId);
    await second.manager.shutdown();
  });

  it("deferStart 세션은 close/interrupt/shutdown 경로에서 예외를 내지 않는다", async () => {
    const { dataDir, manager, adapter } = await setup();
    const s = await manager.create({ agent: "claude", cwd: dataDir, deferStart: true, instructions: INSTRUCTIONS, team: TEAM });
    await expect(manager.interrupt(s.id)).resolves.toBeUndefined();
    const closed = await manager.create({ agent: "claude", cwd: dataDir, deferStart: true, instructions: INSTRUCTIONS });
    expect((await manager.close(closed.id)).status).toBe("closed");
    await expect(manager.startTurn(closed.id, { text: "x" })).rejects.toThrow();
    expect(adapter.startCalls).toHaveLength(0);
    await expect(manager.shutdown()).resolves.toBeUndefined();
    expect(manager.get(s.id)!.status).toBe("idle");
  });

  it("Fake 스크립트는 ctx.cwd 로 세션 cwd 를 본다", async () => {
    const seen: string[] = [];
    const script: FakeScript = async (ctx) => {
      seen.push(ctx.cwd);
      await defaultScript(ctx);
    };
    const { dataDir, manager } = await setup({ adapter: { script } });
    const s = await manager.create({ agent: "claude", cwd: dataDir, deferStart: true, instructions: INSTRUCTIONS });
    await runTurn(manager, s.id);
    expect(seen).toEqual([dataDir]);
    await manager.shutdown();
  });
});
