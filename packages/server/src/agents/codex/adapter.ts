import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SessionMode, TurnInput } from "@mam/protocol";
import { z } from "zod";
import { AgentBusyError, AgentUnavailableError, ConflictError } from "../../errors.js";
import { newId } from "../../ids.js";
import { RateLimitStore } from "../../usage/rate-limit-store.js";
import { AsyncQueue } from "../fake/async-queue.js";
import { resolveBinary } from "../resolve-bin.js";
import type { AgentAdapter, AgentEvent, AgentModel, AgentProbe, AgentSession, AgentUsageSnapshot, ItemDraft, StartOptions } from "../types.js";
import type { AccountRateLimitsUpdatedNotification } from "./generated/v2/AccountRateLimitsUpdatedNotification.js";
import type { AskForApproval } from "./generated/v2/AskForApproval.js";
import type { GetAccountParams } from "./generated/v2/GetAccountParams.js";
import type { GetAccountRateLimitsResponse } from "./generated/v2/GetAccountRateLimitsResponse.js";
import type { GetAccountResponse } from "./generated/v2/GetAccountResponse.js";
import type { ModelListParams } from "./generated/v2/ModelListParams.js";
import type { ModelListResponse } from "./generated/v2/ModelListResponse.js";
import type { RateLimitSnapshot } from "./generated/v2/RateLimitSnapshot.js";
import type { SandboxMode } from "./generated/v2/SandboxMode.js";
import type { SandboxPolicy } from "./generated/v2/SandboxPolicy.js";
import type { ThreadResumeParams } from "./generated/v2/ThreadResumeParams.js";
import type { ThreadResumeResponse } from "./generated/v2/ThreadResumeResponse.js";
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams.js";
import type { ThreadStartResponse } from "./generated/v2/ThreadStartResponse.js";
import type { TurnInterruptParams } from "./generated/v2/TurnInterruptParams.js";
import type { TurnStartParams } from "./generated/v2/TurnStartParams.js";
import type { TurnStartResponse } from "./generated/v2/TurnStartResponse.js";
import type { UserInput } from "./generated/v2/UserInput.js";
import type { JsonRpcPeer } from "./jsonrpc.js";
import { CodexEventMapper, mapRateLimitSnapshot, toAgentModels, type MappedApproval } from "./mapping.js";
import { initializeAppServer, spawnCodexAppServer, withEphemeralAppServer, type CodexProcess } from "./process.js";

type Logger = Pick<Console, "info" | "warn" | "error">;

export interface CodexAdapterOptions {
  /** 테스트 주입. 기본 `spawnCodexAppServer`. */
  spawnFn?: typeof spawnCodexAppServer;
  /** 기본 `MAM_CODEX_BIN` → `resolveBinary('codex')`. */
  binPath?: string;
  home?: string;
  /** 한도 캐시(`usage/codex.json`)·모델 캐시(`models/codex.json`) 디렉토리. 기본 `<home>/.mam`. */
  dataDir?: string;
  logger?: Logger;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  now?: () => Date;
}

/** `usage()` 는 저장소에 이 시간 안의 조회 결과가 있으면 그것을 쓴다(ADR-016). */
export const USAGE_CACHE_TTL_MS = 60_000;
export const MODELS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const ModelsCacheSchema = z.object({
  savedAt: z.string(),
  models: z.array(
    z.object({
      id: z.string(),
      displayName: z.string(),
      description: z.string().nullable(),
      isDefault: z.boolean(),
      efforts: z.array(z.string()),
      defaultEffort: z.string().nullable(),
    }),
  ),
});

function cloneModels(models: readonly AgentModel[]): AgentModel[] {
  return models.map((m) => ({ ...m, efforts: [...m.efforts] }));
}

const MODE_MAP: Record<SessionMode, { approvalPolicy: AskForApproval; sandbox: SandboxMode }> = {
  ask: { approvalPolicy: "untrusted", sandbox: "workspace-write" },
  "auto-edit": { approvalPolicy: "on-request", sandbox: "workspace-write" },
  "full-auto": { approvalPolicy: "never", sandbox: "danger-full-access" },
  plan: { approvalPolicy: "on-request", sandbox: "read-only" },
};

