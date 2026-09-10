import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toAgentUsage } from "../../../src/agent-host/routes/usage.js";
import { CodexAdapter, type CodexAdapterOptions } from "../../../src/agents/codex/adapter.js";
import { mapRateLimitSnapshot, toAgentModels } from "../../../src/agents/codex/mapping.js";
import type { Model } from "../../../src/agents/codex/generated/v2/Model.js";
import type { RateLimitSnapshot } from "../../../src/agents/codex/generated/v2/RateLimitSnapshot.js";
import type { AgentEvent } from "../../../src/agents/types.js";
import { RateLimitStore } from "../../../src/usage/rate-limit-store.js";
import { FakeAppServer, THREAD, makeFakeSpawn, quietLogger as logger, take } from "../../helpers/fake-codex-app-server.js";
import { makeTmpHome, removeTmp } from "../../helpers/tmp-home.js";

type UsageEvent = Extract<AgentEvent, { type: "usage" }>;
const NOW = new Date("2026-09-10T04:10:00Z");

let home: string;
let cwd: string;
let dataDir: string;
beforeEach(async () => {
  home = await makeTmpHome("mam-codex-usage-");
  cwd = join(home, "work", "app");
  dataDir = join(home, ".mam");
  await mkdir(cwd, { recursive: true });
});
afterEach(async () => {
  await removeTmp(home);
});

function adapter(spawnFn: CodexAdapterOptions["spawnFn"], extra: Partial<CodexAdapterOptions> = {}): CodexAdapter {
  return new CodexAdapter({ spawnFn, binPath: "/usr/bin/true", home, dataDir, logger, requestTimeoutMs: 2000, now: () => NOW, ...extra });
}

function usageEvents(events: AgentEvent[]): UsageEvent[] {
  return events.filter((e): e is UsageEvent => e.type === "usage");
}

const RATE_LIMITS: RateLimitSnapshot = {
  limitId: "codex",
  limitName: null,
  primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1789030800 },
  secondary: { usedPercent: 35, windowDurationMins: 10080, resetsAt: 1789480800 },
  credits: null,
  individualLimit: null,
  spendControlReached: null,
  planType: "plus",
  rateLimitReachedType: null,
};

function model(id: string, extra: Partial<Model> = {}): Model {
  return {
    id,
    model: id,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: id.toUpperCase(),
    description: `${id} desc`,
    modelSpecialty: null,
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "" },
      { reasoningEffort: "medium", description: "" },
      { reasoningEffort: "high", description: "" },
    ],
    defaultReasoningEffort: "medium",
    inputModalities: ["text"],
    supportsPersonality: false,
    multiAgentVersion: null,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: false,
    ...extra,
  };
}

function installAccountHandlers(server: FakeAppServer, rateLimits: RateLimitSnapshot = RATE_LIMITS): void {
  server.on("account/rateLimits/read", () => ({ rateLimits, rateLimitsByLimitId: null, rateLimitResetCredits: null, accountId: null, rateLimitUpsell: null }));
  server.on("account/read", () => ({ account: { type: "chatgpt", email: "alice@example.com", planType: "plus" }, requiresOpenaiAuth: false }));
}

function installModelHandlers(server: FakeAppServer): void {
  server.on("model/list", (params) => {
    const p = params as { cursor?: string | null; includeHidden?: boolean | null };
    if (p.includeHidden) throw new Error("includeHidden 은 false 여야 한다");
    if (!p.cursor) return { data: [model("gpt-5", { isDefault: true, displayName: "GPT-5" }), model("gpt-5-hidden", { hidden: true })], nextCursor: "page2" };
    if (p.cursor === "page2") return { data: [model("gpt-5-mini", { supportedReasoningEfforts: [], defaultReasoningEffort: "", description: "" })], nextCursor: null };
    throw new Error(`unknown cursor ${p.cursor}`);
  });
}

