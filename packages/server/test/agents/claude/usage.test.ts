import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeAdapter, STATIC_CLAUDE_MODELS, type QueryFn } from "../../../src/agents/claude/adapter.js";
import { mapRateLimitInfo } from "../../../src/agents/claude/mapping.js";
import type { AgentEvent } from "../../../src/agents/types.js";
import { RateLimitStore } from "../../../src/usage/rate-limit-store.js";
import { FAKE_SID, fakeRateLimitEvent, fakeResult, makeFakeQueryFn, type FakeQueryHooks } from "../../helpers/fake-claude-query.js";
import { makeTmpHome, removeTmp } from "../../helpers/tmp-home.js";

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
type UsageEvent = Extract<AgentEvent, { type: "usage" }>;

let home: string;
let dataDir: string;
beforeEach(async () => {
  home = await makeTmpHome("mam-claude-usage-");
  dataDir = join(home, ".mam");
});
afterEach(async () => {
  await removeTmp(home);
});

function adapter(queryFn: QueryFn, extra: Partial<ConstructorParameters<typeof ClaudeAdapter>[0]> = {}): ClaudeAdapter {
  return new ClaudeAdapter({ queryFn, home, dataDir, binPath: "/nonexistent/claude", logger, env: { PATH: "/usr/bin" }, ...extra });
}

async function collect(events: AsyncIterable<AgentEvent>, until: (e: AgentEvent) => boolean, limit = 100): Promise<AgentEvent[]> {
  const got: AgentEvent[] = [];
  for await (const e of events) {
    got.push(e);
    if (until(e) || got.length >= limit) break;
  }
  return got;
}

/** 한 턴을 보내고 `status idle` 까지의 이벤트를 모은다. */
async function runTurn(s: { sendTurn: (i: { text: string }) => Promise<void>; events: AsyncIterable<AgentEvent> }, text = "ping"): Promise<AgentEvent[]> {
  await s.sendTurn({ text });
  return collect(s.events, (e) => e.type === "status" && e.status === "idle");
}

function usageEvents(events: AgentEvent[]): UsageEvent[] {
  return events.filter((e): e is UsageEvent => e.type === "usage");
}

async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs = 2000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor timeout");
}

const SDK_MODELS: ModelInfo[] = [
  { value: "claude-opus-5", displayName: "Opus 5", description: "best", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "claude-sonnet-5", displayName: "Sonnet 5", description: "", supportedEffortLevels: ["low", "medium", "high"] },
  { value: "claude-haiku-4-5", displayName: "Haiku 4.5", description: "fast", supportsEffort: false },
];

