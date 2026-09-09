#!/usr/bin/env node
import { Command } from "commander";
import { installSignalHandlers, startAgentHost } from "./agent-host/server.js";
import { SERVER_VERSION } from "./index.js";

const program = new Command();
program.name("mam").description("mac-agent-machine server").version(SERVER_VERSION);
program.action(() => console.log("mam " + SERVER_VERSION));

program
  .command("agent-host")
  .description("사용자 권한으로 unix socket 에서 listen 하는 agent-host")
  .requiredOption("--socket <path>", "unix socket 경로")
  .option("--data-dir <dir>", "데이터 디렉토리 (기본 ~/.mam)")
  .option("--workspace <dir>", "워크스페이스 루트 (기본 ~/work)")
  .option("--dev", "개발 모드 로그")
  .action(async (o: { socket: string; dataDir?: string; workspace?: string; dev?: boolean }) => {
    const host = await startAgentHost({ socketPath: o.socket, dataDir: o.dataDir, workspaceRoot: o.workspace, dev: o.dev });
    installSignalHandlers(host);
    host.app.log.info({ socket: host.socketPath }, "agent-host listening");
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
