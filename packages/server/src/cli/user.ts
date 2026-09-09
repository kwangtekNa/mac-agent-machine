import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { addUser, listUsers, removeUser } from "../admin/users.js";
import { adminDeps, requireRoot, type CliIo } from "./common.js";

export function registerUserCommands(program: Command, io: CliIo): void {
  const user = program.command("user").description("사용자 계정 관리 (root)");

  user
    .command("add <name>")
    .description("macOS 계정 생성(없으면), 공개키 등록, 워크스페이스, config users[] 갱신")
    .requiredOption("--email <email>", "Tailscale 로그인 이메일")
    .option("--ssh-key <pubkey>", "authorized_keys 에 추가할 공개키")
    .option("--ssh-key-file <path>", "공개키 파일 경로")
    .option("--full-name <name>", "계정 표시 이름")
    .option("--workspace <dir>", "워크스페이스 루트 (기본 ~/work)")
    .option("--config <path>", "설정 파일 경로")
    .action(async (name: string, o: { email: string; sshKey?: string; sshKeyFile?: string; fullName?: string; workspace?: string; config?: string }) => {
      requireRoot(io, "user add");
      let sshKey = o.sshKey;
      if (o.sshKeyFile) sshKey = (await readFile(o.sshKeyFile, "utf8")).trim();
      const result = await addUser(adminDeps(io, o.config), { name, email: o.email, fullName: o.fullName, sshKey, workspace: o.workspace });
      io.out(result.created ? `사용자 ${name} 생성 완료` : `사용자 ${name} 갱신 완료 (계정은 이미 있었음)`);
      io.out("");
      io.out("다음 단계:");
      result.nextSteps.forEach((s, i) => io.out(`  ${i + 1}. ${s}`));
    });

  user
    .command("list")
    .description("config users[] 와 계정·소켓 상태")
    .option("--config <path>", "설정 파일 경로")
    .action(async (o: { config?: string }) => {
      const rows = await listUsers(adminDeps(io, o.config));
      if (rows.length === 0) {
        io.out("등록된 사용자가 없습니다");
        return;
      }
      const w = Math.max(...rows.map((r) => r.macUser.length), 7);
      io.out(`${"macUser".padEnd(w)}  ${"email".padEnd(32)}  account  socket`);
      for (const r of rows) {
        io.out(`${r.macUser.padEnd(w)}  ${r.email.padEnd(32)}  ${(r.accountExists ? "yes" : "no").padEnd(7)}  ${r.socketAlive ? "alive" : "-"}`);
      }
    });

  user
    .command("remove <name>")
    .description("config 에서 제거. --delete-account 로 macOS 계정도 삭제(홈 보존)")
    .option("--delete-account", "macOS 계정 삭제 (--yes 필요)")
    .option("--yes", "계정 삭제 확인")
    .option("--config <path>", "설정 파일 경로")
    .action(async (name: string, o: { deleteAccount?: boolean; yes?: boolean; config?: string }) => {
      requireRoot(io, "user remove");
      await removeUser(adminDeps(io, o.config), { name, deleteAccount: o.deleteAccount, yes: o.yes });
      io.out(`사용자 ${name} 제거 완료`);
    });
}