describe("CodexSession 사용량 이벤트 (PROTOCOL 5절)", () => {
  it("thread/start 응답의 모델 → usage{model}, StartOptions.effort → usage{effort} 와 turn/start.effort", async () => {
    const server = new FakeAppServer();
    server.model = "gpt-5.1";
    const s = await adapter(server.spawnFn).start({ cwd, mode: "ask", model: "gpt-5.1", effort: "high" });
    const iter = s.events[Symbol.asyncIterator]();
    const first = await take(iter, (e) => e.type === "usage");
    expect(first.map((e) => e.type)).toEqual(["native_id", "status", "usage"]);
    expect(first.at(-1)).toEqual({ type: "usage", model: "gpt-5.1", effort: "high" });
    expect(server.calls("thread/start")[0]!.params).toMatchObject({ model: "gpt-5.1" });
    await s.sendTurn({ text: "hi" });
    expect(server.calls("turn/start")[0]!.params).toMatchObject({ model: "gpt-5.1", effort: "high" });
    await s.close();
  });

  it("effort 없이 시작하면 thread 응답의 reasoningEffort 를 쓰고 turn/start 에 effort 를 넣지 않는다", async () => {
    const server = new FakeAppServer();
    server.reasoningEffort = "medium";
    const s = await adapter(server.spawnFn).start({ cwd, mode: "ask" });
    const iter = s.events[Symbol.asyncIterator]();
    const first = await take(iter, (e) => e.type === "usage");
    expect(first.at(-1)).toEqual({ type: "usage", model: "gpt-5", effort: "medium" });
    await s.sendTurn({ text: "hi" });
    const params = server.calls("turn/start")[0]!.params as Record<string, unknown>;
    expect(params).not.toHaveProperty("effort");
    expect(params).not.toHaveProperty("model");
    await s.close();
  });

  it("tokenUsage/updated 두 번 → 첫 관측은 total 전체, 둘째는 증가분. context 는 last.totalTokens/modelContextWindow", async () => {
    const server = new FakeAppServer();
    const s = await adapter(server.spawnFn).start({ cwd, mode: "ask" });
    const iter = s.events[Symbol.asyncIterator]();
    await take(iter, (e) => e.type === "usage");
    await s.sendTurn({ text: "hi" });
    server.tokenUsage({ inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 5, outputTokens: 10, totalTokens: 110 }, { last: { totalTokens: 110 }, modelContextWindow: 272000 });
    const e1 = await take(iter, (e) => e.type === "usage");
    expect(e1.at(-1)).toEqual({ type: "usage", delta: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 5 }, context: { tokens: 110, window: 272000 } });
    server.tokenUsage({ inputTokens: 250, cachedInputTokens: 120, cacheWriteInputTokens: 5, outputTokens: 40, totalTokens: 290 }, { last: { totalTokens: 180 }, modelContextWindow: 272000 });
    const e2 = await take(iter, (e) => e.type === "usage");
    expect(e2.at(-1)).toEqual({ type: "usage", delta: { inputTokens: 150, outputTokens: 30, cacheReadTokens: 100, cacheWriteTokens: 0 }, context: { tokens: 180, window: 272000 } });
    // modelContextWindow 가 null 이면 context 키를 생략한다.
    server.tokenUsage({ inputTokens: 260, cachedInputTokens: 120, cacheWriteInputTokens: 5, outputTokens: 45, totalTokens: 305 }, { modelContextWindow: null });
    const e3 = await take(iter, (e) => e.type === "usage");
    const u3 = e3.at(-1) as UsageEvent;
    expect(u3.delta).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect("context" in u3).toBe(false);
    expect(usageEvents(e1).concat(usageEvents(e2), usageEvents(e3)).every((u) => u.delta?.costUsd === undefined)).toBe(true);
    // 턴 끝: turn.completed 뒤에 컨텍스트만 담은 usage 가 한 번 더 와서 매니저가 turns 를 반영한 상태를 발행한다.
    server.notify("turn/completed", { threadId: THREAD, turn: { id: server.turnId(), status: "completed", items: [], error: null } });
    const end = await take(iter, (e) => e.type === "status" && e.status === "idle");
    const types = end.map((e) => e.type);
    expect(types.indexOf("usage")).toBeGreaterThan(types.indexOf("turn.completed"));
    const tail = usageEvents(end).at(-1)!;
    expect(tail.delta).toBeUndefined();
    expect(tail.context).toEqual({ tokens: 180, window: 272000 }); // 셋째 관측은 창을 몰라 마지막 컨텍스트가 유지된다
    const completed = end.find((e) => e.type === "turn.completed") as Extract<AgentEvent, { type: "turn.completed" }>;
    expect(completed.usage).toEqual({ inputTokens: 260, outputTokens: 45, cacheReadTokens: 120 });
    await s.close();
  });

  it("thread/resume 직후 첫 관측은 기준선(델타 없음), 그다음부터 증가분. 턴 요약도 같은 기준", async () => {
    const server = new FakeAppServer();
    const s = await adapter(server.spawnFn).start({ cwd, mode: "ask", resumeNativeId: THREAD });
    const iter = s.events[Symbol.asyncIterator]();
    await take(iter, (e) => e.type === "usage");
    await s.sendTurn({ text: "continue" });
    server.tokenUsage({ inputTokens: 5000, cachedInputTokens: 4000, outputTokens: 900, totalTokens: 5900 }, { last: { totalTokens: 1200 } });
    const e1 = await take(iter, (e) => e.type === "usage");
    expect(e1.at(-1)).toEqual({ type: "usage", context: { tokens: 1200, window: 200000 } });
    server.tokenUsage({ inputTokens: 5100, cachedInputTokens: 4050, outputTokens: 950, totalTokens: 6050 }, { last: { totalTokens: 1300 } });
    const e2 = await take(iter, (e) => e.type === "usage");
    expect(e2.at(-1)).toEqual({ type: "usage", delta: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 50, cacheWriteTokens: 0 }, context: { tokens: 1300, window: 200000 } });
    server.notify("turn/completed", { threadId: THREAD, turn: { id: server.turnId(), status: "completed", items: [], error: null } });
    const end = await take(iter, (e) => e.type === "status" && e.status === "idle");
    const completed = end.find((e) => e.type === "turn.completed") as Extract<AgentEvent, { type: "turn.completed" }>;
    expect(completed.usage).toEqual({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 50 });
    await s.close();
  });

  it("setModel/setEffort 는 즉시 usage 이벤트를 내고 다음 turn/start 에 반영된다", async () => {
    const server = new FakeAppServer();
    const s = await adapter(server.spawnFn).start({ cwd, mode: "ask" });
    const iter = s.events[Symbol.asyncIterator]();
    await take(iter, (e) => e.type === "usage");
    await s.sendTurn({ text: "1" });
    expect(server.calls("turn/start")[0]!.params).not.toHaveProperty("model");
    server.completeTurn();
    await take(iter, (e) => e.type === "status" && e.status === "idle");
    await s.setModel("gpt-5-mini");
    await s.setEffort("low");
    const got = await take(iter, (e) => e.type === "usage" && e.effort !== undefined);
    expect(usageEvents(got)).toEqual([{ type: "usage", model: "gpt-5-mini" }, { type: "usage", effort: "low" }]);
    await s.sendTurn({ text: "2" });
    expect(server.calls("turn/start")[1]!.params).toMatchObject({ model: "gpt-5-mini", effort: "low" });
    await s.close();
    await expect(s.setModel("x")).rejects.toThrow();
  });

  it("account/rateLimits/updated 알림은 저장소에 병합된다", async () => {
    const server = new FakeAppServer();
    const a = adapter(server.spawnFn);
    const s = await a.start({ cwd, mode: "ask" });
    server.notify("account/rateLimits/updated", { rateLimits: { ...RATE_LIMITS, secondary: null, planType: null } });
    await new Promise((r) => setTimeout(r, 50));
    const stored = await new RateLimitStore(dataDir).load("codex");
    expect(stored).toEqual({ plan: null, live: true, observedAt: NOW, limits: [{ id: "primary", usedPercent: 12, windowMinutes: 300, resetsAt: new Date(1789030800 * 1000), rejected: false }] });
    server.notify("account/rateLimits/updated", { rateLimits: { ...RATE_LIMITS, primary: null, rateLimitReachedType: "rate_limit_reached" } });
    await new Promise((r) => setTimeout(r, 50));
    const merged = await new RateLimitStore(dataDir).load("codex");
    expect(merged?.plan).toBe("plus");
    expect(merged?.limits).toEqual([
      { id: "primary", usedPercent: 12, windowMinutes: 300, resetsAt: new Date(1789030800 * 1000), rejected: false },
      { id: "secondary", usedPercent: 35, windowMinutes: 10080, resetsAt: new Date(1789480800 * 1000), rejected: true },
    ]);
    await s.close();
  });
});

