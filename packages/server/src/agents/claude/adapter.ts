import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  query as sdkQuery,
  type EffortLevel,
  type ModelInfo,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKUserMessage,
  type SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import type { Approval, SessionMode, TurnInput } from "@mam/protocol";
import { z } from "zod";
import { AgentBusyError, ConflictError } from "../../errors.js";
import { newId } from "../../ids.js";
import { AsyncQueue } from "../fake/async-queue.js";
import { resolveBinary } from "../resolve-bin.js";
import { RateLimitStore } from "../../usage/rate-limit-store.js";
import type { AgentAdapter, AgentEvent, AgentModel, AgentProbe, AgentSession, AgentUsageSnapshot, ItemDraft, RateLimitObservation, StartOptions } from "../types.js";
import { detectLogin, readOauthToken } from "./credentials.js";
import { approvalKindFor, buildFilePatch, ClaudeEventMapper, mapRateLimitInfo, toolTitle } from "./mapping.js";

export type QueryFn = typeof sdkQuery;
type Logger = Pick<Console, "info" | "warn" | "error">;

export interface ClaudeAdapterOptions {
  /** 테스트 주입. 기본 SDK `query`. */
  queryFn?: QueryFn;
  /** 기본 `os.homedir()`. */
  home?: string;
  /** 한도 관측(`usage/claude.json`)·모델 캐시(`models/claude.json`) 디렉토리. 기본 `<home>/.mam`. */
  dataDir?: string;
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
const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
export const MODELS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function isEffortLevel(value: string | undefined): value is EffortLevel {
  return value !== undefined && (EFFORT_LEVELS as readonly string[]).includes(value);
}

/** 라이브 세션도 캐시도 없을 때의 정적 기본 목록(ADR-016). */
export const STATIC_CLAUDE_MODELS: readonly AgentModel[] = [
  { id: "sonnet", displayName: "Sonnet", description: null, isDefault: true, efforts: [...EFFORT_LEVELS], defaultEffort: "high" },
  { id: "opus", displayName: "Opus", description: null, isDefault: false, efforts: [...EFFORT_LEVELS], defaultEffort: "high" },
  { id: "haiku", displayName: "Haiku", description: null, isDefault: false, efforts: [...EFFORT_LEVELS], defaultEffort: "high" },
];

function cloneModels(models: readonly AgentModel[]): AgentModel[] {
  return models.map((m) => ({ ...m, efforts: [...m.efforts] }));
}

/** `Query.supportedModels()` → AgentModel. 첫 항목이 기본. efforts 는 `supportedEffortLevels`, 없고 `supportsEffort===false` 면 []. */
export function toAgentModels(infos: ModelInfo[]): AgentModel[] {
  return infos.map((m, i) => {
    const efforts: string[] = m.supportedEffortLevels ? [...m.supportedEffortLevels] : m.supportsEffort === false ? [] : [...EFFORT_LEVELS];
    return {
      id: m.value,
      displayName: m.displayName || m.value,
      description: m.description ? m.description : null,
      isDefault: i === 0,
      efforts,
      defaultEffort: efforts.includes("high") ? "high" : (efforts[0] ?? null),
    };
  });
}

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

const EMPTY_USAGE: AgentUsageSnapshot = { plan: null, live: false, observedAt: null, limits: [] };

function cloneSnapshot(s: AgentUsageSnapshot): AgentUsageSnapshot {
  return { ...s, observedAt: s.observedAt ? new Date(s.observedAt.getTime()) : null, limits: s.limits.map((l) => ({ ...l, resetsAt: l.resetsAt ? new Date(l.resetsAt.getTime()) : null })) };
}

/**
 * `rate_limit_event` 관측값을 rateLimitType 별로 하나씩 보관하고 `RateLimitStore` 에 저장한다(ADR-016, `live: false`).
 * 쓰기는 직렬화한다(같은 사용자의 세션 여러 개가 동시에 관측할 수 있다).
 */
class ClaudeUsageTracker {
  private state: AgentUsageSnapshot | undefined;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly store: RateLimitStore, private readonly now: () => Date, private readonly logger: Logger) {}

  private async load(): Promise<AgentUsageSnapshot> {
    if (!this.state) this.state = (await this.store.load("claude")) ?? cloneSnapshot(EMPTY_USAGE);
    return this.state;
  }

  private enqueue(mutate: (s: AgentUsageSnapshot) => void): Promise<void> {
    this.chain = this.chain
      .then(async () => {
        const s = await this.load();
        mutate(s);
        await this.store.save("claude", s);
      })
      .catch((err: unknown) => this.logger.warn(`[claude] 한도 저장 실패: ${errorMessage(err)}`));
    return this.chain;
  }

  observe(obs: RateLimitObservation): Promise<void> {
    return this.enqueue((s) => {
      const idx = s.limits.findIndex((l) => l.id === obs.id);
      if (idx >= 0) s.limits[idx] = obs;
      else s.limits.push(obs);
      s.observedAt = this.now();
    });
  }

