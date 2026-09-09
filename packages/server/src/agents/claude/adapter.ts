import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  query as sdkQuery,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKUserMessage,
  type SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import type { Approval, SessionMode, TurnInput } from "@mam/protocol";
import { AgentBusyError, ConflictError } from "../../errors.js";
import { newId } from "../../ids.js";
import { AsyncQueue } from "../fake/async-queue.js";
import { resolveBinary } from "../resolve-bin.js";
import type { AgentAdapter, AgentEvent, AgentProbe, AgentSession, ItemDraft, StartOptions } from "../types.js";
import { detectLogin, readOauthToken } from "./credentials.js";
import { approvalKindFor, buildFilePatch, ClaudeEventMapper, toolTitle } from "./mapping.js";

export type QueryFn = typeof sdkQuery;
type Logger = Pick<Console, "info" | "warn" | "error">;

export interface ClaudeAdapterOptions {
  /** 테스트 주입. 기본 SDK `query`. */
  queryFn?: QueryFn;
  /** 기본 `os.homedir()`. */
  home?: string;
  /** 기본 `MAM_CLAUDE_BIN` → `resolveBinary('claude')`. 없으면 SDK 번들 실행파일. */
  binPath?: string;
  /** 기본 `['user','project','local']`: 사용자 ~/.claude 설정·프로젝트 CLAUDE.md·훅·MCP 를 그대로 적용. */
  settingSources?: SettingSource[];
  logger?: Logger;
  /** `interrupt()` 후 result 를 기다리는 시간(ms). 기본 5000. */
  interruptTimeoutMs?: number;
  /** 자식 프로세스 환경의 바탕. 기본 `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** 통합 테스트 등에서 SDK 옵션을 덧붙인다(`maxTurns`, `allowedTools`). */
  extraOptions?: Partial<Options>;
  now?: () => Date;
}

const MODE_MAP: Record<SessionMode, PermissionMode> = {
  ask: "default",
  "auto-edit": "acceptEdits",
  "full-auto": "bypassPermissions",
  plan: "plan",
};

/** PROTOCOL.md 4절 모드 매핑. */
export function toPermissionMode(mode: SessionMode): PermissionMode {
  return MODE_MAP[mode];
}

const DETAIL_LIMIT = 4 * 1024;
const DEFAULT_SETTING_SOURCES: SettingSource[] = ["user", "project", "local"];

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `process.env` 복사본에서 중첩 세션 감지 변수를 지우고 토큰 파일이 있으면 OAuth 토큰을 넣는다. */
export function buildChildEnv(base: NodeJS.ProcessEnv, token: string | null): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  return env;
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

async function sdkVersion(): Promise<string> {
  try {
    const entry = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk");
    const pkg = JSON.parse(await readFile(join(dirname(entry), "package.json"), "utf8")) as { version?: string };
    return `sdk ${pkg.version ?? "unknown"}`;
  } catch {
    return "sdk unknown";
  }
}

interface SessionConfig {
  queryFn: QueryFn;
  start: StartOptions;
  binPath: string | null;
  settingSources: SettingSource[];
  env: Record<string, string | undefined>;
  logger: Logger;
  interruptTimeoutMs: number;
  extraOptions: Partial<Options>;
  now: () => Date;
}

interface PendingApproval {
  approval: Approval;
  turnId: string | null;
  input: Record<string, unknown>;
  suggestions: PermissionUpdate[];
  signal: AbortSignal;
  onAbort: () => void;
  resolve: (result: PermissionResult) => void;
}

/** SDK `query()` 하나 = 프로세스 하나. 강제 중단 후에는 다음 `sendTurn` 에서 `resume: nativeId` 로 새 프로세스를 연다. */
export class ClaudeSession implements AgentSession {
  nativeId: string | undefined;
  readonly events: AsyncIterable<AgentEvent>;
  private readonly out = new AsyncQueue<AgentEvent>();
  private readonly mapper: ClaudeEventMapper;
  private readonly pending = new Map<string, PendingApproval>();
  private prompt: AsyncQueue<SDKUserMessage> | undefined;
  private q: Query | undefined;
  private abort: AbortController | undefined;
  private loop: Promise<void> = Promise.resolve();
  private mode: SessionMode;
  private turnActive = false;
  private turnWaiters: Array<() => void> = [];
  private closed = false;
  private discarding = false;

