import type { Command } from "commander";
import { initConfig } from "../admin/config-init.js";
import { adminDeps, requireRoot, type CliIo } from "./common.js";

export function registerConfigCommands(program: Command, io: CliIo): void {
  const config = program.command("config").description("설정 파일 관리 (root)");
  config
    .command("init")
    .description("/etc/mam/config.json 생성 (있으면 유지, --force 로 다시 생성하되 users[] 보존)")
    .option("--hostname <host>", "MagicDNS 호스트명 (기본 tailscale status 에서 감지)")
    .option("--port <port>", "포트 (기본 443)", (v) => Number.parseInt(v, 10))
    .option("--force", "기존 파일 덮어쓰기")
    .option("--config <path>", "설정 파일 경로")
    .action(async (o: { hostname?: string; port?: number; force?: boolean; config?: string }) => {
      requireRoot(io, "config init");
      const path = await initConfig(adminDeps(io, o.config), { hostname: o.hostname, port: o.port, force: o.force });
      io.out(path);
    });
}