describe("ClaudeAdapter 사용량 (PROTOCOL 5절)", () => {
  it("init → usage{model, effort}, result 두 개 → 토큰 델타·비용 차분·컨텍스트", async () => {
    const results = [
      fakeResult({ totalCostUsd: 0.01, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 }, modelUsage: { a: { contextWindow: 200000 }, b: { contextWindow: 1000000 } } }),
      fakeResult({ totalCostUsd: 0.035, usage: { input_tokens: 30, output_tokens: 7, cache_read_input_tokens: 1200, cache_creation_input_tokens: 0 }, modelUsage: { a: { contextWindow: 200000 } } }),
    ];
    let i = 0;
    const { queryFn } = makeFakeQueryFn(async (_m, { emit }) => {
      await emit(results[i++]!);
    });
    const s = await adapter(queryFn).start({ cwd: home, mode: "ask", model: "claude-opus-5", effort: "xhigh" });
    const t1 = await runTurn(s);
    const init = usageEvents(t1)[0];
    expect(init).toEqual({ type: "usage", model: "claude-opus-5", effort: "xhigh" });
    const u1 = usageEvents(t1).at(-1)!;
    expect(u1).toEqual({
      type: "usage",
      delta: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 1000, cacheWriteTokens: 50, costUsd: 0.01 },
      context: { tokens: 1150, window: 1000000 },
    });
    // 턴 끝 usage 는 turn.completed 뒤, status idle 앞에 온다(매니저가 turns 를 먼저 올린다).
    const tcIdx = t1.findIndex((e) => e.type === "turn.completed");
    const usIdx = t1.lastIndexOf(u1);
    expect(tcIdx).toBeGreaterThan(-1);
    expect(usIdx).toBeGreaterThan(tcIdx);
    expect(t1.at(-1)).toEqual({ type: "status", status: "idle" });

    const t2 = await runTurn(s, "again");
    const u2 = usageEvents(t2).at(-1)!;
    expect(u2.delta?.costUsd).toBeCloseTo(0.025, 10);
    expect(u2.delta).toMatchObject({ inputTokens: 30, outputTokens: 7, cacheReadTokens: 1200, cacheWriteTokens: 0 });
    expect(u2.context).toEqual({ tokens: 1230, window: 200000 });
    await s.close();
  });

  it("비용이 줄어들면 델타 0, modelUsage 가 비면 context 는 undefined(유지)", async () => {
    const results = [fakeResult({ totalCostUsd: 0.02 }), fakeResult({ totalCostUsd: 0.015, modelUsage: {} })];
    let i = 0;
    const { queryFn } = makeFakeQueryFn(async (_m, { emit }) => {
      await emit(results[i++]!);
    });
    const s = await adapter(queryFn).start({ cwd: home, mode: "ask" });
    await runTurn(s);
    const u2 = usageEvents(await runTurn(s, "2")).at(-1)!;
    expect(u2.delta?.costUsd).toBe(0);
    expect(u2.context).toBeUndefined();
    expect("context" in u2).toBe(false);
    await s.close();
  });

  it("SDKResultError 에 usage 가 없으면 델타 없이 컨텍스트를 유지한다", async () => {
    const { queryFn } = makeFakeQueryFn(async (_m, { emit }) => {
      await emit(fakeResult({ subtype: "error_during_execution", usage: null, totalCostUsd: 0.5 }));
    });
    const s = await adapter(queryFn).start({ cwd: home, mode: "ask" });
    const t = await runTurn(s);
    expect(t.some((e) => e.type === "turn.completed")).toBe(true);
    const turnEnd = usageEvents(t).filter((e) => e.delta !== undefined || e.context !== undefined);
    expect(turnEnd).toEqual([]);
    await s.close();
  });

  it("resume 으로 프로세스를 다시 열면 비용 기준이 0 으로 리셋된다", async () => {
    const { queryFn, queries } = makeFakeQueryFn(async (_m, { emit }) => {
      await emit(fakeResult({ totalCostUsd: 0.02 }));
    });
    const s = await adapter(queryFn).start({ cwd: home, mode: "ask" });
    expect(usageEvents(await runTurn(s)).at(-1)!.delta?.costUsd).toBeCloseTo(0.02, 10);
    await s.setEffort("low");
    const t2 = await runTurn(s, "2");
    expect(queries).toHaveLength(2);
    expect(queries[1]!.options.resume).toBe(FAKE_SID);
    // 새 프로세스의 누적 0.02 는 전부 이번 턴 몫이다.
    expect(usageEvents(t2).at(-1)!.delta?.costUsd).toBeCloseTo(0.02, 10);
    await s.close();
  });
});

