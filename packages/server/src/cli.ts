#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { installSignalHandlers, startAgentHost } from "./agent-host/server.js";
import { devConfig, loadConfig } from "./config.js";
import { findTailscaleBin, StaticIdentityResolver, TailscaleIdentityResolver, type IdentityResolver } from "./gateway/identity.js";
import { installGatewaySignalHandlers, startGateway } from "./gateway/server.js";
import { AgentHostSupervisor } from "./gateway/supervisor.js";
import { UserDirectory } from "./gateway/users.js";
import { SERVER_VERSION } from "./index.js";

const program = new Command();
program.name("mam").description("mac-agent-machine server").version(SERVER_VERSION);
program.action(() => console.log("mam " + SERVER_VERSION));

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

program
  .command("agent-host")
  .description("사용자 권한으로 unix socket 에서 listen 하는 agent-host")
  .requiredOption("--socket <path>", "unix socket 경로")
  .option("--data-dir <dir>", "데이터 디렉토리 (기본 ~/.mam)")
  .option("--workspace <dir>", "워크스페이스 루트 (기본 ~/work)")
  .option("--email <email>", "gateway 가 확정한 로그인 이메일")
  .option("--dev", "개발 모드 로그")
  .action(async (o: { socket: string; dataDir?: string; workspace?: string; email?: string; dev?: boolean }) => {
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
  .option("--dev", "개발 모드 (http://127.0.0.1:7777, 현재 사용자, TLS 없음)")
  .option("--config <path>", "설정 파일 (기본 $MAM_CONFIG 또는 /etc/mam/config.json)")
  .action(async (o: { dev?: boolean; config?: string }) => {
    const dev = o.dev === true;
    if (!dev && process.getuid?.() !== 0) {
      console.error("gateway 는 root 로 실행해야 합니다 (개발 모드는 --dev)");
      process.exit(1);
    }
    const config = dev ? devConfig() : await loadConfig(o.config);
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
    console.log(`gateway listening on ${dev ? "http" : "https"}://${gateway.address.host}:${gateway.address.port}`);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
