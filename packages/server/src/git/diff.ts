import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { GitDiffResponse } from "@mam/protocol";
import { InvalidRequestError } from "../errors.js";
import { findRepoRoot, runGit } from "./status.js";

export interface GitDiffOptions {
  path?: string;
  staged?: boolean;
}

const DIFF_BASE_ARGS = ["diff", "--no-color", "--no-ext-diff"] as const;

/** untracked 파일 패치. 리포 워크트리 안의 일반 파일일 때만 `--no-index` 로 만든다(홈 밖 파일 읽기 방지). */
async function untrackedDiff(cwd: string, repoRoot: string, target: string): Promise<string> {
  let real: string;
  try {
    real = await realpath(path.resolve(cwd, target));
  } catch {
    return "";
  }
  if (real !== repoRoot && !real.startsWith(repoRoot + path.sep)) return "";
  const st = await stat(real).catch(() => null);
  if (st === null || !st.isFile()) return "";
  const rel = path.relative(repoRoot, real);
  const tracked = await runGit(["-C", repoRoot, "ls-files", "--error-unmatch", "--", rel]);
  if (tracked.code === 0) return "";
  // --no-index 는 차이가 있으면 exit code 1 이 정상이다.
  const result = await runGit(["-C", repoRoot, ...DIFF_BASE_ARGS, "--no-index", "--", "/dev/null", rel]);
  if (result.code !== 0 && result.code !== 1) return "";
  return result.stdout;
}

/** `git -C cwd diff [--cached] -- [path]`. 리포가 아니면 빈 패치. */
export async function gitDiff(cwd: string, opts: GitDiffOptions = {}): Promise<GitDiffResponse> {
  const repoRoot = await findRepoRoot(cwd);
  if (repoRoot === null) return { patch: "" };

  const args = ["-C", cwd, ...DIFF_BASE_ARGS];
  if (opts.staged) args.push("--cached");
  args.push("--");
  if (opts.path !== undefined) args.push(opts.path);
  const result = await runGit(args);
  if (result.code !== 0) {
    const reason = result.stderr.split("\n")[0]?.trim() ?? "";
    throw new InvalidRequestError(`git diff 실패: ${reason}`);
  }
  if (result.stdout !== "" || opts.staged || opts.path === undefined) return { patch: result.stdout };
  return { patch: await untrackedDiff(cwd, repoRoot, opts.path) };
}
