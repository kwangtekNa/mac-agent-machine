import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GitInitResponse } from "@mam/protocol";
import { ConflictError, InternalError, InvalidRequestError } from "../errors.js";
import { type GitRunResult, findRepoRoot, runGit } from "./status.js";

/**
 * `POST /git/init`(PROTOCOL 1절, 2026-09-13 추가)의 순수 git 헬퍼. 팀 개념은 모른다.
 * 초기화 = (없을 때만) 기본 `.gitignore` 생성 → `git init -b main` → `git add -A` → `git commit -m "Initial commit"`.
 * 팀원 worktree 가 베이스 브랜치를 체크아웃하므로 기존 파일은 첫 커밋에 담겨야 에이전트가 볼 수 있다.
 * 모든 git 호출은 `runGit`(spawn 인자 배열, CRITICAL 4). 사용자 전역 git 설정은 건드리지 않는다.
 */

/** 기본 `.gitignore`. 첫 줄 주석 포함, RUNBOOK "팀 운영" 절과 같은 내용. */
export const DEFAULT_GITIGNORE = `# MacAgent 기본 .gitignore — 필요에 맞게 고치세요
.DS_Store
node_modules/
dist/
build/
.build/
DerivedData/
xcuserdata/
__pycache__/
.venv/
*.log
.env
.env.*
`;

/** 기본 브랜치. 사용자 git 전역 설정(`init.defaultBranch`)과 무관하게 항상 `main`. */
export const INIT_BRANCH = "main";
export const INITIAL_COMMIT_MESSAGE = "Initial commit";

/** `user.name`/`user.email` 이 비어 있을 때 그 커밋 한 번에만 `-c` 로 붙이는 작성자. */
const FALLBACK_AUTHOR_NAME = "MacAgent";
const FALLBACK_AUTHOR_EMAIL = "mam@mam.local";

/** `add -A`·`commit` 처럼 파일 수에 비례해 오래 걸릴 수 있는 명령의 타임아웃. */
const LONG_GIT_TIMEOUT_MS = 60_000;

export interface GitInitOptions {
  /** true 면 cwd 를 전혀 바꾸지 않고 커밋될 파일 수·바이트만 계산한다. */
  dryRun?: boolean;
  /** 첫 커밋의 작성 시각(`--date`). 생략하면 git 의 현재 시각. */
  now?: () => Date;
}

function stderrHead(result: GitRunResult): string {
  return result.stderr.trim().split("\n").slice(0, 2).join(" ");
}

