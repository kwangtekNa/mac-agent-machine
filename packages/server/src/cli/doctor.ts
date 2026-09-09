import type { Command } from "commander";
import { formatDoctorTable, runDoctor } from "../admin/doctor.js";
import { adminDeps, type CliIo } from "./common.js";

export function registerDoctorCommand(program: Command, io: CliIo): void {
  program
    .command("doctor")
    .description("서버 상태 진단 (fail 이 하나라도 있으면 exit 1)")
    .option("--config <path>", "설정 파일 경로")
    .option("--json", "JSON 으로 출력")
    .action(async (o: { config?: string; json?: boolean }) => {
      const result = await runDoctor(adminDeps(io, o.config, { logger: undefined }));
      io.out(o.json ? JSON.stringify(result, null, 2) : formatDoctorTable(result));
      if (!result.ok) io.exit(1);
    });
}