/** PROTOCOL.md 4절 모드 매핑. */
export function toCodexPolicy(mode: SessionMode): { approvalPolicy: AskForApproval; sandbox: SandboxMode } {
  return MODE_MAP[mode];
}

/** `turn/start` 의 `sandboxPolicy` 는 `SandboxMode` 와 다른 구조체다. */
export function toSandboxPolicy(sandbox: SandboxMode, cwd: string): SandboxPolicy {
  switch (sandbox) {
    case "read-only":
      return { type: "readOnly", networkAccess: false };
    case "workspace-write":
      return { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
    default:
      return { type: "dangerFullAccess" };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function firstLine(bin: string, args: string[], timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (v: string | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, timeoutMs);
    child.stdout?.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    child.on("error", () => finish(null));
    child.on("close", () => finish(out.split("\n")[0]?.trim() || null));
  });
}

/** `~/.codex/auth.json` 존재 여부와 `tokens.id_token`(JWT) payload 의 email. 검증하지 않는다. */
export async function readCodexAuth(home: string): Promise<{ loggedIn: boolean; account: string | null }> {
  let raw: string;
  try {
    raw = await readFile(join(home, ".codex", "auth.json"), "utf8");
  } catch {
    return { loggedIn: false, account: null };
  }
  try {
    const data = JSON.parse(raw) as { tokens?: { id_token?: string } };
    const jwt = data.tokens?.id_token;
    const payload = jwt?.split(".")[1];
    if (!payload) return { loggedIn: true, account: null };
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: unknown };
    return { loggedIn: true, account: typeof claims.email === "string" ? claims.email : null };
  } catch {
    return { loggedIn: true, account: null };
  }
}

interface SessionConfig {
  proc: CodexProcess;
  threadId: string;
  start: StartOptions;
  /** `thread/start`·`thread/resume` 응답의 모델과 effort. */
  model: string;
  reasoningEffort: string | null;
  resumed: boolean;
  logger: Logger;
  now: () => Date;
  /** `account/rateLimits/updated` 알림. 어댑터가 저장소에 병합한다. */
  onRateLimits?: (rateLimits: RateLimitSnapshot) => void;
  onClose?: () => void;
}

interface PendingApproval extends MappedApproval {
  resolve: (response: unknown) => void;
}

export class CodexSession implements AgentSession {
  nativeId: string | undefined;
  readonly events: AsyncIterable<AgentEvent>;
  private readonly out = new AsyncQueue<AgentEvent>();
  private readonly mapper: CodexEventMapper;
  private readonly pending = new Map<string, PendingApproval>();
  private mode: SessionMode;
  /** PATCH 로 바뀐 값. 다음 `turn/start` 의 `model`/`effort` 로 간다(PROTOCOL PATCH). */
  private model: string | undefined;
  private effort: string | undefined;
  private turnActive = false;
  private closed = false;

  constructor(private readonly cfg: SessionConfig) {
    this.nativeId = cfg.threadId;
    this.mode = cfg.start.mode;
    this.model = cfg.start.model;
    this.effort = cfg.start.effort;
    this.events = this.out;
    this.mapper = new CodexEventMapper({ threadId: cfg.threadId, cwd: cfg.start.cwd, resumed: cfg.resumed, now: () => cfg.now().toISOString(), logger: cfg.logger });
    cfg.proc.peer.onNotification((method, params) => {
      if (method === "account/rateLimits/updated") {
        const n = params as AccountRateLimitsUpdatedNotification;
        if (n && typeof n === "object" && n.rateLimits) cfg.onRateLimits?.(n.rateLimits);
        return;
      }
      for (const ev of this.mapper.map(method, params)) this.emit(ev);
    });
    cfg.proc.peer.onRequest((method, params) => this.handleRequest(method, params));
    cfg.proc.child.on("exit", (code, signal) => this.onExit(`code=${code ?? "null"} signal=${signal ?? "null"}`));
    cfg.proc.child.on("error", (err) => this.onExit(err.message));
    this.out.push({ type: "native_id", nativeId: cfg.threadId });
    this.out.push({ type: "status", status: "idle" });
    // 스레드 응답의 모델 → Session.model. effort 는 시작 옵션이 우선, 없으면 스레드가 보고한 값.
    const effort = this.effort ?? (cfg.reasoningEffort ? cfg.reasoningEffort : undefined);
    this.out.push({ type: "usage", model: cfg.model, ...(effort !== undefined ? { effort } : {}) });
  }

