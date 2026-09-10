import { spawn, type ChildProcess } from "node:child_process";
import { SERVER_VERSION } from "../../index.js";
import type { InitializeParams } from "./generated/InitializeParams.js";
import type { InitializeResponse } from "./generated/InitializeResponse.js";
import { JsonRpcPeer } from "./jsonrpc.js";

type Logger = Pick<Console, "info" | "warn" | "error">;

export interface SpawnCodexOptions {
  binPath: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  requestTimeoutMs?: number;
}

export interface CodexProcess {
  peer: JsonRpcPeer;
  child: ChildProcess;
  /** graceful: stdin end → 2초 후 SIGTERM → 2초 후 SIGKILL. false 면 즉시 SIGKILL. 종료까지 기다린다. */
  kill(graceful?: boolean): Promise<void>;
}

/** `spawn(bin, ['app-server'])` (CLAUDE.md CRITICAL 4). stderr 는 줄 단위로 로그. */
export function spawnCodexAppServer(opts: SpawnCodexOptions): CodexProcess {
  const logger = opts.logger ?? console;
  const child = spawn(opts.binPath, ["app-server"], { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
  let errBuf = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    errBuf += chunk.toString("utf8");
    let nl = errBuf.indexOf("\n");
    while (nl >= 0) {
      const line = errBuf.slice(0, nl).trimEnd();
      errBuf = errBuf.slice(nl + 1);
      if (line) logger.warn(`[codex] ${line}`);
      nl = errBuf.indexOf("\n");
    }
  });
  let exited = false;
  const exitWaiters: Array<() => void> = [];
  const markExited = (): void => {
    exited = true;
    for (const w of exitWaiters.splice(0)) w();
  };
  child.once("exit", markExited);
  child.once("error", (err) => {
    logger.warn(`[codex] 프로세스 오류: ${err.message}`);
    markExited();
  });
  // 종료된 프로세스의 stdin 에 쓰면 EPIPE 가 날 수 있다. 크래시 대신 경고만 남긴다.
  child.stdin?.on("error", (err) => logger.warn(`[codex] stdin 오류: ${err.message}`));
  const peer = new JsonRpcPeer(child.stdout as NodeJS.ReadableStream as import("node:stream").Readable, child.stdin as import("node:stream").Writable, {
    logger,
    ...(opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
  });
  const kill = (graceful = true): Promise<void> =>
    new Promise((resolve) => {
      if (exited) {
        resolve();
        return;
      }
      const timers: NodeJS.Timeout[] = [];
      exitWaiters.push(() => {
        for (const t of timers) clearTimeout(t);
        resolve();
      });
      if (!graceful) {
        child.kill("SIGKILL");
        return;
      }
      try {
        child.stdin?.end();
      } catch {
        // 이미 닫힘
      }
      timers.push(setTimeout(() => child.kill("SIGTERM"), 2000));
      timers.push(setTimeout(() => child.kill("SIGKILL"), 4000));
    });
  return { peer, child, kill };
}

/** ADR-007 핸드셰이크: `initialize` 요청 후 `initialized` 알림. 세션·로그인·임시 프로세스가 공유한다. */
export async function initializeAppServer(peer: JsonRpcPeer): Promise<InitializeResponse> {
  const init: InitializeParams = {
    clientInfo: { name: "mam", title: "mac-agent-machine", version: SERVER_VERSION },
    capabilities: { experimentalApi: true, requestAttestation: false },
  };
  const res = await peer.request<InitializeResponse>("initialize", init);
  peer.notify("initialized");
  return res;
}

export interface EphemeralAppServerOptions extends SpawnCodexOptions {
  /** 테스트 주입. 기본 `spawnCodexAppServer`. */
  spawnFn?: typeof spawnCodexAppServer;
}

/**
 * 라이브 세션이 없을 때 `account/rateLimits/read`, `model/list` 같은 단발 요청용 임시 app-server.
 * 핸드셰이크 뒤 `fn` 을 실행하고, 성공/실패와 무관하게 피어를 닫고 프로세스를 종료한다.
 */
export async function withEphemeralAppServer<T>(opts: EphemeralAppServerOptions, fn: (peer: JsonRpcPeer) => Promise<T>): Promise<T> {
  const { spawnFn = spawnCodexAppServer, ...spawnOpts } = opts;
  const proc = spawnFn(spawnOpts);
  try {
    await initializeAppServer(proc.peer);
    return await fn(proc.peer);
  } finally {
    proc.peer.close();
    await proc.kill();
  }
}