  constructor(private readonly cfg: SessionConfig) {
    this.nativeId = cfg.start.resumeNativeId;
    this.mode = cfg.start.mode;
    this.events = this.out;
    this.mapper = new ClaudeEventMapper({ cwd: cfg.start.cwd, now: () => cfg.now().toISOString(), logger: cfg.logger });
    this.openProcess();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private openProcess(): void {
    const prompt = new AsyncQueue<SDKUserMessage>();
    const abort = new AbortController();
    const { start, logger } = this.cfg;
    const options: Options = {
      cwd: start.cwd,
      permissionMode: toPermissionMode(this.mode),
      includePartialMessages: true,
      settingSources: this.cfg.settingSources,
      canUseTool: (name, input, o) => this.canUseTool(name, input, o),
      abortController: abort,
      stderr: (line) => logger.warn(`[claude] ${line.trimEnd()}`),
      env: this.cfg.env,
      ...(this.nativeId ? { resume: this.nativeId } : {}),
      ...(start.model ? { model: start.model } : {}),
      ...(this.cfg.binPath ? { pathToClaudeCodeExecutable: this.cfg.binPath } : {}),
      ...this.cfg.extraOptions,
    };
    const q = this.cfg.queryFn({ prompt, options });
    this.prompt = prompt;
    this.abort = abort;
    this.q = q;
    this.discarding = false;
    this.loop = this.runLoop(q);
  }

  private async runLoop(q: Query): Promise<void> {
    let failure: unknown;
    let failed = false;
    try {
      for await (const msg of q) {
        if (this.q !== q) break;
        for (const ev of this.mapper.map(msg)) this.emit(ev);
      }
    } catch (err) {
      failure = err;
      failed = true;
    }
    const current = this.q === q;
    if (current) {
      this.q = undefined;
      this.prompt = undefined;
    }
    if (!current || this.closed || this.discarding) return;
    if (failed) {
      for (const ev of this.mapper.cancelOpen()) this.emit(ev);
      this.emit({ type: "error", message: `Claude 프로세스 오류: ${errorMessage(failure)}`, recoverable: false });
      this.finishTurn();
      this.out.end();
    } else if (this.turnActive) {
      for (const ev of this.mapper.cancelOpen()) this.emit(ev);
      this.emit({ type: "error", message: "Claude 프로세스가 턴 도중 종료되었습니다", recoverable: false });
      this.finishTurn();
      this.out.end();
    }
    // 유휴 중 정상 종료: 다음 sendTurn 에서 resume 으로 다시 연다.
  }

  private emit(ev: AgentEvent): void {
    if (ev.type === "native_id") this.nativeId = ev.nativeId;
    if (ev.type === "turn.completed") this.finishTurn();
    this.out.push(ev);
  }

  private finishTurn(): void {
    this.turnActive = false;
    for (const w of this.turnWaiters.splice(0)) w();
  }

  async sendTurn(input: TurnInput): Promise<void> {
    if (this.closed) throw new ConflictError("Claude 세션이 닫혔습니다");
    if (this.turnActive) throw new AgentBusyError();
    if (!this.q) this.openProcess();
    const turnId = newId("trn");
    this.turnActive = true;
    this.mapper.beginTurn(turnId);
    const at = this.cfg.now().toISOString();
    const attachments = input.attachments ?? [];
    this.out.push({
      type: "item.started",
      item: {
        id: newId("itm"),
        turnId,
        kind: "user_message",
        status: "completed",
        createdAt: at,
        completedAt: at,
        payload: { text: input.text, attachments },
      },
    });
    type Block = Exclude<SDKUserMessage["message"]["content"], string>[number];
    const content: Block[] = [{ type: "text", text: input.text }];
    for (const a of attachments) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: a.mediaType as "image/png", data: a.base64 },
      });
    }
    const message: SDKUserMessage = {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      ...(this.nativeId ? { session_id: this.nativeId } : {}),
    };
    this.prompt?.push(message);
  }

  async interrupt(): Promise<void> {
    if (!this.turnActive || !this.q) return;
    const q = this.q;
    try {
      await q.interrupt();
    } catch (err) {
      this.cfg.logger.warn(`[claude] interrupt 실패: ${errorMessage(err)}`);
    }
    const finished = await this.waitTurnEnd(this.cfg.interruptTimeoutMs);
    if (finished || this.q !== q) return;
    // 5초 안에 result 가 없으면 프로세스를 끝내고 다음 sendTurn 에서 resume 으로 다시 연다.
    this.discardProcess();
    for (const ev of this.mapper.cancelOpen()) this.emit(ev);
    this.rejectPending("abort", "system");
    this.emit({ type: "error", message: "턴을 강제 중단했습니다", recoverable: true });
    this.finishTurn();
    this.emit({ type: "status", status: "idle", reason: "interrupted" });
  }

  private waitTurnEnd(timeoutMs: number): Promise<boolean> {
    if (!this.turnActive) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.turnWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private discardProcess(): void {
    this.discarding = true;
    const q = this.q;
    this.q = undefined;
    this.prompt?.end();
    this.prompt = undefined;
    this.abort?.abort();
    try {
      q?.close();
    } catch {
      // 이미 종료됨
    }
  }

  async respondApproval(approvalId: string, optionId: string, _inputs?: Record<string, string>, message?: string): Promise<void> {
    const p = this.pending.get(approvalId);
    if (!p) throw new ConflictError(`알 수 없는 승인 요청입니다: ${approvalId}`);
    const allowed = optionId === "abort" || p.approval.options.some((o) => o.id === optionId);
    if (!allowed) throw new ConflictError(`지원하지 않는 옵션입니다: ${optionId}`);
    let result: PermissionResult;
    switch (optionId) {
      case "allow":
        result = { behavior: "allow", updatedInput: p.input };
        break;
      case "allow_session":
        result = { behavior: "allow", updatedInput: p.input, updatedPermissions: p.suggestions };
        break;
      case "abort":
        result = { behavior: "deny", message: message ?? "사용자가 중단했습니다", interrupt: true };
        break;
      default:
        result = { behavior: "deny", message: message ?? "사용자가 거절했습니다" };
    }
    this.settle(p, optionId, "client", result);
  }

  private settle(p: PendingApproval, optionId: string, by: "client" | "system", result: PermissionResult): void {
    this.pending.delete(p.approval.approvalId);
    p.signal.removeEventListener("abort", p.onAbort);
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
    p.resolve(result);
  }

  private rejectPending(optionId: "deny" | "abort", by: "client" | "system"): void {
    for (const p of [...this.pending.values()]) {
      this.settle(p, optionId, by, { behavior: "deny", message: "세션이 중단되었습니다", interrupt: true });
    }
  }

  private canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; suggestions?: PermissionUpdate[]; title?: string; decisionReason?: string },
  ): Promise<PermissionResult> {
    if (this.closed) return Promise.resolve({ behavior: "deny", message: "세션이 닫혔습니다", interrupt: true });
    const suggestions = options.suggestions ?? [];
    const title = toolTitle(toolName, input);
    let json = JSON.stringify(input, null, 2) ?? "{}";
    if (json.length > DETAIL_LIMIT) json = `${json.slice(0, DETAIL_LIMIT)}\n…(절단)`;
    const approvalOptions: Approval["options"] = [{ id: "allow", label: "허용", style: "primary" }];
    if (suggestions.length > 0) approvalOptions.push({ id: "allow_session", label: "세션 동안 허용", style: "secondary" });
    approvalOptions.push({ id: "deny", label: "거절", style: "destructive" });
    const requestedAt = this.cfg.now().toISOString();
    const approval: Approval = {
      approvalId: newId("apr"),
      itemId: newId("itm"),
      kind: approvalKindFor(toolName),
      title,
      prompt: options.title ?? `${toolName} 도구 사용을 허용할까요?`,
      detail: `cwd: ${this.cfg.start.cwd}\n${json}`,
      diff: buildFilePatch(toolName, input, this.cfg.start.cwd)?.patch ?? null,
      options: approvalOptions,
      inputFields: [],
      requestedAt,
    };
    const turnId = this.mapper.currentTurnId;
    return new Promise<PermissionResult>((resolve) => {
      const p: PendingApproval = { approval, turnId, input, suggestions, signal: options.signal, resolve, onAbort: () => undefined };
      p.onAbort = () => {
        if (this.pending.has(approval.approvalId)) this.settle(p, "deny", "system", { behavior: "deny", message: "취소되었습니다" });
      };
      this.pending.set(approval.approvalId, p);
      options.signal.addEventListener("abort", p.onAbort, { once: true });
      this.out.push({
        type: "item.started",
        item: { id: approval.itemId, turnId, kind: "approval", status: "running", createdAt: requestedAt, completedAt: null, payload: approval },
      });
      this.out.push({ type: "approval.requested", approval });
    });
  }

  async setMode(mode: SessionMode): Promise<void> {
    this.mode = mode;
    if (this.q) await this.q.setPermissionMode(toPermissionMode(mode));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending("abort", "system");
    const loop = this.loop;
    this.discardProcess();
    for (const ev of this.mapper.cancelOpen()) this.out.push(ev);
    this.finishTurn();
    await loop.catch(() => undefined);
    this.out.end();
  }
}