  /** 열려 있는 JSON-RPC 피어(어댑터의 `usage()`/`listModels()` 용). 닫혔으면 undefined. */
  get livePeer(): JsonRpcPeer | undefined {
    return this.closed || this.cfg.proc.peer.isClosed ? undefined : this.cfg.proc.peer;
  }

  private emit(ev: AgentEvent): void {
    if (ev.type === "turn.completed") this.turnActive = false;
    this.out.push(ev);
  }

  async sendTurn(input: TurnInput): Promise<void> {
    if (this.closed) throw new ConflictError("Codex 세션이 닫혔습니다");
    if (this.turnActive) throw new AgentBusyError();
    this.turnActive = true;
    const { approvalPolicy, sandbox } = toCodexPolicy(this.mode);
    const userInput: UserInput[] = [{ type: "text", text: input.text, text_elements: [] }];
    for (const a of input.attachments ?? []) userInput.push({ type: "image", url: `data:${a.mediaType};base64,${a.base64}` });
    const params: TurnStartParams = {
      threadId: this.cfg.threadId,
      input: userInput,
      cwd: this.cfg.start.cwd,
      approvalPolicy,
      sandboxPolicy: toSandboxPolicy(sandbox, this.cfg.start.cwd),
      ...(this.model ? { model: this.model } : {}),
      ...(this.effort ? { effort: this.effort } : {}),
    };
    this.mapper.expectUserMessage();
    try {
      const res = await this.cfg.proc.peer.request<TurnStartResponse>("turn/start", params);
      this.mapper.beginTurn(res.turn.id);
    } catch (err) {
      this.turnActive = false;
      throw new ConflictError(`turn/start 실패: ${errorMessage(err)}`);
    }
    const turnId = this.mapper.currentTurnId as string;
    const at = this.cfg.now().toISOString();
    const item: ItemDraft = {
      id: newId("itm"),
      turnId,
      kind: "user_message",
      status: "completed",
      createdAt: at,
      completedAt: at,
      payload: { text: input.text, attachments: input.attachments ?? [] },
    };
    this.out.push({ type: "item.started", item });
  }

  async interrupt(): Promise<void> {
    const turnId = this.mapper.currentCodexTurnId;
    if (!this.turnActive || !turnId || this.closed) return;
    const params: TurnInterruptParams = { threadId: this.cfg.threadId, turnId };
    try {
      await this.cfg.proc.peer.request("turn/interrupt", params);
    } catch (err) {
      this.cfg.logger.warn(`[codex] turn/interrupt 실패: ${errorMessage(err)}`);
    }
  }

  async respondApproval(approvalId: string, optionId: string, inputs?: Record<string, string>, message?: string): Promise<void> {
    const p = this.pending.get(approvalId);
    if (!p) throw new ConflictError(`알 수 없는 승인 요청입니다: ${approvalId}`);
    const allowed = optionId === "abort" || p.approval.options.some((o) => o.id === optionId);
    if (!allowed) throw new ConflictError(`지원하지 않는 옵션입니다: ${optionId}`);
    this.settle(p, optionId, "client", p.respond(optionId, inputs, message));
  }

  private settle(p: PendingApproval, optionId: string, by: "client" | "system", response: unknown): void {
    this.pending.delete(p.approval.approvalId);
    const at = this.cfg.now().toISOString();
    const item: ItemDraft = {
      id: p.approval.itemId,
      turnId: p.turnId,
      kind: "approval",
      status: "completed",
      createdAt: p.approval.requestedAt,
      completedAt: at,
      payload: { ...p.approval, resolution: { optionId, by, at } },
    };
    this.out.push({ type: "item.completed", item });
    p.resolve(response);
  }

  private cancelPending(): void {
    for (const p of [...this.pending.values()]) this.settle(p, "abort", "system", p.respond("abort", undefined, "세션이 중단되었습니다"));
  }

