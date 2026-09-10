import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { defaultAdapters, installSignalHandlers, startAgentHost } from "../agent-host/server.js";
import type { AgentKind } from "@mam/protocol";
import type { AgentProbe } from "../agents/types.js";
import { devConfig, loadConfig, type ConfigInput } from "../config.js";
import { findTailscaleBin, StaticIdentityResolver, TailscaleIdentityResolver, type IdentityResolver } from "../gateway/identity.js";
import { installGatewaySignalHandlers, startGateway } from "../gateway/server.js";
import { AgentHostSupervisor } from "../gateway/supervisor.js";
import { UserDirectory } from "../gateway/users.js";
import { SERVER_VERSION } from "../index.js";
import { registerConfigCommands } from "./config.js";
import { processIo, type CliIo } from "./common.js";
import { registerDoctorCommand } from "./doctor.js";
import { registerUserCommands } from "./user.js";

/** `~` / `~/x` → 홈 치환(config.users[].workspaceRoot 는 `~` 그대로 전달된다). */
function expandHome(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function makeLogger(): Pick<Console, "info" | "warn" | "error"> {
  const ts = (): string => new Date().toISOString();
  return {
    info: (...a: unknown[]) => console.log(ts(), "INFO", ...a),
    warn: (...a: unknown[]) => console.warn(ts(), "WARN", ...a),
    error: (...a: unknown[]) => console.error(ts(), "ERROR", ...a),
  };
}

/** `MAM_DEV_PORT` (scripts/dev-smoke.sh 가 포트 충돌을 피할 때 씀). 없거나 정수가 아니면 devConfig 기본값(7777)을 쓴다. */
export function devPortOverride(env: NodeJS.ProcessEnv): Partial<ConfigInput> {
  const raw = env.MAM_DEV_PORT;
  if (raw === undefined) return {};
  const port = Number(raw);
  return Number.isInteger(port) ? { port } : {};
}

/**
 * `MAM_DEV_BIND`: 개발 모드 바인딩 주소. "tailscale"(tailnet IPv4) 또는 IPv4 리터럴
 * (예: 172.20.10.2 — 같은 Wi-Fi/핫스팟에 있는 iPhone 에서 접속할 때). 없거나 형식이 틀리면 기본 127.0.0.1.
 * 주의: 개발 모드는 신원을 고정(StaticIdentityResolver)하므로 그 주소에 닿는 기기는 모두 현재 사용자로 취급된다.
 */
export function devBindOverride(env: NodeJS.ProcessEnv): Partial<ConfigInput> {
  const raw = env.MAM_DEV_BIND?.trim();
  if (!raw) return {};
  if (raw === "tailscale") return { bind: raw };
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(raw) ? { bind: raw } : {};
}

/** 어댑터 probe 결과를 JSON 으로 stdout 에 쓴다(`mam doctor` 가 sudo -u 로 호출). */
export async function probeAgents(): Promise<Record<AgentKind, AgentProbe>> {
  const adapters = defaultAdapters();
  const out = {} as Record<AgentKind, AgentProbe>;
  for (const kind of ["claude", "codex"] as const) {
    const adapter = adapters[kind];
    out[kind] = adapter
      ? await adapter.probe().catch((err: unknown): AgentProbe => ({ available: false, loggedIn: false, detail: (err as Error).message }))
      : { available: false, loggedIn: false, detail: "adapter not registered" };
  }
  return out;
}

export function createProgram(io: CliIo = processIo()): Command {
  const program = new Command();
  program.name("mam").description("mac-agent-machine server").version(SERVER_VERSION);
  program.action(() => io.out("mam " + SERVER_VERSION));

  program
    .command("agent-host")
    .description("사용자 권한으로 unix socket 에서 listen 하는 agent-host")
    .option("--socket <path>", "unix socket 경로 (--probe 가 아니면 필수)")
    .option("--data-dir <dir>", "데이터 디렉토리 (기본 ~/.mam)")
    .option("--workspace <dir>", "워크스페이스 루트 (기본 ~/work)")
    .option("--email <email>", "gateway 가 확정한 로그인 이메일")
    .option("--dev", "개발 모드 로그")
    .option("--probe", "에이전트 probe 결과를 JSON 으로 출력하고 종료")
    .action(async (o: { socket?: string; dataDir?: string; workspace?: string; email?: string; dev?: boolean; probe?: boolean }) => {
      if (o.probe) {
        io.out(JSON.stringify(await probeAgents()));
        return;
      }
      if (!o.socket) {
        io.err("--socket <path> 가 필요합니다");
        io.exit(1);
      }
      const host = await startAgentHost({
        socketPath: o.socket,
        dataDir: expandHome(o.dataDir),
        workspaceRoot: expandHome(o.workspace),
        email: o.email ?? null,
        dev: o.dev,
      });
      installSignalHandlers(host);
      host.app.log.info({ socket: host.socketPath }, "agent-host listening");
    });

  program
    .command("gateway")
    .description("root 로 도는 gateway: 접속 수락, tailscale whois 신원, agent-host 감독, 프록시")
    .option("--dev", "개발 모드 (http://127.0.0.1:7777, 현재 사용자, TLS 없음. MAM_DEV_PORT / MAM_DEV_BIND 로 포트·바인딩 주소 변경)")
    .option("--config <path>", "설정 파일 (기본 $MAM_CONFIG 또는 /etc/mam/config.json)")
    .action(async (o: { dev?: boolean; config?: string }) => {
      const dev = o.dev === true;
      if (!dev && io.uid !== 0) {
        io.err("gateway 는 root 로 실행해야 합니다 (개발 모드는 --dev)");
        io.exit(1);
      }
      const config = dev
        ? devConfig({ ...devPortOverride(process.env), ...devBindOverride(process.env) })
        : await loadConfig(o.config);
      const logger = makeLogger();
      const users = new UserDirectory(config.users);
      let identity: IdentityResolver;
      if (dev) {
        const first = config.users[0];
        if (!first) throw new Error("devConfig 에 사용자가 없습니다");
        identity = new StaticIdentityResolver({ email: first.email });
      } else {
        const bin = findTailscaleBin();
        if (!bin) throw new Error("tailscale 실행 파일을 찾지 못했습니다. Tailscale 이 설치되어 있는지 확인하세요");
        identity = new TailscaleIdentityResolver({ tailscaleBin: bin });
      }
      const supervisor = new AgentHostSupervisor({ config, dev, logger });
      const gateway = await startGateway({ config, identity, users, supervisor, dev, logger });
      installGatewaySignalHandlers(gateway);
      io.out(`gateway listening on ${dev ? "http" : "https"}://${gateway.address.host}:${gateway.address.port}`);
    });

  registerUserCommands(program, io);
  registerDoctorCommand(program, io);
  registerConfigCommands(program, io);
  return program;
}
