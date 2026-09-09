import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// 테스트와 구현이 같은 결정적 git 설정을 보도록 이 워커의 환경을 고정한다(vitest 는 파일별 fork).
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "mam-test",
  GIT_AUTHOR_EMAIL: "mam-test@example.com",
  GIT_COMMITTER_NAME: "mam-test",
  GIT_COMMITTER_EMAIL: "mam-test@example.com",
  GIT_TERMINAL_PROMPT: "0",
});

/** `os.tmpdir()` 아래 임시 홈. macOS 에서는 `/var/...`(심볼릭 링크) 경로가 그대로 돌아온다. */
export async function makeTmpHome(prefix = "mam-home-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function removeTmp(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** 테스트용 git 실행. 인자 배열만 쓴다. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args]);
  return stdout;
}

export async function initRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(dir, "init", "-q", "-b", "main");
}