describe("Codex 한도·모델 매핑", () => {
  it("mapRateLimitSnapshot: 창 라벨(5시간/주간), epoch 초 → Date, rejected", () => {
    const { plan, limits } = mapRateLimitSnapshot(RATE_LIMITS);
    expect(plan).toBe("plus");
    expect(limits).toEqual([
      { id: "primary", usedPercent: 12, windowMinutes: 300, resetsAt: new Date(1789030800 * 1000), rejected: false },
      { id: "secondary", usedPercent: 35, windowMinutes: 10080, resetsAt: new Date(1789480800 * 1000), rejected: false },
    ]);
    const usage = toAgentUsage("codex", { plan, live: true, observedAt: NOW, limits });
    expect(usage.limits.map((l) => [l.label, l.status])).toEqual([["5시간", "ok"], ["주간", "ok"]]);
    const reached = mapRateLimitSnapshot({ ...RATE_LIMITS, primary: { usedPercent: 100, windowDurationMins: 120, resetsAt: null }, secondary: { usedPercent: 50, windowDurationMins: 2880, resetsAt: null }, rateLimitReachedType: "rate_limit_reached", planType: null });
    expect(reached.plan).toBeNull();
    expect(reached.limits).toEqual([
      { id: "primary", usedPercent: 100, windowMinutes: 120, resetsAt: null, rejected: true },
      { id: "secondary", usedPercent: 50, windowMinutes: 2880, resetsAt: null, rejected: true },
    ]);
    expect(toAgentUsage("codex", { plan: null, live: true, observedAt: NOW, limits: reached.limits }).limits.map((l) => [l.label, l.status])).toEqual([["2시간", "exceeded"], ["2일", "exceeded"]]);
    expect(mapRateLimitSnapshot({ ...RATE_LIMITS, primary: { usedPercent: 100, windowDurationMins: null, resetsAt: null }, secondary: null }).limits).toEqual([{ id: "primary", usedPercent: 100, windowMinutes: null, resetsAt: null, rejected: true }]);
  });

  it("toAgentModels: hidden 제외, efforts/defaultEffort/isDefault", () => {
    expect(toAgentModels([model("gpt-5", { isDefault: true, displayName: "GPT-5" }), model("h", { hidden: true }), model("mini", { supportedReasoningEfforts: [], defaultReasoningEffort: "", description: "" })])).toEqual([
      { id: "gpt-5", displayName: "GPT-5", description: "gpt-5 desc", isDefault: true, efforts: ["low", "medium", "high"], defaultEffort: "medium" },
      { id: "mini", displayName: "MINI", description: null, isDefault: false, efforts: [], defaultEffort: null },
    ]);
  });
});