export class ClaudeAdapter implements AgentAdapter {
  readonly kind = "claude" as const;
  private readonly queryFn: QueryFn;
  private readonly home: string;
  private readonly settingSources: SettingSource[];
  private readonly logger: Logger;
  private binPromise: Promise<string | null> | undefined;

  constructor(private readonly opts: ClaudeAdapterOptions = {}) {
    this.queryFn = opts.queryFn ?? sdkQuery;
    this.home = opts.home ?? homedir();
    this.settingSources = opts.settingSources ?? DEFAULT_SETTING_SOURCES;
    this.logger = opts.logger ?? console;
  }

  private resolveBin(): Promise<string | null> {
    if (!this.binPromise) {
      const env = this.opts.env ?? process.env;
      this.binPromise = this.opts.binPath ? Promise.resolve(this.opts.binPath) : resolveBinary("claude", env.MAM_CLAUDE_BIN);
    }
    return this.binPromise;
  }

  async probe(): Promise<AgentProbe> {
    const binPath = await this.resolveBin();
    const version = binPath ? ((await firstLine(binPath, ["--version"])) ?? "unknown") : await sdkVersion();
    const login = await detectLogin(this.home, this.opts.env ?? process.env);
    const probe: AgentProbe = { available: true, version, loggedIn: login.loggedIn, account: login.account };
    if (binPath) probe.binPath = binPath;
    if (login.warning) probe.detail = login.warning;
    return probe;
  }

  async start(start: StartOptions): Promise<ClaudeSession> {
    const binPath = await this.resolveBin();
    const token = await readOauthToken(this.home);
    return new ClaudeSession({
      queryFn: this.queryFn,
      start,
      binPath,
      settingSources: this.settingSources,
      env: buildChildEnv(this.opts.env ?? process.env, token),
      logger: this.logger,
      interruptTimeoutMs: this.opts.interruptTimeoutMs ?? 5000,
      extraOptions: this.opts.extraOptions ?? {},
      now: this.opts.now ?? (() => new Date()),
    });
  }
}