describe("ClaudeAdapter 구독 한도 (rate_limit_event)", () => {
  it("mapRateLimitInfo: 비율(≤1)은 ×100, 백분율은 그대로, 창 길이·resetsAt·rejected", () => {
    const now = new Date("2026-09-10T03:40:00Z");
    expect(mapRateLimitInfo({ status: "allowed", rateLimitType: "five_hour", utilization: 0.42, resetsAt: 1757484000 }, now)).toEqual({
      id: "five_hour",
      usedPercent: 42,
      windowMinutes: 300,
      resetsAt: new Date(1757484000 * 1000),
      rejected: false,
    });
    expect(mapRateLimitInfo({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 81 }, now)).toEqual({ id: "seven_day", usedPercent: 81, windowMinutes: 10080, resetsAt: null, rejected: false });
    expect(mapRateLimitInfo({ status: "rejected", rateLimitType: "seven_day_opus", utilization: 1 }, now)).toMatchObject({ id: "seven_day_opus", usedPercent: 100, windowMinutes: 10080, rejected: true });
    expect(mapRateLimitInfo({ status: "allowed", rateLimitType: "overage", utilization: 0.1 }, now)).toMatchObject({ id: "overage", windowMinutes: null });
    expect(mapRateLimitInfo({ status: "allowed" }, now)).toBeNull();
  });

  it("이벤트마다 rateLimitType 별로 저장하고 usage() 가 live:false 로 돌려준다. plan 은 accountInfo", async () => {
    const t = new Date("2026-09-10T03:40:00Z");
    const hooks: FakeQueryHooks = { accountInfo: async () => ({ email: "alice@example.com", subscriptionType: "max" }) };
    const { queryFn } = makeFakeQueryFn(async (m, { emit }) => {
      const text = JSON.stringify(m.message.content);
      if (text.includes("first")) {
        await emit(fakeRateLimitEvent({ status: "allowed", rateLimitType: "five_hour", utilization: 0.42, resetsAt: 1757484000 }));
        await emit(fakeRateLimitEvent({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.81, resetsAt: 1757808000 }));
      } else {
        await emit(fakeRateLimitEvent({ status: "rejected", rateLimitType: "five_hour", utilization: 1, resetsAt: 1757490000 }));
      }
      await emit(fakeResult());
    }, hooks);
    const a = adapter(queryFn, { now: () => t });
    expect(await a.usage()).toEqual({ plan: null, live: false, observedAt: null, limits: [] });
    const s = await a.start({ cwd: home, mode: "ask" });
    await runTurn(s, "first");
    await waitFor(async () => (await a.usage()).limits.length === 2 && (await a.usage()).plan === "max");
    const snap = await a.usage();
    expect(snap).toEqual({
      plan: "max",
      live: false,
      observedAt: t,
      limits: [
        { id: "five_hour", usedPercent: 42, windowMinutes: 300, resetsAt: new Date(1757484000 * 1000), rejected: false },
        { id: "seven_day", usedPercent: 81, windowMinutes: 10080, resetsAt: new Date(1757808000 * 1000), rejected: false },
      ],
    });
    await runTurn(s, "second");
    await waitFor(async () => (await a.usage()).limits[0]?.rejected === true);
    const after = await a.usage();
    expect(after.limits.map((l) => l.id)).toEqual(["five_hour", "seven_day"]);
    expect(after.limits[0]).toMatchObject({ usedPercent: 100, rejected: true, resetsAt: new Date(1757490000 * 1000) });
    // 저장 파일: 다른 어댑터 인스턴스(재시작)도 같은 값을 읽고, 이메일은 없다.
    const raw = await readFile(join(dataDir, "usage", "claude.json"), "utf8");
    expect(raw).not.toContain("alice@example.com");
    expect(await new RateLimitStore(dataDir).load("claude")).toEqual(after);
    expect(await adapter(queryFn).usage()).toEqual(after);
    await s.close();
  });

  it("accountInfo 실패면 plan 은 null 로 남고 한도는 저장된다", async () => {
    const hooks: FakeQueryHooks = {
      accountInfo: async () => {
        throw new Error("no account");
      },
    };
    const { queryFn } = makeFakeQueryFn(async (_m, { emit }) => {
      await emit(fakeRateLimitEvent({ status: "allowed", rateLimitType: "five_hour", utilization: 0.1 }));
      await emit(fakeResult());
    }, hooks);
    const a = adapter(queryFn);
    const s = await a.start({ cwd: home, mode: "ask" });
    await runTurn(s);
    await waitFor(async () => (await a.usage()).limits.length === 1);
    expect(await a.usage()).toMatchObject({ plan: null, live: false, limits: [{ id: "five_hour", usedPercent: 10 }] });
    await s.close();
  });
});