describe("CodexAdapter.usage() / listModels()", () => {
  it("라이브 세션이 없으면 임시 app-server 로 조회하고 항상 종료한다. 60초 캐시", async () => {
    const { spawnFn, servers } = makeFakeSpawn((server) => {
      installAccountHandlers(server);
    });
    const a = adapter(spawnFn);
    const snap = await a.usage();
    expect(snap).toEqual({
      plan: "plus",
      live: true,
      observedAt: NOW,
      limits: [
        { id: "primary", usedPercent: 12, windowMinutes: 300, resetsAt: new Date(1789030800 * 1000), rejected: false },
        { id: "secondary", usedPercent: 35, windowMinutes: 10080, resetsAt: new Date(1789480800 * 1000), rejected: false },
      ],
    });
    expect(servers).toHaveLength(1);
    expect(servers[0]!.spawned).toBe(1);
    expect(servers[0]!.killed).toBe(1);
    const methods = servers[0]!.received.map((m) => m.method);
    expect(methods.slice(0, 2)).toEqual(["initialize", "initialized"]);
    expect(methods).toContain("account/rateLimits/read");
    expect(methods).toContain("account/read");
    expect(methods).not.toContain("thread/start");
    // 60초 안의 재호출은 저장소 캐시를 쓴다(프로세스 없음).
    expect(await a.usage()).toEqual(snap);
    expect(servers).toHaveLength(1);
    // 저장 파일에 이메일 없음.
    expect(await readFile(join(dataDir, "usage", "codex.json"), "utf8")).not.toContain("alice@example.com");
    // 캐시가 오래되면 다시 조회한다.
    const later = adapter(spawnFn, { now: () => new Date(NOW.getTime() + 61_000) });
    expect((await later.usage()).observedAt).toEqual(new Date(NOW.getTime() + 61_000));
    expect(servers).toHaveLength(2);
    expect(servers[1]!.killed).toBe(1);
  });

  it("라이브 세션이 있으면 그 피어로 조회한다(임시 프로세스 없음)", async () => {
    const server = new FakeAppServer();
    installAccountHandlers(server);
    const a = adapter(server.spawnFn);
    const s = await a.start({ cwd, mode: "ask" });
    const snap = await a.usage();
    expect(snap.limits).toHaveLength(2);
    expect(server.spawned).toBe(1);
    expect(server.calls("account/rateLimits/read")).toHaveLength(1);
    await s.close();
  });

  it("조회 실패면 저장소의 마지막 값(live:false), 없으면 limits [] — 임시 프로세스는 그래도 종료된다", async () => {
    const { spawnFn, servers } = makeFakeSpawn((server) => {
      server.on("account/rateLimits/read", () => {
        throw new Error("unauthorized");
      });
    });
    const a = adapter(spawnFn);
    expect(await a.usage()).toEqual({ plan: null, live: false, observedAt: null, limits: [] });
    expect(servers[0]!.killed).toBe(1);
    const old = new Date(NOW.getTime() - 3600_000);
    await new RateLimitStore(dataDir, { now: () => old }).save("codex", { plan: "pro", live: true, observedAt: old, limits: [{ id: "primary", usedPercent: 70, windowMinutes: 300, resetsAt: null, rejected: false }] });
    expect(await a.usage()).toEqual({ plan: "pro", live: false, observedAt: old, limits: [{ id: "primary", usedPercent: 70, windowMinutes: 300, resetsAt: null, rejected: false }] });
    expect(servers).toHaveLength(2);
    expect(servers[1]!.killed).toBe(1);
  });

  it("account/read 실패는 plan 만 null 로 두고 한도는 돌려준다. apiKey 계정도 plan null", async () => {
    const { spawnFn } = makeFakeSpawn((server, i) => {
      installAccountHandlers(server, { ...RATE_LIMITS, planType: null });
      if (i === 0) server.on("account/read", () => { throw new Error("nope"); });
      else server.on("account/read", () => ({ account: { type: "apiKey" }, requiresOpenaiAuth: false }));
    });
    expect(await adapter(spawnFn).usage()).toMatchObject({ plan: null, live: true, limits: [{ id: "primary" }, { id: "secondary" }] });
    expect(await adapter(spawnFn, { now: () => new Date(NOW.getTime() + 61_000) }).usage()).toMatchObject({ plan: null, live: true });
  });

  it("listModels: model/list 페이지 전부(includeHidden:false), hidden 제외, 24시간 캐시, 임시 프로세스 종료", async () => {
    const { spawnFn, servers } = makeFakeSpawn((server) => {
      installModelHandlers(server);
    });
    const a = adapter(spawnFn);
    const models = await a.listModels();
    expect(models).toEqual([
      { id: "gpt-5", displayName: "GPT-5", description: "gpt-5 desc", isDefault: true, efforts: ["low", "medium", "high"], defaultEffort: "medium" },
      { id: "gpt-5-mini", displayName: "GPT-5-MINI", description: null, isDefault: false, efforts: [], defaultEffort: null },
    ]);
    expect(servers).toHaveLength(1);
    expect(servers[0]!.killed).toBe(1);
    const calls = servers[0]!.calls("model/list").map((m) => m.params as Record<string, unknown>);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ includeHidden: false });
    expect(calls[1]).toMatchObject({ includeHidden: false, cursor: "page2" });
    const cachePath = join(dataDir, "models", "codex.json");
    expect(JSON.parse(await readFile(cachePath, "utf8"))).toMatchObject({ savedAt: NOW.toISOString() });
    // 캐시가 신선하면(다른 인스턴스도) 프로세스를 띄우지 않는다.
    expect(await adapter(spawnFn).listModels()).toEqual(models);
    expect(servers).toHaveLength(1);
    // 24시간이 지나면 다시 조회한다.
    await adapter(spawnFn, { now: () => new Date(NOW.getTime() + 25 * 3600_000) }).listModels();
    expect(servers).toHaveLength(2);
    expect(servers[1]!.killed).toBe(1);
  });

  it("listModels: 라이브 세션이 있으면 그 피어로, 조회 실패면 오래된 캐시, 캐시도 없으면 throw", async () => {
    const cachePath = join(dataDir, "models", "codex.json");
    await mkdir(join(dataDir, "models"), { recursive: true });
    const stale = { savedAt: new Date(NOW.getTime() - 25 * 3600_000).toISOString(), models: [{ id: "old", displayName: "Old", description: null, isDefault: true, efforts: [], defaultEffort: null }] };
    await writeFile(cachePath, JSON.stringify(stale), "utf8");
    const server = new FakeAppServer();
    server.on("model/list", () => {
      throw new Error("boom");
    });
    const a = adapter(server.spawnFn);
    const s = await a.start({ cwd, mode: "ask" });
    expect((await a.listModels()).map((m) => m.id)).toEqual(["old"]);
    expect(server.spawned).toBe(1);
    expect(server.calls("model/list")).toHaveLength(1);
    installModelHandlers(server);
    expect((await a.listModels()).map((m) => m.id)).toEqual(["gpt-5", "gpt-5-mini"]);
    await s.close();
    const { spawnFn, servers } = makeFakeSpawn((srv) => {
      srv.on("model/list", () => {
        throw new Error("boom");
      });
    });
    await expect(adapter(spawnFn, { dataDir: join(home, "empty") }).listModels()).rejects.toThrow(/boom/);
    expect(servers[0]!.killed).toBe(1);
  });
});