  private handleRequest(method: string, params: unknown): Promise<unknown> {
    const mapped = this.mapper.mapRequest(method, params);
    if (!mapped) return Promise.reject(new Error(`지원하지 않는 요청: ${method}`));
    if (this.closed) return Promise.resolve(mapped.respond("abort"));
    return new Promise<unknown>((resolve) => {
      const p: PendingApproval = { ...mapped, resolve };
      this.pending.set(mapped.approval.approvalId, p);
      const { approval } = mapped;
      this.out.push({
        type: "item.started",
        item: { id: approval.itemId, turnId: mapped.turnId, kind: "approval", status: "running", createdAt: approval.requestedAt, completedAt: null, payload: approval },
      });
      this.out.push({ type: "approval.requested", approval });
    });
  }

  /** 저장 후 다음 `turn/start` 에 반영한다. 즉시 적용 요청은 ClientRequest 에 없다. */
  async setMode(mode: SessionMode): Promise<void> {
    this.mode = mode;
  }

  /** 다음 `turn/start` 부터 적용. 즉시 `usage { model }` 로 알린다(PROTOCOL PATCH). */
  async setModel(model: string): Promise<void> {
    if (this.closed) throw new ConflictError("Codex 세션이 닫혔습니다");
    this.model = model;
    this.out.push({ type: "usage", model });
  }

  async setEffort(effort: string): Promise<void> {
    if (this.closed) throw new ConflictError("Codex 세션이 닫혔습니다");
    this.effort = effort;
    this.out.push({ type: "usage", effort });
  }

  private onExit(detail: string): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelPending();
    for (const ev of this.mapper.cancelOpen()) this.out.push(ev);
    this.out.push({ type: "error", message: `Codex 프로세스가 예기치 않게 종료되었습니다 (${detail})`, recoverable: false });
    this.turnActive = false;
    this.out.end();
    this.cfg.onClose?.();
    // 대기 승인의 cancel 회신이 마이크로태스크로 써진 뒤 피어를 닫는다.
    setImmediate(() => this.cfg.proc.peer.close());
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cancelPending();
    for (const ev of this.mapper.cancelOpen()) this.out.push(ev);
    this.turnActive = false;
    await this.cfg.proc.kill();
    this.cfg.proc.peer.close();
    this.out.end();
    this.cfg.onClose?.();
  }
}

export class CodexAdapter implements AgentAdapter {
  readonly kind = "codex" as const;
  private readonly spawnFn: typeof spawnCodexAppServer;
  private readonly home: string;
  private readonly dataDir: string;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly store: RateLimitStore;
  private readonly sessions = new Set<CodexSession>();
  /** 저장소 쓰기 직렬화(세션의 알림과 usage() 가 동시에 저장할 수 있다). */
  private chain: Promise<void> = Promise.resolve();
  private inflightUsage: Promise<AgentUsageSnapshot> | undefined;
  private inflightModels: Promise<AgentModel[]> | undefined;
  private binPromise: Promise<string | null> | undefined;

  constructor(private readonly opts: CodexAdapterOptions = {}) {
    this.spawnFn = opts.spawnFn ?? spawnCodexAppServer;
    this.home = opts.home ?? homedir();
    this.dataDir = opts.dataDir ?? join(this.home, ".mam");
    this.logger = opts.logger ?? console;
    this.now = opts.now ?? (() => new Date());
    this.store = new RateLimitStore(this.dataDir, { now: this.now });
  }

  private resolveBin(): Promise<string | null> {
    if (!this.binPromise) {
      const env = this.opts.env ?? process.env;
      this.binPromise = this.opts.binPath ? Promise.resolve(this.opts.binPath) : resolveBinary("codex", env.MAM_CODEX_BIN);
    }
    return this.binPromise;
  }

  async probe(): Promise<AgentProbe> {
    const binPath = await this.resolveBin();
    const auth = await readCodexAuth(this.home);
    const probe: AgentProbe = { available: binPath !== null, loggedIn: auth.loggedIn, account: auth.account };
    if (binPath) {
      probe.binPath = binPath;
      probe.version = (await firstLine(binPath, ["--version"])) ?? "unknown";
    }
    return probe;
  }