describe("ClaudeAdapter 모델 목록과 변경", () => {
  it("라이브 세션도 캐시도 없으면 정적 기본 목록", async () => {
    const { queryFn } = makeFakeQueryFn(async () => undefined);
    const models = await adapter(queryFn).listModels();
    expect(models).toEqual(STATIC_CLAUDE_MODELS);
    expect(models.map((m) => m.id)).toEqual(["sonnet", "opus", "haiku"]);
    expect(models[0]).toMatchObject({ displayName: "Sonnet", isDefault: true, efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" });
    expect(models.filter((m) => m.isDefault)).toHaveLength(1);
  });

  it("세션 시작 직후 supportedModels 로 캐시를 채우고, listModels 는 캐시를 쓴다", async () => {
    const { queryFn, queries } = makeFakeQueryFn(async () => undefined, { supportedModels: async () => SDK_MODELS });
    const a = adapter(queryFn);
    const s = await a.start({ cwd: home, mode: "ask" });
    const cachePath = join(dataDir, "models", "claude.json");
    await waitFor(async () => readFile(cachePath, "utf8").then(() => true, () => false));
    expect(queries[0]!.supportedModels).toHaveBeenCalledTimes(1);
    const models = await a.listModels();
    expect(models).toEqual([
      { id: "claude-opus-5", displayName: "Opus 5", description: "best", isDefault: true, efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
      { id: "claude-sonnet-5", displayName: "Sonnet 5", description: null, isDefault: false, efforts: ["low", "medium", "high"], defaultEffort: "high" },
      { id: "claude-haiku-4-5", displayName: "Haiku 4.5", description: "fast", isDefault: false, efforts: [], defaultEffort: null },
    ]);
    // 캐시가 신선하면 다시 부르지 않는다.
    expect(queries[0]!.supportedModels).toHaveBeenCalledTimes(1);
    await s.close();
    // 세션이 닫힌 뒤에도 캐시(24시간)로 답한다.
    expect(await adapter(queryFn).listModels()).toEqual(models);
  });

  it("캐시가 24시간 지났고 라이브 세션이 있으면 supportedModels 로 갱신, 없으면 오래된 캐시를 쓴다", async () => {
    const cachePath = join(dataDir, "models", "claude.json");
    await mkdir(join(dataDir, "models"), { recursive: true });
    const stale = { savedAt: new Date(Date.now() - 25 * 3600_000).toISOString(), models: [{ id: "old", displayName: "Old", description: null, isDefault: true, efforts: [], defaultEffort: null }] };
    await writeFile(cachePath, JSON.stringify(stale), "utf8");
    const old = new Date(Date.now() - 25 * 3600_000);
    await utimes(cachePath, old, old);
    const { queryFn, queries } = makeFakeQueryFn(async () => undefined, { supportedModels: async () => SDK_MODELS });
    const a = adapter(queryFn);
    expect((await a.listModels()).map((m) => m.id)).toEqual(["old"]);
    const s = await a.start({ cwd: home, mode: "ask" });
    await waitFor(async () => (await a.listModels())[0]?.id === "claude-opus-5");
    expect(queries[0]!.supportedModels).toHaveBeenCalled();
    await s.close();
  });

  it("supportedModels 실패는 무시하고 정적 목록으로 답한다", async () => {
    const { queryFn } = makeFakeQueryFn(async () => undefined, {
      supportedModels: async () => {
        throw new Error("control request failed");
      },
    });
    const a = adapter(queryFn);
    const s = await a.start({ cwd: home, mode: "ask" });
    await new Promise((r) => setTimeout(r, 30));
    expect(await a.listModels()).toEqual(STATIC_CLAUDE_MODELS);
    await s.close();
  });

  it("StartOptions.model/effort 는 Options.model/effort 로 전달된다", async () => {
    const { queryFn, queries } = makeFakeQueryFn(async () => undefined);
    const s = await adapter(queryFn).start({ cwd: home, mode: "ask", model: "claude-opus-5", effort: "max" });
    expect(queries[0]!.options).toMatchObject({ model: "claude-opus-5", effort: "max" });
    await s.close();
    const { queryFn: q2, queries: qs2 } = makeFakeQueryFn(async () => undefined);
    const s2 = await adapter(q2).start({ cwd: home, mode: "ask" });
    expect(qs2[0]!.options).not.toHaveProperty("effort");
    expect(qs2[0]!.options).not.toHaveProperty("model");
    await s2.close();
  });

  it("setModel → q.setModel 호출 후 usage{model} 이벤트, 다음 프로세스에도 적용", async () => {
    const { queryFn, queries } = makeFakeQueryFn(async (_m, { emit }) => {
      await emit(fakeResult());
    });
    const s = await adapter(queryFn).start({ cwd: home, mode: "ask" });
    await runTurn(s);
    await s.setModel("claude-sonnet-5");
    expect(queries[0]!.setModel).toHaveBeenCalledWith("claude-sonnet-5");
    const ev = await collect(s.events, (e) => e.type === "usage");
    expect(ev.at(-1)).toEqual({ type: "usage", model: "claude-sonnet-5" });
    await s.setEffort("low");
    await runTurn(s, "2");
    expect(queries[1]!.options).toMatchObject({ model: "claude-sonnet-5", effort: "low", resume: FAKE_SID });
    await s.close();
  });

  it("setEffort → 다음 sendTurn 전에 resume + effort 로 재시작하고 usage{effort} 이벤트", async () => {
    const { queryFn, queries } = makeFakeQueryFn(async (_m, { emit }) => {
      await emit(fakeResult());
    });
    const s = await adapter(queryFn).start({ cwd: home, mode: "ask", effort: "high" });
    await runTurn(s);
    await s.setEffort("max");
    // 재시작은 다음 턴 전까지 미룬다.
    expect(queries).toHaveLength(1);
    expect(queries[0]!.close).not.toHaveBeenCalled();
    const t2 = await runTurn(s, "2");
    expect(queries).toHaveLength(2);
    expect(queries[0]!.close).toHaveBeenCalled();
    expect(queries[1]!.options).toMatchObject({ resume: FAKE_SID, effort: "max" });
    expect(t2).toContainEqual({ type: "usage", effort: "max" });
    // 재시작한 프로세스의 init 도 effort 를 싣는다.
    expect(t2).toContainEqual({ type: "usage", model: "m", effort: "max" });
    expect(t2.some((e) => e.type === "turn.completed")).toBe(true);
    // 두 번 연속 setEffort 는 마지막 값으로 한 번만 재시작한다.
    await s.setEffort("low");
    await s.setEffort("medium");
    await runTurn(s, "3");
    expect(queries).toHaveLength(3);
    expect(queries[2]!.options).toMatchObject({ resume: FAKE_SID, effort: "medium" });
    await s.close();
  });
});
