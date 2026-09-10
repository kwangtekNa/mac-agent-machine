import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseServerEvent, SessionUsageSchema, type ServerEvent, type SessionUsage } from "@mam/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeAdapter, type FakeAdapterOptions, type FakeScript } from "../../src/agents/fake/index.js";
import type { AgentEvent } from "../../src/agents/types.js";
import { InvalidRequestError, SessionClosedError } from "../../src/errors.js";
import { SessionManager, type SessionManagerOptions } from "../../src/sessions/manager.js";

const silent = { info() {}, warn() {}, error() {} };

async function setup(opts: { adapter?: FakeAdapterOptions; manager?: Partial<SessionManagerOptions>; dataDir?: string } = {}) {
  const dataDir = opts.dataDir ?? (await mkdtemp(join(tmpdir(), "mam-usage-")));
  const adapter = new FakeAdapter({ autoApprove: true, ...opts.adapter });
  const manager = await SessionManager.open({ dataDir, adapters: { claude: adapter }, logger: silent, ...opts.manager });
  return { dataDir, adapter, manager };
}

type Pred = (e: ServerEvent) => boolean;

async function collect(manager: SessionManager, id: string, since = 0) {
  const events: ServerEvent[] = [];
  const waiters: Array<{ pred: Pred; resolve: () => void }> = [];
  const unsubscribe = await manager.subscribe(id, since, (e) => {
    parseServerEvent(e);
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

const isType = (type: ServerEvent["type"]) => (e: ServerEvent) => e.type === type;
const isIdle = (e: ServerEvent) => e.type === "session.status" && e.status === "idle";
const usageEvents = (events: ServerEvent[]): SessionUsage[] =>
  events.flatMap((e) => (e.type === "session.usage" ? [e.usage] : []));

type UsageEvent = Extract<AgentEvent, { type: "usage" }>;

/** `usage` 이벤트 몇 개를 낸 뒤 턴을 끝내는 스크립트. `before` 는 turn.completed 앞에, `after` 는 뒤에 낸다. */
function usageScript(opts: { before?: UsageEvent[]; after?: UsageEvent[]; completeTurn?: boolean }): FakeScript {
  return async (ctx) => {
    for (const ev of opts.before ?? []) ctx.emit(ev);
    if (opts.completeTurn !== false) {
      ctx.emit({ type: "turn.completed", turnId: ctx.turnId, durationMs: 1, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" });
    }
    for (const ev of opts.after ?? []) ctx.emit(ev);
    ctx.emit({ type: "status", status: "idle" });
  };
}

const delta = (n: number, costUsd?: number): UsageEvent["delta"] => ({
  inputTokens: n,
  outputTokens: n * 2,
  cacheReadTokens: n * 3,
  cacheWriteTokens: n * 4,
  ...(costUsd !== undefined ? { costUsd } : {}),
});

/** 턴을 돌리고 idle(그리고 기본적으로 그 턴의 session.usage)까지 기다린다. */
async function runTurn(manager: SessionManager, id: string, text = "go", expectUsage = true): Promise<void> {
  const before = manager.get(id)!.lastSeq;
  const c = await collect(manager, id, before);
  await manager.startTurn(id, { text });
  await c.waitFor((e) => isIdle(e) && e.seq > before + 1);
  if (expectUsage) await c.waitFor((e) => e.type === "session.usage" && e.seq > before);
  c.unsubscribe();
}

afterEach(() => vi.useRealTimers());

describe("SessionManager usage accumulation", () => {
  it("new sessions start with usage/effort null and the default script yields one session.usage per turn after turn.completed", async () => {
    const { dataDir, manager } = await setup();
    const s = await manager.create({ agent: "claude", cwd: dataDir });
    expect(s.usage).toBeNull();
    expect(s.effort).toBeNull();

    const c = await collect(manager, s.id);
    await manager.startTurn(s.id, { text: "hi" });
    await c.waitFor(isType("session.usage"));
    await c.waitFor((e) => isIdle(e) && e.seq > 2);

    // turn.completed 를 처리하며 매니저가 idle 을 먼저 내고, Fake 는 그 뒤에 usage 를 낸다.
    const types = c.events.map((e) => e.type);
    expect(types.filter((t) => t === "session.usage")).toHaveLength(1);
    expect(types.slice(-3)).toEqual(["turn.completed", "session.status", "session.usage"]);

    const expected = {
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 800,
      cacheWriteTokens: 100,
      costUsd: 0.012,
      turns: 1,
      context: { tokens: 5100, window: 200000, percent: 3 },
    };
    expect(usageEvents(c.events)[0]).toMatchObject(expected);
    const after = manager.get(s.id)!;
    expect(after.usage).toMatchObject(expected);
    expect(SessionUsageSchema.safeParse(after.usage).success).toBe(true);
    expect(after.model).toBe("fake-1");

    await runTurn(manager, s.id, "again");
    const second = manager.get(s.id)!.usage!;
    expect(second).toMatchObject({
      inputTokens: 2400,
      outputTokens: 600,
      cacheReadTokens: 1600,
      cacheWriteTokens: 200,
      turns: 2,
      context: { tokens: 6000, window: 200000, percent: 3 },
    });
    expect(second.costUsd).toBeCloseTo(0.024, 6);
    expect(second.updatedAt >= after.usage!.updatedAt).toBe(true);
    await manager.shutdown();
  });

  it("costUsd stays null until an adapter reports cost; context is replaced, kept, or cleared; percent is clamped", async () => {
    const { dataDir, manager } = await setup({
      adapter: {
        script: usageScript({
          before: [
            { type: "usage", delta: delta(10), context: { tokens: 1000, window: 200000 } },
            { type: "usage", delta: delta(10) },
          ],
        }),
      },
    });
    const s = await manager.create({ agent: "claude", cwd: dataDir });
    await runTurn(manager, s.id);
    let usage = manager.get(s.id)!.usage!;
    expect(usage).toMatchObject({ inputTokens: 20, outputTokens: 40, cacheReadTokens: 60, cacheWriteTokens: 80, costUsd: null, turns: 1 });
    expect(usage.updatedAt).toBeTruthy();
    expect(usage.context).toEqual({ tokens: 1000, window: 200000, percent: 1 }); // 두 번째 이벤트는 context 없음 → 유지

    const { manager: m2, dataDir: d2 } = await setup({
      adapter: {
        script: usageScript({
          before: [
            { type: "usage", delta: delta(1, 0.5), context: { tokens: 250000, window: 200000 } },
            { type: "usage", delta: delta(1), context: null },
          ],
        }),
      },
    });
    const s2 = await m2.create({ agent: "claude", cwd: d2 });
    const c = await collect(m2, s2.id);
    await m2.startTurn(s2.id, { text: "x" });
    await c.waitFor((e) => isIdle(e) && e.seq > 2);
    usage = m2.get(s2.id)!.usage!;
    expect(usage.costUsd).toBe(0.5); // 비용 없는 델타는 더하지 않는다
    expect(usage.context).toBeNull(); // null 은 "모름" 으로 덮어쓴다
    // 첫 이벤트의 percent 는 100 으로 클램프된다(이벤트 기록으로 확인)
    await manager.shutdown();
    await m2.shutdown();
  });

  it("turn.completed increments turns even when the adapter never reports usage", async () => {
    const { dataDir, manager } = await setup({ adapter: { script: usageScript({}) } });
    const s = await manager.create({ agent: "claude", cwd: dataDir });
    await runTurn(manager, s.id, "one", false);
    await runTurn(manager, s.id, "two", false);
    expect(manager.get(s.id)!.usage).toMatchObject({ inputTokens: 0, outputTokens: 0, costUsd: null, turns: 2, context: null });
    await manager.shutdown();
  });

  it("usage events carrying model/effort update the session", async () => {
    const { dataDir, manager } = await setup({
      adapter: { script: usageScript({ before: [{ type: "usage", model: "fake-mini", effort: "high" }] }) },
    });
    const s = await manager.create({ agent: "claude", cwd: dataDir });
    await runTurn(manager, s.id);
    expect(manager.get(s.id)).toMatchObject({ model: "fake-mini", effort: "high" });
    await manager.shutdown();
  });

  it("debounces: bursts within 300ms emit the first immediately and only the last afterwards", async () => {
    vi.useFakeTimers();
    const burst: UsageEvent[] = [1, 2, 3].map(() => ({ type: "usage", delta: delta(10) }));
    const { dataDir, manager } = await setup({ adapter: { script: usageScript({ before: burst }) } });
    const s = await manager.create({ agent: "claude", cwd: dataDir });
    const c = await collect(manager, s.id);
    await manager.startTurn(s.id, { text: "burst" });
    await c.waitFor((e) => isIdle(e) && e.seq > 2);
    expect(usageEvents(c.events).map((u) => u.inputTokens)).toEqual([10]);
    await vi.advanceTimersByTimeAsync(299);
    expect(usageEvents(c.events)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(usageEvents(c.events).map((u) => u.inputTokens)).toEqual([10, 30]);
    expect(manager.get(s.id)!.usage!.inputTokens).toBe(30);
    await manager.shutdown();
  });

  it("percent is clamped to 100 in the emitted event", async () => {
    const { dataDir, manager } = await setup({
      adapter: { script: usageScript({ after: [{ type: "usage", context: { tokens: 300000, window: 200000 } }] }) },
    });
    const s = await manager.create({ agent: "claude", cwd: dataDir });
    const c = await collect(manager, s.id);
    await manager.startTurn(s.id, { text: "x" });
    await c.waitFor(isType("session.usage"));
    expect(usageEvents(c.events)[0]!.context).toEqual({ tokens: 300000, window: 200000, percent: 100 });
    await manager.shutdown();
  });

  it("restart restores usage and effort from the session meta file", async () => {
    const { dataDir, manager } = await setup();
    const s = await manager.create({ agent: "claude", cwd: dataDir });
    await manager.patch(s.id, { effort: "high" });
    await runTurn(manager, s.id);
    const before = manager.get(s.id)!;
    await manager.shutdown();

    const second = await setup({ dataDir });
    const restored = second.manager.list()[0]!;
    expect(restored.usage).toEqual(before.usage);
    expect(restored.effort).toBe("high");
    expect(restored.model).toBe("fake-1");
    await second.manager.shutdown();
  });

  it("patch model/effort validates against listModels and forwards to the live adapter session", async () => {
    const { dataDir, manager, adapter } = await setup();
    const s = await manager.create({ agent: "claude", cwd: dataDir });

    await expect(manager.patch(s.id, { model: "nope" })).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(manager.patch(s.id, { effort: "ultra" })).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(manager.patch(s.id, { model: "fake-mini", effort: "high" })).rejects.toBeInstanceOf(InvalidRequestError);
    expect(adapter.sessions[0]!.models).toEqual([]);
    expect(adapter.sessions[0]!.efforts).toEqual([]);

    const withEffort = await manager.patch(s.id, { effort: "high" });
    expect(withEffort.effort).toBe("high");
    expect(adapter.sessions[0]!.efforts).toEqual(["high"]);

    await runTurn(manager, s.id);
    expect(manager.get(s.id)).toMatchObject({ model: "fake-1", effort: "high" });

    const withModel = await manager.patch(s.id, { model: "fake-mini" });
    expect(withModel.model).toBe("fake-mini");
    expect(withModel.effort).toBeNull(); // fake-mini 는 effort 를 지원하지 않는다
    expect(adapter.sessions[0]!.models).toEqual(["fake-mini"]);

    await runTurn(manager, s.id);
    expect(manager.get(s.id)).toMatchObject({ model: "fake-mini", effort: null });

    await manager.close(s.id);
    await expect(manager.patch(s.id, { model: "fake-1" })).rejects.toBeInstanceOf(SessionClosedError);
    await manager.shutdown();
  });

  it("patch while the adapter session is gone stores the values and passes them to the next start()", async () => {
    vi.useFakeTimers();
    const { dataDir, manager, adapter } = await setup({ manager: { idleTimeoutMs: 1_000 } });
    const s = await manager.create({ agent: "claude", cwd: dataDir });
    await manager.patch(s.id, { effort: "low" });
    await vi.advanceTimersByTimeAsync(1_100);
    expect(adapter.sessions[0]!.closed).toBe(true);

    const patched = await manager.patch(s.id, { model: "fake-1", effort: "medium" });
    expect(patched).toMatchObject({ model: "fake-1", effort: "medium" });
    expect(adapter.sessions[0]!.efforts).toEqual(["low"]); // 죽은 세션에는 전달하지 않는다

    await runTurn(manager, s.id);
    expect(adapter.startCalls).toHaveLength(2);
    expect(adapter.startCalls[1]).toMatchObject({ model: "fake-1", effort: "medium", resumeNativeId: s.nativeId });
    await manager.shutdown();
  });

  it("skips validation with a warning when listModels fails", async () => {
    const warnings: string[] = [];
    const { dataDir, manager, adapter } = await setup({ manager: { logger: { info() {}, warn: (m: string) => warnings.push(m), error() {} } } });
    adapter.listModels = () => Promise.reject(new Error("boom"));
    const s = await manager.create({ agent: "claude", cwd: dataDir });
    const patched = await manager.patch(s.id, { model: "anything", effort: "whatever" });
    expect(patched).toMatchObject({ model: "anything", effort: "whatever" });
    expect(warnings.some((w) => w.includes("boom"))).toBe(true);
    await manager.shutdown();
  });
});
