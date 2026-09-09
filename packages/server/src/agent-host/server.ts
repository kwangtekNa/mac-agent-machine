import { chmod, mkdir, realpath, unlink } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { AgentKind } from "@mam/protocol";
import { ClaudeAdapter } from "../agents/claude/index.js";
import { FakeAdapter } from "../agents/fake/index.js";
import type { AgentAdapter } from "../agents/types.js";
import { SERVER_VERSION } from "../index.js";
import { SessionManager } from "../sessions/manager.js";
import { buildApp } from "./app.js";

export interface StartAgentHostOptions {
  socketPath: string;
  /** 기본 `~/.mam`. 없으면 0700 으로 만든다. */
  dataDir?: string;
  /** 기본: `MAM_FAKE_AGENT=1` 이면 Fake 두 개, 아니면 Claude 실제 어댑터(codex 는 step 6). */
  adapters?: Partial<Record<AgentKind, AgentAdapter>>;
  workspaceRoot?: string;
  email?: string | null;
  dev?: boolean;
  /** 테스트용. 기본 30초. */
  wsPingIntervalMs?: number;
}

export interface AgentHostHandle {
  app: FastifyInstance;
  manager: SessionManager;
  socketPath: string;
  close(): Promise<void>;
}

export function defaultAdapters(env: NodeJS.ProcessEnv = process.env): Partial<Record<AgentKind, AgentAdapter>> {
  if (env.MAM_FAKE_AGENT === "1") {
    return { claude: new FakeAdapter({ kind: "claude" }), codex: new FakeAdapter({ kind: "codex" }) };
  }
  return { claude: new ClaudeAdapter() };
}

async function realpathOr(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export async function startAgentHost(opts: StartAgentHostOptions): Promise<AgentHostHandle> {
  const user = userInfo().username;
  const home = await realpathOr(homedir());
  const dataDir = opts.dataDir ?? join(home, ".mam");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const workspaceRoot = await realpathOr(opts.workspaceRoot ?? join(home, "work"));
  const adapters = opts.adapters ?? defaultAdapters();

  const manager = await SessionManager.open({ dataDir, adapters });
  const app = buildApp(
    {
      user,
      email: opts.email ?? null,
      home,
      workspaceRoot,
      manager,
      adapters,
      serverVersion: SERVER_VERSION,
      logger: { level: opts.dev ? "info" : "warn" },
    },
    { ws: { pingIntervalMs: opts.wsPingIntervalMs } },
  );
  const socketPath = opts.socketPath;
  await unlinkIfExists(socketPath);
  await app.listen({ path: socketPath });
  await chmod(socketPath, 0o600);
  let closing: Promise<void> | undefined;
  return {
    app,
    manager,
    socketPath,
    close: () => {
      closing ??= (async () => {
        await app.close();
        await manager.shutdown();
        await unlinkIfExists(socketPath);
      })();
      return closing;
    },
  };
}

/** SIGTERM/SIGINT 에 어댑터 세션을 닫고 종료한다. cli 가 호출한다. */
export function installSignalHandlers(host: AgentHostHandle, exit: (code: number) => void = (code) => process.exit(code)): void {
  const onSignal = (): void => {
    host.close().then(
      () => exit(0),
      (err: unknown) => {
        host.app.log.error({ err }, "shutdown failed");
        exit(1);
      },
    );
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
}
