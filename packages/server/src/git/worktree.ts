import { mkdir } from "node:fs/promises";
import path from "node:path";
import { InvalidRequestError } from "../errors.js";
import { type GitRunResult, runGit } from "./status.js";

/**
 * 팀원 worktree 를 만들고, 턴 종료 시 커밋하고, 베이스 브랜치와 비교·머지·동기화하는 순수 git 헬퍼.
 * 팀 개념은 모른다(경로·브랜치 이름을 인자로 받는다). 모든 git 호출은 `runGit`(spawn 인자 배열)이다.
 * 강제 삭제·하드 리셋·rebase·push 는 쓰지 않는다. 실패한 머지는 `merge --abort` 로 되돌린다(ADR-017, PROTOCOL 6.5).
 */

export type WorktreeErrorCode = "not_repo" | "detached" | "dirty" | "wrong_branch" | "conflict" | "git_failed";

/** git 작업 실패. `detail` 은 git stderr 첫 줄들(비밀값 없음). */
export class WorktreeError extends Error {
  readonly code: WorktreeErrorCode;
  readonly detail?: string;

  constructor(code: WorktreeErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "WorktreeError";
    this.code = code;
    if (detail !== undefined && detail !== "") this.detail = detail;
  }
}

/** 머지·worktree add 처럼 오래 걸릴 수 있는 명령의 타임아웃. */
export const LONG_GIT_TIMEOUT_MS = 60_000;

const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

/** `mam/<team-slug>/<handle>` 같은 브랜치 이름 검증. `..`·공백·옵션형(`-`로 시작)·빈 세그먼트·`.lock` 을 거부한다. */
export function isValidBranchName(name: string): boolean {
  if (name === "" || !BRANCH_RE.test(name)) return false;
  if (name.includes("..") || name.startsWith("-") || name.endsWith(".lock")) return false;
  if (name.startsWith("/") || name.endsWith("/") || name.includes("//")) return false;
  return name.split("/").every((seg) => !seg.startsWith(".") && !seg.endsWith(".lock"));
}

function requireAbsolute(p: string, what: string): void {
  if (!path.isAbsolute(p)) throw new InvalidRequestError(`${what} 는 절대 경로여야 합니다`);
}

function requireBranch(name: string, what: string): void {
  if (!isValidBranchName(name)) throw new InvalidRequestError(`${what} 이름이 올바르지 않습니다`);
}

function stderrDetail(result: GitRunResult): string {
  return result.stderr.trim().split("\n").slice(0, 3).join("\n");
}

function isNotRepo(result: GitRunResult): boolean {
  return result.code === 128 && /not a git repository|cannot change to/i.test(result.stderr);
}

function gitFailed(action: string, result: GitRunResult): WorktreeError {
  if (isNotRepo(result)) return new WorktreeError("not_repo", "git 저장소가 아닙니다", stderrDetail(result));
  return new WorktreeError("git_failed", `${action} 실패 (exit ${result.code ?? "?"})`, stderrDetail(result));
}

async function gitOk(args: readonly string[], action: string, timeoutMs?: number): Promise<GitRunResult> {
  const result = await runGit(args, timeoutMs === undefined ? {} : { timeoutMs });
  if (result.code !== 0) throw gitFailed(action, result);
  return result;
}

/** `status --porcelain` 출력(추적 변경 + 비추적, `.gitignore` 준수). 저장소가 아니면 not_repo. */
async function porcelainStatus(dir: string): Promise<string> {
  const result = await runGit(["-C", dir, "status", "--porcelain", "--untracked-files=normal"]);
  if (result.code !== 0) throw gitFailed("git status", result);
  return result.stdout;
}

async function revParse(dir: string, rev: string): Promise<string> {
  const result = await gitOk(["-C", dir, "rev-parse", "--verify", "--quiet", rev], `git rev-parse ${rev}`);
  return result.stdout.trim();
}

/** 병합 충돌 상태(unmerged)인 파일 목록. `-z` 로 경로 인용을 피한다. */
async function unmergedFiles(dir: string): Promise<string[]> {
  const result = await gitOk(["-C", dir, "diff", "--name-only", "--diff-filter=U", "-z"], "git diff --diff-filter=U");
  return result.stdout.split("\0").filter((p) => p !== "");
}