  private livePeer(): JsonRpcPeer | undefined {
    for (const s of this.sessions) {
      const peer = s.livePeer;
      if (peer) return peer;
    }
    return undefined;
  }

  /** 라이브 세션의 피어가 있으면 그것으로, 없으면 임시 app-server(항상 종료)로 `fn` 을 실행한다. */
  private async withPeer<T>(fn: (peer: JsonRpcPeer) => Promise<T>): Promise<T> {
    const live = this.livePeer();
    if (live) return fn(live);
    const binPath = await this.resolveBin();
    if (!binPath) throw new AgentUnavailableError("codex 실행파일을 찾을 수 없습니다");
    return withEphemeralAppServer(
      {
        binPath,
        cwd: this.home,
        env: this.opts.env ?? process.env,
        logger: this.logger,
        spawnFn: this.spawnFn,
        ...(this.opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: this.opts.requestTimeoutMs } : {}),
      },
      fn,
    );
  }

  private persist(mutate: (prev: AgentUsageSnapshot | null) => AgentUsageSnapshot | null): Promise<void> {
    this.chain = this.chain
      .then(async () => {
        const next = mutate(await this.store.load("codex"));
        if (next) await this.store.save("codex", next);
      })
      .catch((err: unknown) => this.logger.warn(`[codex] 한도 저장 실패: ${errorMessage(err)}`));
    return this.chain;
  }

  /** `account/rateLimits/updated` 는 부분 갱신이다. 있는 창과 plan 만 덮어쓴다. */
  private mergeRateLimits(rateLimits: RateLimitSnapshot): Promise<void> {
    const { plan, limits } = mapRateLimitSnapshot(rateLimits);
    return this.persist((prev) => {
      const merged = prev ? [...prev.limits] : [];
      for (const l of limits) {
        const idx = merged.findIndex((m) => m.id === l.id);
        if (idx >= 0) merged[idx] = l;
        else merged.push(l);
      }
      return { plan: plan ?? prev?.plan ?? null, live: true, observedAt: this.now(), limits: merged };
    });
  }

  /** `account/rateLimits/read` + `account/read`(plan, 실패는 null). */
  private async readUsage(peer: JsonRpcPeer): Promise<AgentUsageSnapshot> {
    const res = await peer.request<GetAccountRateLimitsResponse>("account/rateLimits/read");
    const { plan: planFromLimits, limits } = mapRateLimitSnapshot(res.rateLimits);
    let plan = planFromLimits;
    try {
      const params: GetAccountParams = { refreshToken: false };
      const account = await peer.request<GetAccountResponse>("account/read", params);
      if (account.account?.type === "chatgpt") plan = account.account.planType || plan;
      else if (account.account) plan = null;
    } catch (err) {
      this.logger.warn(`[codex] account/read 실패: ${errorMessage(err)}`);
    }
    return { plan, live: true, observedAt: this.now(), limits };
  }

  /** 60초 캐시 → 라이브/임시 피어로 즉시 조회(`live: true`) → 실패 시 마지막 저장값(`live: false`) 또는 빈 스냅샷. */
  usage(): Promise<AgentUsageSnapshot> {
    if (!this.inflightUsage) {
      this.inflightUsage = this.usageUncached().finally(() => {
        this.inflightUsage = undefined;
      });
    }
    return this.inflightUsage;
  }

  private async usageUncached(): Promise<AgentUsageSnapshot> {
    await this.chain;
    const cached = await this.store.load("codex", USAGE_CACHE_TTL_MS);
    if (cached) return cached;
    try {
      const snapshot = await this.withPeer((peer) => this.readUsage(peer));
      await this.persist(() => snapshot);
      return snapshot;
    } catch (err) {
      this.logger.warn(`[codex] 한도 조회 실패: ${errorMessage(err)}`);
      const last = await this.store.load("codex");
      return last ? { ...last, live: false } : { plan: null, live: false, observedAt: null, limits: [] };
    }
  }

  private modelsCachePath(): string {
    return join(this.dataDir, "models", "codex.json");
  }

  private async loadModelsCache(): Promise<{ models: AgentModel[]; ageMs: number } | null> {
    let raw: string;
    try {
      raw = await readFile(this.modelsCachePath(), "utf8");
    } catch {
      return null;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return null;
    }
    const parsed = ModelsCacheSchema.safeParse(json);
    if (!parsed.success || parsed.data.models.length === 0) return null;
    return { models: parsed.data.models, ageMs: this.now().getTime() - Date.parse(parsed.data.savedAt) };
  }

  private async saveModelsCache(models: AgentModel[]): Promise<void> {
    const path = this.modelsCachePath();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify({ savedAt: this.now().toISOString(), models }, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(tmp, path);
  }

  /** `model/list { includeHidden: false }` 를 `nextCursor` 가 끝날 때까지 읽는다. */
  private async readModels(peer: JsonRpcPeer): Promise<AgentModel[]> {
    const models: AgentModel[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 50; page += 1) {
      const params: ModelListParams = { includeHidden: false, ...(cursor ? { cursor } : {}) };
      const res: ModelListResponse = await peer.request<ModelListResponse>("model/list", params);
      models.push(...toAgentModels(res.data));
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    if (models.length === 0) throw new Error("model/list 가 빈 목록을 돌려줬습니다");
    return models;
  }

  /** 캐시(24시간) → 라이브/임시 피어의 `model/list` → 오래된 캐시 → 실패. */
  listModels(): Promise<AgentModel[]> {
    if (!this.inflightModels) {
      this.inflightModels = this.listModelsUncached().finally(() => {
        this.inflightModels = undefined;
      });
    }
    return this.inflightModels;
  }

  private async listModelsUncached(): Promise<AgentModel[]> {
    const cached = await this.loadModelsCache();
    if (cached && cached.ageMs < MODELS_CACHE_TTL_MS) return cloneModels(cached.models);
    try {
      const models = await this.withPeer((peer) => this.readModels(peer));
      await this.saveModelsCache(models);
      return cloneModels(models);
    } catch (err) {
      if (cached) {
        this.logger.warn(`[codex] 모델 목록 조회 실패, 오래된 캐시 사용: ${errorMessage(err)}`);
        return cloneModels(cached.models);
      }
      throw err;
    }
  }

  async start(start: StartOptions): Promise<CodexSession> {
    const binPath = await this.resolveBin();
    if (!binPath) throw new AgentUnavailableError("codex 실행파일을 찾을 수 없습니다");
    const proc = this.spawnFn({
      binPath,
      cwd: start.cwd,
      env: this.opts.env ?? process.env,
      logger: this.logger,
      ...(this.opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: this.opts.requestTimeoutMs } : {}),
    });
    const { approvalPolicy, sandbox } = toCodexPolicy(start.mode);
    let threadId: string;
    let model: string;
    let reasoningEffort: string | null;
    const resumed = start.resumeNativeId !== undefined;
    try {
      await initializeAppServer(proc.peer);
      if (start.resumeNativeId) {
        const params: ThreadResumeParams = { threadId: start.resumeNativeId, cwd: start.cwd, approvalPolicy, sandbox };
        const res = await proc.peer.request<ThreadResumeResponse>("thread/resume", params);
        threadId = res.thread.id;
        model = res.model;
        reasoningEffort = res.reasoningEffort;
      } else {
        const params: ThreadStartParams = { cwd: start.cwd, approvalPolicy, sandbox, ...(start.model ? { model: start.model } : {}) };
        const res = await proc.peer.request<ThreadStartResponse>("thread/start", params);
        threadId = res.thread.id;
        model = res.model;
        reasoningEffort = res.reasoningEffort;
      }
    } catch (err) {
      proc.peer.close();
      await proc.kill(false);
      throw new AgentUnavailableError(`Codex 시작 실패: ${errorMessage(err)}`);
    }
    let session: CodexSession | undefined;
    session = new CodexSession({
      proc,
      threadId,
      start,
      model,
      reasoningEffort,
      resumed,
      logger: this.logger,
      now: this.now,
      onRateLimits: (rateLimits) => void this.mergeRateLimits(rateLimits),
      onClose: () => {
        if (session) this.sessions.delete(session);
      },
    });
    this.sessions.add(session);
    return session;
  }
}
