import { spawn, type ChildProcess } from "node:child_process";
import { chmod, chown, mkdir } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Config, UserEntry } from "../config.js";
import { AgentUnavailableError } from "../errors.js";

type Logger = Pick<Console, "info" | "warn" | "error">;
export type SupervisorState = "starting" | "ready" | "backoff" | "stopped";

export class SupervisorBackoffError extends AgentUnavailableError {
  constructor(macUser: string, readonly retryAt: number) {
    super(`agent-host 재시작 대기 중입니다: ${macUser}`);
  }
}

export const PROD_SOCKET_ROOT = "/var/run/mam";
export const DEV_SOCKET_ROOT = join(tmpdir(), "mam-dev");
export const CHILD_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
const DEV_PASSTHROUGH = ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG"];
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const STABLE_MS = 60_000;

export interface SupervisorOptions {
  config: Config;
  dev: boolean;
  spawnFn?: typeof spawn;
  socketRoot?: string;
  readyTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  sweepIntervalMs?: number;
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
}

export interface SupervisorStatus {
  macUser: string;
  pid?: number;
  state: SupervisorState;
  restarts: number;
}

interface Entry {
  user: UserEntry;
  socketPath: string;
  state: SupervisorState;
  child?: ChildProcess;
  pid?: number;
  restarts: number;
  crashStreak: number;
  backoffUntil: number;
  readyAt?: number;
  stopping: boolean;
  pending?: Promise<{ socketPath: string }>;
  exited?: Promise<void>;
}

function lineSink(emit: (line: string) => void): (chunk: Buffer) => void {
  let buf = "";
  return (chunk) => {
    buf += chunk.toString("utf8");
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) emit(line);
  };
}

/** 사용자별 agent-host 프로세스를 lazy 생성·감시·유휴 종료한다(ADR-011). root 를 가정하는 유일한 코드. */
export class AgentHostSupervisor {
  private readonly config: Config;
  private readonly dev: boolean;
  private readonly spawnFn: typeof spawn;
  readonly socketRoot: string;
  private readonly readyTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly now: () => number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly env: NodeJS.ProcessEnv;
  private readonly logger: Logger;
  private readonly entries = new Map<string, Entry>();
  private readonly lastActivity = new Map<string, number>();
  private readonly connections = new Map<string, number>();
  private readonly sweepIntervalMs: number;
  private closed = false;