async function gitOk(args: readonly string[], action: string, timeoutMs?: number): Promise<GitRunResult> {
  const result = await runGit(args, timeoutMs === undefined ? {} : { timeoutMs });
  if (result.code !== 0) {
    const detail = stderrHead(result);
    throw new InternalError(`${action} 실패 (exit ${result.code ?? "?"})${detail === "" ? "" : `: ${detail}`}`);
  }
  return result;
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** cwd(또는 상위 디렉토리)가 이미 git 저장소면 409 `conflict`. 메시지에 어느 경로가 저장소인지 담는다. */
export async function assertNotInsideRepo(cwd: string): Promise<void> {
  const root = await findRepoRoot(cwd);
  if (root !== null) throw new ConflictError(`이미 git 저장소입니다: ${root}`);
}

/** `-z` 출력을 경로 배열로. */
function splitZ(stdout: string): string[] {
  return stdout.split("\0").filter((p) => p !== "");
}

/** 파일 수와 `lstat` 크기 합(심볼릭 링크는 링크 자체 크기 = git 이 저장하는 내용). 사라진 파일은 건너뛴다. */
async function countFiles(cwd: string, paths: readonly string[]): Promise<{ files: number; bytes: number }> {
  let bytes = 0;
  for (const p of paths) {
    try {
      bytes += (await lstat(path.join(cwd, p))).size;
    } catch {
      // 목록을 만든 뒤 지워진 파일. 수에는 넣되 크기는 0.
    }
  }
  return { files: paths.length, bytes };
}

/**
 * cwd 를 건드리지 않고 첫 커밋에 담길 파일 목록을 실제 git 으로 계산한다.
 * 임시 디렉토리를 `--git-dir` 로 쓰므로 cwd 에는 아무것도 생기지 않는다. 기본 `.gitignore` 를 만들 예정이면
 * 그 내용을 임시 파일에 써 `--exclude-from` 으로 넘겨 실제 초기화와 같은 무시 규칙을 적용한다.
 */
async function listFilesToCommit(cwd: string, useDefaultGitignore: boolean): Promise<string[]> {
  const tmp = await mkdtemp(path.join(tmpdir(), "mam-git-init-"));
  try {
    await gitOk(["-C", cwd, "--git-dir", tmp, "--work-tree", cwd, "init", "-q", "-b", INIT_BRANCH], "git init (dry-run)");
    const args = ["-C", cwd, "--git-dir", tmp, "--work-tree", cwd, "ls-files", "--others", "--exclude-standard"];
    if (useDefaultGitignore) {
      const ignoreFile = path.join(tmp, "mam-default-gitignore");
      await writeFile(ignoreFile, DEFAULT_GITIGNORE);
      args.push(`--exclude-from=${ignoreFile}`);
    }
    args.push("-z");
    const result = await gitOk(args, "git ls-files --others", LONG_GIT_TIMEOUT_MS);
    return splitZ(result.stdout);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** `user.name`/`user.email` 이 비어 있으면 그 커밋에만 쓸 `-c` 인자. 전역 설정은 바꾸지 않는다. */
async function authorFallbackArgs(cwd: string): Promise<string[]> {
  const args: string[] = [];
  const name = await runGit(["-C", cwd, "config", "--get", "user.name"]);
  if (name.code !== 0 || name.stdout.trim() === "") args.push("-c", `user.name=${FALLBACK_AUTHOR_NAME}`);
  const email = await runGit(["-C", cwd, "config", "--get", "user.email"]);
  if (email.code !== 0 || email.stdout.trim() === "") args.push("-c", `user.email=${FALLBACK_AUTHOR_EMAIL}`);
  return args;
}

/** git 이 받는 ISO-8601(초 단위). */
function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * cwd 를 git 저장소로 초기화한다. cwd 는 이미 `resolveInsideHome` 을 거친 절대 경로(디렉토리)여야 한다.
 * 이미 저장소이거나 상위가 저장소면 409. `dryRun` 이면 cwd 를 전혀 바꾸지 않는다.
 * `files`/`bytes` 는 첫 커밋에 담기는(담길) 기존 파일 기준이며 서버가 만든 `.gitignore` 는 세지 않는다(dryRun 과 같은 값).
 * 실패하면 방금 만든 `.git` 과 우리가 만든 `.gitignore` 만 정리한다.
 */
export async function initRepository(cwd: string, opts: GitInitOptions = {}): Promise<GitInitResponse> {
  if (!path.isAbsolute(cwd)) throw new InvalidRequestError("cwd 는 절대 경로여야 합니다");
  await assertNotInsideRepo(cwd);
  const gitDir = path.join(cwd, ".git");
  if (await exists(gitDir)) throw new ConflictError(`이미 git 저장소입니다: ${cwd}`);
  const gitignorePath = path.join(cwd, ".gitignore");
  const createGitignore = !(await exists(gitignorePath));

  if (opts.dryRun === true) {
    const { files, bytes } = await countFiles(cwd, await listFilesToCommit(cwd, createGitignore));
    return { initialized: false, branch: INIT_BRANCH, commit: null, files, bytes, createdGitignore: createGitignore };
  }

  let wroteGitignore = false;
  let ranInit = false;
  try {
    if (createGitignore) {
      // wx: 그 사이 누군가 만들었으면 실패시켜 사용자 파일을 덮어쓰지 않는다.
      await writeFile(gitignorePath, DEFAULT_GITIGNORE, { flag: "wx" });
      wroteGitignore = true;
    }
    await gitOk(["-C", cwd, "init", "-q", "-b", INIT_BRANCH], "git init");
    ranInit = true;
    await gitOk(["-C", cwd, "add", "-A"], "git add -A", LONG_GIT_TIMEOUT_MS);
    // 커밋할 파일이 하나도 없어도(모두 무시됨) 첫 커밋은 만든다: --allow-empty.
    const commitArgs = ["-C", cwd, ...(await authorFallbackArgs(cwd)), "commit", "-q", "--allow-empty", "-m", INITIAL_COMMIT_MESSAGE];
    if (opts.now !== undefined) commitArgs.push("--date", isoSeconds(opts.now()));
    await gitOk(commitArgs, "git commit", LONG_GIT_TIMEOUT_MS);
    const commit = (await gitOk(["-C", cwd, "rev-parse", "--verify", "HEAD"], "git rev-parse HEAD")).stdout.trim();
    const tracked = splitZ((await gitOk(["-C", cwd, "ls-files", "-z"], "git ls-files")).stdout);
    const counted = wroteGitignore ? tracked.filter((p) => p !== ".gitignore") : tracked;
    const { files, bytes } = await countFiles(cwd, counted);
    return { initialized: true, branch: INIT_BRANCH, commit, files, bytes, createdGitignore: wroteGitignore };
  } catch (err) {
    // 우리가 방금 만든 것만 되돌린다: git 이 만든 .git 과 우리가 쓴 .gitignore.
    if (ranInit) await rm(gitDir, { recursive: true, force: true });
    if (wroteGitignore) await rm(gitignorePath, { force: true });
    throw err;
  }
}
