import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionMode, TurnInput } from "@mam/protocol";
import { AgentBusyError, AgentUnavailableError, ConflictError } from "../../errors.js";
import { newId } from "../../ids.js";
import { SERVER_VERSION } from "../../index.js";
import { AsyncQueue } from "../fake/async-queue.js";
import { resolveBinary } from "../resolve-bin.js";
import type { AgentAdapter, AgentEvent, AgentModel, AgentProbe, AgentSession, AgentUsageSnapshot, ItemDraft, StartOptions } from "../types.js";
import type { InitializeParams } from "./generated/InitializeParams.js";
import type { InitializeResponse } from "./generated/InitializeResponse.js";
import type { AskForApproval } from "./generated/v2/AskForApproval.js";
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
import { CodexEventMapper, type MappedApproval } from "./mapping.js";
import { spawnCodexAppServer, type CodexProcess } from "./process.js";

type Logger = Pick<Console, "info" | "warn" | "error">;

export interface CodexAdapterOptions {
  /** 테스트 주입. 기본 `spawnCodexAppServer`. */
  spawnFn?: typeof spawnCodexAppServer;
  /** 기본 `MAM_CODEX_BIN` → `resolveBinary('codex')`. */
  binPath?: string;
  home?: string;
  logger?: Logger;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  now?: () => Date;
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
  logger: Logger;
  now: () => Date;
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
  private turnActive = false;
  private closed = false;

  constructor(private readonly cfg: SessionConfig) {
    this.nativeId = cfg.threadId;
    this.mode = cfg.start.mode;
    this.events = this.out;
    this.mapper = new CodexEventMapper({ threadId: cfg.threadId, cwd: cfg.start.cwd, now: () => cfg.now().toISOString(), logger: cfg.logger });
    cfg.proc.peer.onNotification((method, params) => {
      for (const ev of this.mapper.map(method, params)) this.emit(ev);
    });
    cfg.proc.peer.onRequest((method, params) => this.handleRequest(method, params));
    cfg.proc.child.on("exit", (code, signal) => this.onExit(`code=${code ?? "null"} signal=${signal ?? "null"}`));
    cfg.proc.child.on("error", (err) => this.onExit(err.message));
    this.out.push({ type: "native_id", nativeId: cfg.threadId });
    this.out.push({ type: "status", status: "idle" });
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
      ...(this.cfg.start.model ? { model: this.cfg.start.model } : {}),
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

  /** 스텁(step 3 에서 적용). 지금은 저장만 한다. */
  pendingModel: string | undefined;
  pendingEffort: string | undefined;

  async setModel(model: string): Promise<void> {
    this.pendingModel = model;
  }

  async setEffort(effort: string): Promise<void> {
    this.pendingEffort = effort;
  }

  private onExit(detail: string): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelPending();
    for (const ev of this.mapper.cancelOpen()) this.out.push(ev);
    this.out.push({ type: "error", message: `Codex 프로세스가 예기치 않게 종료되었습니다 (${detail})`, recoverable: false });
    this.turnActive = false;
    this.out.end();
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
  }
}

export class CodexAdapter implements AgentAdapter {
  readonly kind = "codex" as const;
  private readonly spawnFn: typeof spawnCodexAppServer;
  private readonly home: string;
  private readonly logger: Logger;
  private binPromise: Promise<string | null> | undefined;

  constructor(private readonly opts: CodexAdapterOptions = {}) {
    this.spawnFn = opts.spawnFn ?? spawnCodexAppServer;
    this.home = opts.home ?? homedir();
    this.logger = opts.logger ?? console;
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

  /** 스텁(step 3 이 채운다). */
  async listModels(): Promise<AgentModel[]> {
    return [];
  }

  async usage(): Promise<AgentUsageSnapshot> {
    return { plan: null, live: false, observedAt: null, limits: [] };
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
    try {
      const init: InitializeParams = {
        clientInfo: { name: "mam", title: "mac-agent-machine", version: SERVER_VERSION },
        capabilities: { experimentalApi: true, requestAttestation: false },
      };
      await proc.peer.request<InitializeResponse>("initialize", init);
      proc.peer.notify("initialized");
      if (start.resumeNativeId) {
        const params: ThreadResumeParams = { threadId: start.resumeNativeId, cwd: start.cwd, approvalPolicy, sandbox };
        threadId = (await proc.peer.request<ThreadResumeResponse>("thread/resume", params)).thread.id;
      } else {
        const params: ThreadStartParams = { cwd: start.cwd, approvalPolicy, sandbox, ...(start.model ? { model: start.model } : {}) };
        threadId = (await proc.peer.request<ThreadStartResponse>("thread/start", params)).thread.id;
      }
    } catch (err) {
      proc.peer.close();
      await proc.kill(false);
      throw new AgentUnavailableError(`Codex 시작 실패: ${errorMessage(err)}`);
    }
    return new CodexSession({ proc, threadId, start, logger: this.logger, now: this.opts.now ?? (() => new Date()) });
  }
}