  constructor(opts: SupervisorOptions) {
    this.config = opts.config;
    this.dev = opts.dev;
    this.spawnFn = opts.spawnFn ?? spawn;
    this.socketRoot = opts.socketRoot ?? (opts.dev ? DEV_SOCKET_ROOT : PROD_SOCKET_ROOT);
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 15_000;
    this.shutdownTimeoutMs = opts.shutdownTimeoutMs ?? 5000;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? 60_000;
    this.now = opts.now ?? (() => Date.now());
    this.setTimeoutFn = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms).unref());
    this.env = opts.env ?? process.env;
    this.logger = opts.logger ?? { info() {}, warn() {}, error() {} };
    this.scheduleSweep();
  }

  socketPathFor(macUser: string): string {
    return join(this.socketRoot, macUser, "agent.sock");
  }

  async ensure(user: UserEntry): Promise<{ socketPath: string }> {
    if (this.closed) throw new AgentUnavailableError("gateway 가 종료 중입니다");
    const e = this.entry(user);
    this.noteActivity(user.macUser);
    if (e.state === "ready" && e.child && !e.stopping) return { socketPath: e.socketPath };
    if (e.pending) return e.pending;
    if (e.stopping && e.exited) await e.exited;
    if (e.pending) return e.pending;
    if (e.state === "ready" && e.child && !e.stopping) return { socketPath: e.socketPath };
    if (e.state === "backoff" && this.now() < e.backoffUntil) throw new SupervisorBackoffError(user.macUser, e.backoffUntil);
    e.pending = this.start(e).finally(() => {
      e.pending = undefined;
    });
    return e.pending;
  }

  noteActivity(macUser: string): void {
    this.lastActivity.set(macUser, this.now());
  }

  trackConnection(macUser: string): () => void {
    this.connections.set(macUser, (this.connections.get(macUser) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.connections.set(macUser, Math.max(0, (this.connections.get(macUser) ?? 1) - 1));
      this.noteActivity(macUser);
    };
  }

  status(): SupervisorStatus[] {
    return [...this.entries.values()].map((e) => ({ macUser: e.user.macUser, pid: e.pid, state: e.state, restarts: e.restarts }));
  }

  /** 마지막 활동 후 idleTimeoutMinutes 경과 && 활성 연결 0 → SIGTERM. 1분마다 호출된다. */
  sweepIdle(): void {
    const limit = this.config.agentHost.idleTimeoutMinutes * 60_000;
    for (const e of this.entries.values()) {
      if (e.state !== "ready" || !e.child || e.stopping) continue;
      const last = this.lastActivity.get(e.user.macUser) ?? 0;
      if ((this.connections.get(e.user.macUser) ?? 0) > 0 || this.now() - last < limit) continue;
      this.logger.info(`[supervisor] idle → stop agent-host ${e.user.macUser}`);
      this.stop(e);
    }
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    const live = [...this.entries.values()].filter((e) => e.child);
    for (const e of live) this.stop(e, false);
    const all = Promise.all(live.map((e) => e.exited));
    await Promise.race([all, this.sleep(this.shutdownTimeoutMs)]);
    for (const e of live) if (e.child) e.child.kill("SIGKILL");
    await Promise.race([all, this.sleep(Math.min(1000, this.shutdownTimeoutMs))]);
  }

  private entry(user: UserEntry): Entry {
    let e = this.entries.get(user.macUser);
    if (!e) {
      e = { user, socketPath: this.socketPathFor(user.macUser), state: "stopped", restarts: 0, crashStreak: 0, backoffUntil: 0, stopping: false };
      this.entries.set(user.macUser, e);
    }
    e.user = user;
    return e;
  }

  private scheduleSweep(): void {
    if (this.closed) return;
    this.setTimeoutFn(() => {
      if (this.closed) return;
      this.sweepIdle();
      this.scheduleSweep();
    }, this.sweepIntervalMs);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.setTimeoutFn(resolve, ms));
  }

  private stop(e: Entry, scheduleKill = true): void {
    if (!e.child) return;
    e.stopping = true;
    const child = e.child;
    child.kill("SIGTERM");
    if (scheduleKill) {
      this.setTimeoutFn(() => {
        if (e.child === child) child.kill("SIGKILL");
      }, this.shutdownTimeoutMs);
    }
  }

  private childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { PATH: CHILD_PATH };
    for (const [k, v] of Object.entries(this.env)) if (k.startsWith("MAM_") && v !== undefined) env[k] = v;
    if (this.dev) for (const k of DEV_PASSTHROUGH) if (this.env[k] !== undefined) env[k] = this.env[k];
    return env;
  }

  private collect(bin: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = this.spawnFn(bin, args, { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        out += chunk.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${bin} ${args.join(" ")} 실패 (exit ${code})`))));
    });
  }

  private async idOf(flag: "-u" | "-g", macUser: string): Promise<number> {
    const id = Number.parseInt((await this.collect("/usr/bin/id", [flag, macUser])).trim(), 10);
    if (!Number.isInteger(id)) throw new Error(`사용자 ${macUser} 의 id ${flag} 를 얻지 못했습니다`);
    return id;
  }

  private async prepareSocketDir(e: Entry): Promise<void> {
    await mkdir(this.socketRoot, { recursive: true, mode: 0o755 });
    await chmod(this.socketRoot, 0o755);
    const dir = dirname(e.socketPath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (!this.dev) {
      const [uid, gid] = await Promise.all([this.idOf("-u", e.user.macUser), this.idOf("-g", e.user.macUser)]);
      await chown(dir, uid, gid);
    }
    await chmod(dir, 0o700);
  }

  private spawnChild(e: Entry): ChildProcess {
    const { node, mamCli } = this.config.paths;
    const args = ["agent-host", "--socket", e.socketPath, "--workspace", e.user.workspaceRoot, "--email", e.user.email];
    const env = this.childEnv();
    const stdio: ["ignore", "pipe", "pipe"] = ["ignore", "pipe", "pipe"];
    if (this.dev) return this.spawnFn(node, [mamCli, ...args], { env, stdio });
    const keep = Object.keys(env).filter((k) => k.startsWith("MAM_"));
    const sudoArgs = ["-u", e.user.macUser, "-H", "-n", ...(keep.length ? [`--preserve-env=${keep.join(",")}`] : []), "--", node, mamCli, ...args];
    return this.spawnFn("/usr/bin/sudo", sudoArgs, { env, stdio });
  }

  private markCrash(e: Entry, reason: string): void {
    if (e.readyAt !== undefined && this.now() - e.readyAt >= STABLE_MS) e.crashStreak = 0;
    e.crashStreak += 1;
    e.restarts += 1;
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** (e.crashStreak - 1), BACKOFF_MAX_MS);
    e.backoffUntil = this.now() + delay;
    e.state = "backoff";
    e.child = undefined;
    e.readyAt = undefined;
    this.logger.warn(`[supervisor] agent-host ${e.user.macUser} ${reason}; backoff ${delay}ms`);
  }

  private async start(e: Entry): Promise<{ socketPath: string }> {
    e.state = "starting";
    e.stopping = false;
    e.readyAt = undefined;
    try {
      await this.prepareSocketDir(e);
    } catch (err) {
      e.state = "backoff";
      e.backoffUntil = this.now() + BACKOFF_BASE_MS;
      throw new AgentUnavailableError(`소켓 디렉토리 준비 실패: ${(err as Error).message}`);
    }
    const child = this.spawnChild(e);
    e.child = child;
    e.pid = child.pid;
    const tag = `[agent-host:${e.user.macUser}]`;
    child.stdout?.on("data", lineSink((line) => this.logger.info(`${tag} ${line}`)));
    child.stderr?.on("data", lineSink((line) => this.logger.warn(`${tag} ${line}`)));
    let gone = false;
    e.exited = new Promise<void>((resolve) => {
      const done = (reason: string): void => {
        if (gone) return;
        gone = true;
        if (e.child === child) {
          if (e.stopping) {
            e.state = "stopped";
            e.child = undefined;
            e.crashStreak = 0;
            this.logger.info(`[supervisor] agent-host ${e.user.macUser} stopped (${reason})`);
          } else this.markCrash(e, reason);
        }
        resolve();
      };
      child.once("exit", (code, signal) => done(`exit code=${code} signal=${signal}`));
      child.once("error", (err) => done(`spawn error: ${err.message}`));
    });
    try {
      await this.waitReady(e, child, () => gone);
    } catch (err) {
      if (e.child === child) this.markCrash(e, (err as Error).message);
      child.kill("SIGKILL");
      throw new AgentUnavailableError(`agent-host 시작 실패 (${e.user.macUser}): ${(err as Error).message}`);
    }
    e.state = "ready";
    e.readyAt = this.now();
    this.logger.info(`[supervisor] agent-host ${e.user.macUser} ready pid=${child.pid ?? "?"}`);
    return { socketPath: e.socketPath };
  }

  private tryConnect(socketPath: string): Promise<boolean> {
    return new Promise((resolve) => {
      const s = connect(socketPath);
      s.once("connect", () => {
        s.destroy();
        resolve(true);
      });
      s.once("error", () => resolve(false));
    });
  }

  private async waitReady(e: Entry, child: ChildProcess, gone: () => boolean): Promise<void> {
    const deadline = this.now() + this.readyTimeoutMs;
    for (;;) {
      if (gone() || e.child !== child) throw new Error("준비 전에 프로세스가 종료되었습니다");
      if (await this.tryConnect(e.socketPath)) return;
      if (this.now() >= deadline) throw new Error(`준비 시간 초과 (${this.readyTimeoutMs}ms)`);
      await this.sleep(100);
    }
  }
}