  setPlan(plan: string | null): Promise<void> {
    return this.enqueue((s) => {
      s.plan = plan;
    });
  }

  async snapshot(): Promise<AgentUsageSnapshot> {
    await this.chain;
    return cloneSnapshot(await this.load());
  }
}

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
  /** `rate_limit_event` 관측. 어댑터가 저장소에 넣는다. */
  onRateLimit?: (obs: RateLimitObservation) => void;
  /** 첫 `system/init` 직후 1회(accountInfo, supportedModels 캐시). */
  onInit?: (q: Query) => void;
  /** close 가 기다린다(백그라운드 저장이 끝난 뒤 디렉토리를 지울 수 있게). */
  onClose?: () => Promise<void>;
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
  private model: string | undefined;
  private effort: string | undefined;
  /** setEffort 후 다음 sendTurn 전에 프로세스를 resume 으로 다시 연다. */
  private restartPending = false;
  private initHooked = false;
  private turnActive = false;
  private turnWaiters: Array<() => void> = [];
  private closed = false;
  private discarding = false;

  constructor(private readonly cfg: SessionConfig) {
    this.nativeId = cfg.start.resumeNativeId;
    this.mode = cfg.start.mode;
    this.model = cfg.start.model;
    this.effort = cfg.start.effort;
    this.events = this.out;
    this.mapper = new ClaudeEventMapper({ cwd: cfg.start.cwd, now: () => cfg.now().toISOString(), logger: cfg.logger });
    this.openProcess();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** 열려 있는 SDK Query(control 요청용). 프로세스가 없으면 undefined. */
  get liveQuery(): Query | undefined {
    return this.closed ? undefined : this.q;
  }

  private openProcess(): void {
    const prompt = new AsyncQueue<SDKUserMessage>();
    const abort = new AbortController();
    const { start, logger } = this.cfg;
    if (this.effort !== undefined && !isEffortLevel(this.effort)) {
      logger.warn(`[claude] 알 수 없는 effort 값은 넘기지 않습니다: ${this.effort}`);
    }
    this.mapper.effort = this.effort;
    this.mapper.resetCostBaseline();
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
      ...(this.model ? { model: this.model } : {}),
      ...(isEffortLevel(this.effort) ? { effort: this.effort } : {}),
      ...(this.cfg.binPath ? { pathToClaudeCodeExecutable: this.cfg.binPath } : {}),
      // 역할 프롬프트(팀원 세션). Claude Code 기본 프롬프트(도구 규칙)를 유지하려고 preset + append 만 쓴다.
      // `snapshot` 은 SDK 기본값(첫 요청에 기록)을 그대로 둔다: 시스템 프롬프트는 세션 첫 요청에 고정되므로
      // 프롬프트 수정은 다음 세션(새 프로세스·reset)부터 적용된다(PROTOCOL.md 6.2 `appliesAt: "next_session"`, ADR-017).
      ...(start.instructions ? { systemPrompt: { type: "preset", preset: "claude_code", append: start.instructions } } : {}),
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
        if (msg.type === "rate_limit_event") {
          this.onRateLimit(msg.rate_limit_info);
          continue;
        }
        for (const ev of this.mapper.map(msg)) this.emit(ev);
        if (msg.type === "system" && msg.subtype === "init" && !this.initHooked) {
          this.initHooked = true;
          this.cfg.onInit?.(q);
        }
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
    // resume 재시작의 init 이 턴 도중에 내는 idle 은 세션 상태를 흔들지 않는다.
    if (ev.type === "status" && ev.status === "idle" && this.turnActive) return;
    this.out.push(ev);
  }

  /** 값 형태만 로그(토큰 없음). 저장은 어댑터의 tracker 가 한다. */
  private onRateLimit(info: Parameters<typeof mapRateLimitInfo>[0]): void {
    this.cfg.logger.info(
      `[claude] rate_limit type=${info.rateLimitType ?? "?"} status=${info.status} utilization=${info.utilization ?? "?"} resetsAt=${info.resetsAt ?? "?"}`,
    );
    const obs = mapRateLimitInfo(info, this.cfg.now());
    if (obs) this.cfg.onRateLimit?.(obs);
  }

  private finishTurn(): void {
    this.turnActive = false;
    for (const w of this.turnWaiters.splice(0)) w();
  }

  async sendTurn(input: TurnInput): Promise<void> {
    if (this.closed) throw new ConflictError("Claude 세션이 닫혔습니다");
    if (this.turnActive) throw new AgentBusyError();
    const restartForEffort = this.restartPending;
    if (restartForEffort) {
      this.restartPending = false;
      if (this.q) this.discardProcess();
    }
    if (!this.q) this.openProcess();
    if (restartForEffort && this.effort !== undefined) this.emit({ type: "usage", effort: this.effort });
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

  /** 즉시 적용: 라이브 프로세스면 `q.setModel()`, 이후 프로세스에는 `Options.model`. 성공 시 `usage { model }`. */
  async setModel(model: string): Promise<void> {
    if (this.closed) throw new ConflictError("Claude 세션이 닫혔습니다");
    if (this.q) await this.q.setModel(model);
    this.model = model;
    this.emit({ type: "usage", model });
  }

  /** `Options.effort` 는 프로세스 시작 옵션이라 다음 `sendTurn` 전에 `resume` 으로 다시 연다(PROTOCOL PATCH). */
  async setEffort(effort: string): Promise<void> {
    if (this.closed) throw new ConflictError("Claude 세션이 닫혔습니다");
    this.effort = effort;
    this.restartPending = true;
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
    await this.cfg.onClose?.();
  }
}

export class ClaudeAdapter implements AgentAdapter {
  readonly kind = "claude" as const;
  private readonly queryFn: QueryFn;
  private readonly home: string;
  private readonly dataDir: string;
  private readonly settingSources: SettingSource[];
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly tracker: ClaudeUsageTracker;
  private readonly sessions = new Set<ClaudeSession>();
  /** 세션 시작 직후의 백그라운드 작업(accountInfo, supportedModels). close 가 기다린다. */
  private readonly background = new Set<Promise<void>>();
  private binPromise: Promise<string | null> | undefined;

  constructor(private readonly opts: ClaudeAdapterOptions = {}) {
    this.queryFn = opts.queryFn ?? sdkQuery;
    this.home = opts.home ?? homedir();
    this.dataDir = opts.dataDir ?? join(this.home, ".mam");
    this.settingSources = opts.settingSources ?? DEFAULT_SETTING_SOURCES;
    this.logger = opts.logger ?? console;
    this.now = opts.now ?? (() => new Date());
    this.tracker = new ClaudeUsageTracker(new RateLimitStore(this.dataDir, { now: this.now }), this.now, this.logger);
  }

  private modelsCachePath(): string {
    return join(this.dataDir, "models", "claude.json");
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

  /** 라이브 Query 로 `supportedModels()` 를 받아 캐시한다. 빈 목록은 실패로 본다. */
  private async refreshModels(q: Query): Promise<AgentModel[]> {
    const models = toAgentModels(await q.supportedModels());
    if (models.length === 0) throw new Error("supportedModels 가 빈 목록을 돌려줬습니다");
    await this.saveModelsCache(models);
    return models;
  }

  private liveQuery(): Query | undefined {
    for (const s of this.sessions) {
      const q = s.liveQuery;
      if (q) return q;
    }
    return undefined;
  }

  /** 캐시(24시간) → 라이브 세션의 `supportedModels()` → 오래된 캐시 → 정적 기본 목록. */
  async listModels(): Promise<AgentModel[]> {
    const cached = await this.loadModelsCache();
    if (cached && cached.ageMs < MODELS_CACHE_TTL_MS) return cloneModels(cached.models);
    const q = this.liveQuery();
    if (q) {
      try {
        return await this.refreshModels(q);
      } catch (err) {
        this.logger.warn(`[claude] 모델 목록 조회 실패: ${errorMessage(err)}`);
      }
    }
    return cloneModels(cached ? cached.models : STATIC_CLAUDE_MODELS);
  }

  /** 마지막 관측값(`live: false`). 관측 없음 → `limits: []`. */
  usage(): Promise<AgentUsageSnapshot> {
    return this.tracker.snapshot();
  }

  /** 세션 시작 직후 1회: 구독 plan 과 모델 목록 캐시. 실패는 경고만. */
  private onSessionInit(q: Query): void {
    const account = Promise.resolve()
      .then(() => q.accountInfo())
      .then((info) => {
        const plan = typeof info.subscriptionType === "string" && info.subscriptionType.length > 0 ? info.subscriptionType : null;
        this.logger.info(`[claude] account plan=${plan ?? "?"}`);
        return this.tracker.setPlan(plan);
      })
      .catch((err: unknown) => this.logger.warn(`[claude] accountInfo 실패: ${errorMessage(err)}`));
    const models = Promise.resolve()
      .then(() => this.refreshModels(q))
      .then(() => undefined)
      .catch((err: unknown) => this.logger.warn(`[claude] 모델 목록 캐시 실패: ${errorMessage(err)}`));
    for (const p of [account, models]) {
      this.background.add(p);
      void p.finally(() => this.background.delete(p));
    }
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
    let session: ClaudeSession | undefined;
    session = new ClaudeSession({
      queryFn: this.queryFn,
      start,
      binPath,
      settingSources: this.settingSources,
      env: buildChildEnv(this.opts.env ?? process.env, token),
      logger: this.logger,
      interruptTimeoutMs: this.opts.interruptTimeoutMs ?? 5000,
      extraOptions: this.opts.extraOptions ?? {},
      now: this.now,
      onRateLimit: (obs) => void this.tracker.observe(obs),
      onInit: (q) => this.onSessionInit(q),
      onClose: async () => {
        if (session) this.sessions.delete(session);
        await Promise.all([...this.background]);
        await this.tracker.snapshot();
      },
    });
    this.sessions.add(session);
    return session;
  }
}
