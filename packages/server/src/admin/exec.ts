import { spawn } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 시스템 명령 실행 인터페이스. 관리자 모듈의 모든 외부 명령은 이것을 거친다(테스트는 가짜 주입). */
export interface Exec {
  (bin: string, args: string[], opts?: { input?: string }): Promise<ExecResult>;
}

export type AdminLogger = Pick<Console, "info" | "warn" | "error">;

export interface AdminPaths {
  /** 사용자 홈 상위. 기본 `/Users`. */
  homeRoot: string;
  /** agent-host 소켓 루트. 기본 `/var/run/mam`. */
  runRoot: string;
  /** sshd 하드닝 설정 파일. 기본 `/etc/ssh/sshd_config.d/mam.conf`. */
  sshdConf: string;
}

export const DEFAULT_ADMIN_PATHS: AdminPaths = {
  homeRoot: "/Users",
  runRoot: "/var/run/mam",
  sshdConf: "/etc/ssh/sshd_config.d/mam.conf",
};

export interface AdminDeps {
  exec: Exec;
  fs?: typeof import("node:fs/promises");
  configPath: string;
  logger?: AdminLogger;
  /** 테스트용 경로 재지정. */
  paths?: Partial<AdminPaths>;
  /** 테스트용. 기본 `process.getuid()`. */
  uid?: number;
}

/** `spawn(bin, [args])` 기반 실제 구현. 셸을 거치지 않고, 실패해도 throw 하지 않는다(code -1). */
export function spawnExec(bin: string, args: string[], opts: { input?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: -1, stdout: "", stderr: (err as Error).message });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number, extraErr = ""): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr: stderr + extraErr });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(-1, `timeout after ${opts.timeoutMs ?? 60_000}ms`);
    }, opts.timeoutMs ?? 60_000);
    child.stdout?.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.stdin?.on("error", () => undefined);
    child.on("error", (err) => finish(-1, err.message));
    child.on("close", (code) => finish(code ?? -1));
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

export function resolvePaths(deps: AdminDeps): AdminPaths {
  return { ...DEFAULT_ADMIN_PATHS, ...deps.paths };
}

export function isRoot(deps: Pick<AdminDeps, "uid">): boolean {
  return (deps.uid ?? process.getuid?.() ?? -1) === 0;
}

export async function fsOf(deps: AdminDeps): Promise<typeof import("node:fs/promises")> {
  return deps.fs ?? (await import("node:fs/promises"));
}
