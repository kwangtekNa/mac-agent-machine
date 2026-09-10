import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { JsonRpcPeer } from "../../src/agents/codex/jsonrpc.js";
import type { CodexProcess, SpawnCodexOptions } from "../../src/agents/codex/process.js";
import type { AgentEvent } from "../../src/agents/types.js";

export const THREAD = "thr_test_1";
export const quietLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

export interface Msg { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: unknown }

/** 메서드별 응답 생성기. 반환값이 result, throw 하면 error 응답. */
export type FakeHandler = (params: unknown, id: number | string) => unknown;

export const FAKE_TOKEN_USAGE = { inputTokens: 10, cachedInputTokens: 2, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 15 };

/** PassThrough 위의 가짜 app-server. 클라이언트 요청에 자동 응답하고, 알림/서버요청을 스크립트대로 보낸다. */
export class FakeAppServer {
  readonly toClient = new PassThrough();
  readonly fromClient = new PassThrough();
  readonly received: Msg[] = [];
  readonly child = new EventEmitter() as unknown as ChildProcess;
  readonly handlers = new Map<string, FakeHandler>();
  spawnOpts: SpawnCodexOptions | undefined;
  spawned = 0;
  killed = 0;
  /** thread/start·resume 응답의 model/reasoningEffort. */
  model = "gpt-5";
  reasoningEffort: string | null = null;
  private waiters: Array<{ pred: (m: Msg) => boolean; resolve: (m: Msg) => void }> = [];
  private nextId = 1000;
  private buf = "";

  constructor(readonly threadId = THREAD) {
    this.fromClient.on("data", (c: Buffer) => {
      this.buf += c.toString();
      let i = this.buf.indexOf("\n");
      while (i >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (line.trim()) this.onLine(JSON.parse(line) as Msg);
        i = this.buf.indexOf("\n");
      }
    });
  }

  on(method: string, handler: FakeHandler): this {
    this.handlers.set(method, handler);
    return this;
  }

  spawnFn = (opts: SpawnCodexOptions): CodexProcess => {
    this.spawnOpts = opts;
    this.spawned += 1;
    const peer = new JsonRpcPeer(this.toClient, this.fromClient, { logger: quietLogger, requestTimeoutMs: 2000 });
    return {
      peer,
      child: this.child,
      kill: async () => {
        this.killed += 1;
      },
    };
  };

  private onLine(m: Msg): void {
    this.received.push(m);
    const idx = this.waiters.findIndex((w) => w.pred(m));
    if (idx >= 0) this.waiters.splice(idx, 1)[0]!.resolve(m);
    if (m.id !== undefined && m.method) this.autoRespond(m);
  }

  private autoRespond(m: Msg): void {
    const handler = this.handlers.get(m.method as string);
    if (handler) {
      Promise.resolve()
        .then(() => handler(m.params, m.id as number | string))
        .then(
          (result) => this.write({ id: m.id, result: result === undefined ? null : result }),
          (err: unknown) => this.write({ id: m.id, error: { code: -32000, message: err instanceof Error ? err.message : String(err) } }),
        );
      return;
    }
    switch (m.method) {
      case "initialize":
        this.write({ id: m.id, result: { userAgent: "codex/test" } });
        break;
      case "thread/start":
      case "thread/resume":
        this.write({
          id: m.id,
          result: {
            thread: { id: this.threadId, cwd: (m.params as { cwd: string }).cwd, preview: "", modelProvider: "openai", createdAt: 0, updatedAt: 0, status: { type: "idle" }, path: "", cliVersion: "0", source: "vscode", gitInfo: null, name: null, turns: [] },
            model: this.model,
            modelProvider: "openai",
            cwd: "",
            approvalPolicy: "on-request",
            sandbox: { type: "readOnly" },
            reasoningEffort: this.reasoningEffort,
          },
        });
        break;
      case "turn/start": {
        const turnId = `turn_${m.id}`;
        this.write({ id: m.id, result: { turn: { id: turnId, status: "inProgress", items: [], error: null } } });
        this.notify("turn/started", { threadId: this.threadId, turn: { id: turnId, status: "inProgress", items: [], error: null } });
        break;
      }
      case "turn/interrupt":
        this.write({ id: m.id, result: {} });
        break;
      default:
        this.write({ id: m.id, error: { code: -32601, message: `unknown ${m.method}` } });
    }
  }

  write(obj: unknown): void {
    this.toClient.write(`${JSON.stringify(obj)}\n`);
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  /** 서버→클라이언트 요청. 같은 id 의 클라이언트 응답을 돌려준다. */
  request(method: string, params: unknown): Promise<Msg> {
    const id = this.nextId++;
    const reply = this.waitFor((m) => m.id === id && m.method === undefined);
    this.write({ id, method, params });
    return reply;
  }

  waitFor(pred: (m: Msg) => boolean, timeoutMs = 3000): Promise<Msg> {
    const found = this.received.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("waitFor timeout")), timeoutMs);
      this.waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  }

  calls(method: string): Msg[] {
    return this.received.filter((m) => m.method === method);
  }

  turnId(): string {
    const req = this.received.filter((m) => m.method === "turn/start").at(-1);
    return `turn_${req?.id}`;
  }

  /** `thread/tokenUsage/updated` 알림. total 만 주면 last 는 같은 값, 컨텍스트 창은 200000. */
  tokenUsage(total: Partial<typeof FAKE_TOKEN_USAGE>, opts: { last?: Partial<typeof FAKE_TOKEN_USAGE>; modelContextWindow?: number | null } = {}): void {
    const t = { ...FAKE_TOKEN_USAGE, ...total };
    const last = opts.last ? { ...FAKE_TOKEN_USAGE, ...opts.last } : t;
    const modelContextWindow = opts.modelContextWindow === undefined ? 200000 : opts.modelContextWindow;
    this.notify("thread/tokenUsage/updated", { threadId: this.threadId, turnId: this.turnId(), tokenUsage: { total: t, last, modelContextWindow } });
  }

  completeTurn(status = "completed"): void {
    const turnId = this.turnId();
    this.notify("thread/tokenUsage/updated", { threadId: this.threadId, turnId, tokenUsage: { total: FAKE_TOKEN_USAGE, last: FAKE_TOKEN_USAGE, modelContextWindow: null } });
    this.notify("turn/completed", { threadId: this.threadId, turn: { id: turnId, status, items: [], error: null } });
  }

  exit(code: number): void {
    (this.child as unknown as EventEmitter).emit("exit", code, null);
  }
}

/** spawn 마다 새 FakeAppServer 를 만든다(임시 프로세스 테스트). `configure` 로 서버별 응답을 심는다. */
export function makeFakeSpawn(configure?: (server: FakeAppServer, index: number) => void): { spawnFn: (opts: SpawnCodexOptions) => CodexProcess; servers: FakeAppServer[] } {
  const servers: FakeAppServer[] = [];
  const spawnFn = (opts: SpawnCodexOptions): CodexProcess => {
    const server = new FakeAppServer();
    configure?.(server, servers.length);
    servers.push(server);
    return server.spawnFn(opts);
  };
  return { spawnFn, servers };
}

export async function take(iter: AsyncIterator<AgentEvent>, until: (e: AgentEvent) => boolean, limit = 60): Promise<AgentEvent[]> {
  const got: AgentEvent[] = [];
  while (got.length < limit) {
    const r = await Promise.race([
      iter.next(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timeout after [${got.map((e) => e.type).join(",")}]`)), 3000)),
    ]);
    if (r.done) break;
    got.push(r.value);
    if (until(r.value)) break;
  }
  return got;
}
