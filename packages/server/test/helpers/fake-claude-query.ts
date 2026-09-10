import type { AccountInfo, ModelInfo, Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { vi } from "vitest";
import type { QueryFn } from "../../src/agents/claude/adapter.js";
import { AsyncQueue } from "../../src/agents/fake/async-queue.js";

export const FAKE_SID = "11111111-2222-3333-4444-555555555555";

export type FakeHandler = (msg: SDKUserMessage, ctx: { options: Options; emit: (m: SDKMessage) => Promise<void> }) => Promise<void>;

export interface FakeQuery {
  options: Options;
  interrupt: ReturnType<typeof vi.fn>;
  setPermissionMode: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  supportedModels: ReturnType<typeof vi.fn>;
  accountInfo: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

export interface FakeQueryHooks {
  /** `supportedModels()` 응답. 기본은 빈 배열. 예외를 던지면 호출 실패를 흉내낸다. */
  supportedModels?: () => Promise<ModelInfo[]>;
  /** `accountInfo()` 응답. 기본 `{}`. */
  accountInfo?: () => Promise<AccountInfo>;
  /** init 메시지의 model. 기본 `options.model ?? "m"`. */
  initModel?: (options: Options) => string;
}

/**
 * 가짜 Query: init 을 먼저 내고 사용자 메시지마다 handler 가 SDKMessage 를 재생한다.
 * handler 예외는 이터레이터 예외로 전달된다. control 메서드는 vi.fn 으로 기록한다.
 */
export function makeFakeQueryFn(handler: FakeHandler, hooks: FakeQueryHooks = {}): { queryFn: QueryFn; queries: FakeQuery[] } {
  const queries: FakeQuery[] = [];
  const queryFn = ((params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => {
    const options = params.options ?? {};
    const outQueue = new AsyncQueue<SDKMessage>();
    const fake: FakeQuery = {
      options,
      interrupt: vi.fn(async () => undefined),
      setPermissionMode: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      supportedModels: vi.fn(async () => (hooks.supportedModels ? hooks.supportedModels() : [])),
      accountInfo: vi.fn(async () => (hooks.accountInfo ? hooks.accountInfo() : {})),
      close: vi.fn(() => outQueue.end()),
    };
    queries.push(fake);
    const emit = async (m: SDKMessage): Promise<void> => {
      outQueue.push(m);
      await new Promise((r) => setTimeout(r, 0));
    };
    (async () => {
      try {
        const model = hooks.initModel ? hooks.initModel(options) : (options.model ?? "m");
        outQueue.push({ type: "system", subtype: "init", session_id: FAKE_SID, model, permissionMode: options.permissionMode ?? "default" } as unknown as SDKMessage);
        for await (const msg of params.prompt as AsyncIterable<SDKUserMessage>) await handler(msg, { options, emit });
        outQueue.end();
      } catch (err) {
        outQueue.push({ __throw: err } as unknown as SDKMessage);
      }
    })();
    options.abortController?.signal.addEventListener("abort", () => outQueue.end());
    const iter = outQueue[Symbol.asyncIterator]();
    const q = {
      ...fake,
      next: async () => {
        const r = await iter.next();
        const thrown = !r.done ? (r.value as unknown as { __throw?: unknown }).__throw : undefined;
        if (thrown) throw thrown;
        return r;
      },
      return: async () => ({ value: undefined, done: true as const }),
      throw: async (e: unknown) => {
        throw e;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    return q as unknown as Query;
  }) as unknown as QueryFn;
  return { queryFn, queries };
}

export interface FakeResultOptions {
  subtype?: "success" | "error_during_execution" | "error_max_turns";
  totalCostUsd?: number;
  usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } | null;
  modelUsage?: Record<string, { contextWindow: number }>;
  isError?: boolean;
}

/** `result` 메시지. `usage: null` 이면 키를 아예 빼서 usage 없는 SDKResultError 를 흉내낸다. */
export function fakeResult(opts: FakeResultOptions = {}): SDKMessage {
  const subtype = opts.subtype ?? "success";
  const usage = opts.usage === undefined ? { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 } : opts.usage;
  const modelUsage = Object.fromEntries(
    Object.entries(opts.modelUsage ?? { m: { contextWindow: 200000 } }).map(([k, v]) => [
      k,
      { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0, contextWindow: v.contextWindow, maxOutputTokens: 32000 },
    ]),
  );
  return {
    type: "result",
    subtype,
    session_id: FAKE_SID,
    uuid: "x",
    is_error: opts.isError ?? subtype !== "success",
    duration_ms: 1200,
    duration_api_ms: 1000,
    num_turns: 1,
    ...(subtype === "success" ? { result: "ok" } : { errors: [] }),
    total_cost_usd: opts.totalCostUsd ?? 0.01,
    ...(usage === null ? {} : { usage }),
    modelUsage,
    permission_denials: [],
    stop_reason: "end_turn",
  } as unknown as SDKMessage;
}

export function fakeRateLimitEvent(info: Record<string, unknown>): SDKMessage {
  return { type: "rate_limit_event", session_id: FAKE_SID, uuid: "rl", rate_limit_info: info } as unknown as SDKMessage;
}
