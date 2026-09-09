import { DEFAULT_CONFIG_PATH } from "../config.js";
import { spawnExec, type AdminDeps, type AdminLogger } from "../admin/exec.js";

/** CLI 입출력. 테스트가 가짜를 주입한다. */
export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  uid: number;
  exit(code: number): never;
}

export function processIo(): CliIo {
  return {
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    uid: process.getuid?.() ?? -1,
    exit: (code) => process.exit(code),
  };
}

export function requireRoot(io: CliIo, what: string): void {
  if (io.uid !== 0) {
    io.err(`${what} 은(는) root 권한이 필요합니다. 'sudo mam ${what}' 로 다시 실행하세요.`);
    io.exit(1);
  }
}

export function ioLogger(io: CliIo): AdminLogger {
  return { info: (...a) => io.out(a.join(" ")), warn: (...a) => io.err("경고: " + a.join(" ")), error: (...a) => io.err(a.join(" ")) };
}

export function adminDeps(io: CliIo, configPath: string | undefined, extra: Partial<AdminDeps> = {}): AdminDeps {
  return {
    exec: spawnExec,
    configPath: configPath ?? process.env.MAM_CONFIG ?? DEFAULT_CONFIG_PATH,
    logger: ioLogger(io),
    uid: io.uid,
    ...extra,
  };
}
