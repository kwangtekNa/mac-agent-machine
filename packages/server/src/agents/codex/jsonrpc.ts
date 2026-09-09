import type { Readable, Writable } from "node:stream";

type Logger = Pick<Console, "info" | "warn" | "error">;

/** 응답의 `error` 또는 피어 종료/타임아웃. */
export class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "JsonRpcError";
  }
}

export interface JsonRpcPeerOptions {
  logger?: Logger;
  /** 기본 30초. 0 이면 타임아웃 없음. */
  requestTimeoutMs?: number;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | undefined;
}

type NotificationHandler = (method: string, params: unknown) => void;
type RequestHandler = (method: string, params: unknown) => Promise<unknown>;

/** 줄 단위 JSON-RPC 피어. 요청 `{id,method,params}`, 응답 `{id,result|error}`, 알림 `{method,params}`. */
export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private readonly closeHandlers = new Set<() => void>();
  private requestHandler: RequestHandler | undefined;
  private buffer = "";
  private closed = false;
  private readonly logger: Logger;
  private readonly requestTimeoutMs: number;
  private readonly onData = (chunk: Buffer | string): void => this.feed(chunk.toString());
  private readonly onEnd = (): void => this.close();

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    opts: JsonRpcPeerOptions = {},
  ) {
    this.logger = opts.logger ?? console;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    input.on("data", this.onData);
    input.on("end", this.onEnd);
    input.on("close", this.onEnd);
    input.on("error", this.onEnd);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = this.requestTimeoutMs): Promise<T> {
    if (this.closed) return Promise.reject(new JsonRpcError(-32001, `피어가 닫혔습니다 (${method})`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new JsonRpcError(-32002, `요청 타임아웃 (${method}, ${timeoutMs}ms)`));
            }, timeoutMs)
          : undefined;
      this.pending.set(id, { method, resolve: (v) => resolve(v as T), reject, timer });
      this.write(params === undefined ? { id, method } : { id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  /** 서버→클라이언트 요청 처리기. 반환값은 `{id,result}`, throw 는 `{id,error:{code:-32000,message}}` 로 회신. */
  onRequest(handler: RequestHandler): void {
    this.requestHandler = handler;
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  /** 대기 중 요청을 전부 reject 하고 입력 리스너를 제거한다. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.input.off("data", this.onData);
    this.input.off("end", this.onEnd);
    this.input.off("close", this.onEnd);
    this.input.off("error", this.onEnd);
    for (const [id, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new JsonRpcError(-32001, `피어가 닫혔습니다 (${p.method})`));
      this.pending.delete(id);
    }
    for (const h of this.closeHandlers) h();
  }

  private write(msg: Record<string, unknown>): void {
    if (this.closed || this.output.destroyed || !this.output.writable) return;
    try {
      this.output.write(`${JSON.stringify(msg)}\n`);
    } catch (err) {
      this.logger.warn(`[jsonrpc] write 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private feed(chunk: string): void {
    this.buffer += chunk;
    let nl = this.buffer.indexOf("\n");
    while (nl >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line.length > 0) this.dispatchLine(line);
      nl = this.buffer.indexOf("\n");
    }
  }

  private dispatchLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      this.logger.warn(`[jsonrpc] 잘못된 JSON 줄 무시 (${line.length}자)`);
      return;
    }
    if (!msg || typeof msg !== "object") {
      this.logger.warn("[jsonrpc] 객체가 아닌 메시지 무시");
      return;
    }
    const m = msg as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
    if (typeof m.method === "string") {
      if (m.id !== undefined && m.id !== null) this.handleRequest(m.id as string | number, m.method, m.params);
      else for (const h of this.notificationHandlers) h(m.method, m.params);
      return;
    }
    if (typeof m.id === "number" || typeof m.id === "string") {
      const p = this.pending.get(Number(m.id));
      if (!p) {
        this.logger.warn(`[jsonrpc] 대기 중이 아닌 응답 무시 id=${String(m.id)}`);
        return;
      }
      this.pending.delete(Number(m.id));
      if (p.timer) clearTimeout(p.timer);
      if (m.error !== undefined && m.error !== null) {
        const e = m.error as { code?: number; message?: string; data?: unknown };
        p.reject(new JsonRpcError(e.code ?? -32000, e.message ?? "unknown error", e.data));
      } else p.resolve(m.result);
      return;
    }
    this.logger.warn("[jsonrpc] method 도 id 도 없는 메시지 무시");
  }

  private handleRequest(id: string | number, method: string, params: unknown): void {
    const handler = this.requestHandler;
    if (!handler) {
      this.write({ id, error: { code: -32601, message: `지원하지 않는 요청: ${method}` } });
      return;
    }
    handler(method, params).then(
      (result) => this.write({ id, result: result === undefined ? null : result }),
      (err: unknown) => this.write({ id, error: { code: -32000, message: err instanceof Error ? err.message : String(err) } }),
    );
  }
}