/** 프로젝트 체크아웃의 현재 브랜치. detached 면 code "detached", 저장소가 아니면 "not_repo". */
export async function detectBaseBranch(repo: string): Promise<string> {
  requireAbsolute(repo, "저장소 경로");
  const top = await runGit(["-C", repo, "rev-parse", "--show-toplevel"]);
  if (top.code !== 0) throw new WorktreeError("not_repo", "git 저장소가 아닙니다", stderrDetail(top));
  const ref = await runGit(["-C", repo, "symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (ref.code !== 0) {
    if (ref.code === 1) throw new WorktreeError("detached", "HEAD 가 브랜치를 가리키지 않습니다(detached)", stderrDetail(ref));
    throw gitFailed("git symbolic-ref", ref);
  }
  const branch = ref.stdout.trim();
  if (branch === "") throw new WorktreeError("detached", "HEAD 가 브랜치를 가리키지 않습니다(detached)");
  return branch;
}

/**
 * `git -C repo worktree add -b branch path base`. path 의 부모 디렉토리는 만들어 둔다.
 * 브랜치가 이미 있으면 `-b` 없이 붙인다(재사용, PROTOCOL 6.5).
 */
export async function addWorktree(opts: { repo: string; path: string; branch: string; base: string }): Promise<void> {
  requireAbsolute(opts.repo, "저장소 경로");
  requireAbsolute(opts.path, "worktree 경로");
  requireBranch(opts.branch, "브랜치");
  requireBranch(opts.base, "베이스 브랜치");

  const existing = await runGit(["-C", opts.repo, "rev-parse", "--verify", "--quiet", `refs/heads/${opts.branch}`]);
  if (existing.code !== 0 && existing.code !== 1) throw gitFailed("git rev-parse", existing);

  await mkdir(path.dirname(opts.path), { recursive: true });
  const args = existing.code === 0
    ? ["-C", opts.repo, "worktree", "add", opts.path, opts.branch]
    : ["-C", opts.repo, "worktree", "add", "-b", opts.branch, opts.path, opts.base];
  await gitOk(args, "git worktree add", LONG_GIT_TIMEOUT_MS);
}

/** 추적 변경 또는 비추적(무시 제외) 파일이 있으면 true. */
export async function worktreeIsDirty(wt: string): Promise<boolean> {
  requireAbsolute(wt, "worktree 경로");
  return (await porcelainStatus(wt)) !== "";
}

/** 더러우면 code "dirty" 로 던진다. 강제 플래그 없이 제거하고 성공 후 `worktree prune`. 브랜치는 지우지 않는다. */
export async function removeWorktree(repo: string, wtPath: string): Promise<void> {
  requireAbsolute(repo, "저장소 경로");
  requireAbsolute(wtPath, "worktree 경로");
  if (await worktreeIsDirty(wtPath)) {
    throw new WorktreeError("dirty", "worktree 에 커밋되지 않은 변경이 있습니다");
  }
  await gitOk(["-C", repo, "worktree", "remove", wtPath], "git worktree remove", LONG_GIT_TIMEOUT_MS);
  await gitOk(["-C", repo, "worktree", "prune"], "git worktree prune");
}

/** `add -A` + `commit -q -m <message> --author <author>`. 변경 없으면 null, 있으면 커밋 sha. */
export async function commitAll(wt: string, opts: { message: string; author: string }): Promise<string | null> {
  requireAbsolute(wt, "worktree 경로");
  await gitOk(["-C", wt, "add", "-A"], "git add -A", LONG_GIT_TIMEOUT_MS);
  // exit 0 = 스테이지된 변경 없음, 1 = 있음.
  const staged = await runGit(["-C", wt, "diff", "--cached", "--quiet"]);
  if (staged.code === 0) return null;
  if (staged.code !== 1) throw gitFailed("git diff --cached", staged);
  await gitOk(["-C", wt, "commit", "-q", "-m", opts.message, "--author", opts.author], "git commit", LONG_GIT_TIMEOUT_MS);
  return revParse(wt, "HEAD");
}

function parseNumstat(raw: string): Array<{ path: string; additions: number; deletions: number }> {
  const files: Array<{ path: string; additions: number; deletions: number }> = [];
  for (const record of raw.split("\0")) {
    if (record === "") continue;
    const [add, del, ...rest] = record.split("\t");
    const p = rest.join("\t");
    if (p === "") continue;
    files.push({
      path: p,
      additions: add === "-" ? 0 : Number.parseInt(add ?? "0", 10) || 0,
      deletions: del === "-" ? 0 : Number.parseInt(del ?? "0", 10) || 0,
    });
  }
  return files;
}

/** `rev-list --count base..branch` 와 `diff --numstat base...branch`(rename 감지 없음, `-z`). */
export async function changesVsBase(
  repo: string,
  base: string,
  branch: string,
): Promise<{ commits: number; files: Array<{ path: string; additions: number; deletions: number }>; head: string }> {
  requireAbsolute(repo, "저장소 경로");
  requireBranch(base, "베이스 브랜치");
  requireBranch(branch, "브랜치");
  const head = await revParse(repo, `${branch}^{commit}`);
  const count = await gitOk(["-C", repo, "rev-list", "--count", `${base}..${branch}`], "git rev-list --count");
  const numstat = await gitOk(
    ["-C", repo, "diff", "--numstat", "--no-renames", "--no-color", "--no-ext-diff", "-z", `${base}...${branch}`],
    "git diff --numstat",
  );
  return { commits: Number.parseInt(count.stdout.trim(), 10) || 0, files: parseNumstat(numstat.stdout), head };
}

export type MergeIntoBaseResult =
  | { status: "merged"; sha: string }
  | { status: "conflict"; conflictFiles: string[] }
  | { status: "dirty" }
  | { status: "wrong_branch"; current: string };

/**
 * 전제조건(체크아웃 깨끗, 현재 브랜치 == base) 검사 후 `merge --no-ff --no-edit -m <message> <branch>`.
 * 충돌이면 conflictFiles 를 모으고 `merge --abort` 한 뒤 status "conflict". 브랜치는 유지한다.
 */
export async function mergeIntoBase(opts: { repo: string; base: string; branch: string; message: string }): Promise<MergeIntoBaseResult> {
  requireAbsolute(opts.repo, "저장소 경로");
  requireBranch(opts.base, "베이스 브랜치");
  requireBranch(opts.branch, "브랜치");

  if ((await porcelainStatus(opts.repo)) !== "") return { status: "dirty" };
  const current = await detectBaseBranch(opts.repo);
  if (current !== opts.base) return { status: "wrong_branch", current };

  const merge = await runGit(
    ["-C", opts.repo, "merge", "--no-ff", "--no-edit", "-m", opts.message, opts.branch],
    { timeoutMs: LONG_GIT_TIMEOUT_MS },
  );
  if (merge.code === 0) return { status: "merged", sha: await revParse(opts.repo, "HEAD") };

  const inProgress = await hasMergeInProgress(opts.repo);
  if (!inProgress) throw gitFailed("git merge", merge);
  const conflictFiles = await unmergedFiles(opts.repo);
  await gitOk(["-C", opts.repo, "merge", "--abort"], "git merge --abort", LONG_GIT_TIMEOUT_MS);
  return { status: "conflict", conflictFiles };
}

export type SyncFromBaseResult = { status: "up_to_date" | "merged" | "conflict"; conflictFiles?: string[] };

/**
 * worktree 에서 `merge --no-edit base`. base 가 이미 HEAD 의 조상이면 "up_to_date".
 * 충돌이면 마커·MERGE_HEAD 를 남기고 "conflict" + 파일 목록(사용자가 정리한다, PROTOCOL 6.5).
 */
export async function syncFromBase(wt: string, base: string): Promise<SyncFromBaseResult> {
  requireAbsolute(wt, "worktree 경로");
  requireBranch(base, "베이스 브랜치");

  const ancestor = await runGit(["-C", wt, "merge-base", "--is-ancestor", base, "HEAD"]);
  if (ancestor.code === 0) return { status: "up_to_date" };
  if (ancestor.code !== 1) throw gitFailed("git merge-base", ancestor);

  const merge = await runGit(["-C", wt, "merge", "--no-edit", base], { timeoutMs: LONG_GIT_TIMEOUT_MS });
  if (merge.code === 0) return { status: "merged" };
  if (!(await hasMergeInProgress(wt))) throw gitFailed("git merge", merge);
  return { status: "conflict", conflictFiles: await unmergedFiles(wt) };
}

/** worktree 에 진행 중인 머지(MERGE_HEAD)가 있는가. */
export async function hasMergeInProgress(wt: string): Promise<boolean> {
  requireAbsolute(wt, "worktree 경로");
  const result = await runGit(["-C", wt, "rev-parse", "--verify", "--quiet", "MERGE_HEAD"]);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw gitFailed("git rev-parse MERGE_HEAD", result);
}
