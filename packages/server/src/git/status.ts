import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import type { GitStatusEntry, GitStatusResponse } from "@mam/protocol";
import { InternalError } from "../errors.js";

export const GIT_TIMEOUT_MS = 10_000;

export interface GitRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const NOT_REPO: GitStatusResponse = { isRepo: false, branch: null, ahead: 0, behind: 0, entries: [] };

/** `spawn('git', args)` 로 실행한다. 셸을 거치지 않고, 타임아웃(기본 10초) 후 SIGKILL 한다. */
export function runGit(args: readonly string[], opts: { timeoutMs?: number } = {}): Promise<GitRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: opts.timeoutMs ?? GIT_TIMEOUT_MS,
      killSignal: "SIGKILL",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (e) => reject(new InternalError(`git 실행 실패: ${e.message}`)));
    child.on("close", (code, signal) => {
      if (signal !== null) {
        reject(new InternalError(`git 이 ${signal} 로 종료되었습니다 (타임아웃 ${opts.timeoutMs ?? GIT_TIMEOUT_MS}ms)`));
        return;
      }
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
  });
}

/** `git -C dir rev-parse --show-toplevel`. 리포가 아니거나 git 을 쓸 수 없으면 null. */
export async function findRepoRoot(dir: string): Promise<string | null> {
  let result: GitRunResult;
  try {
    result = await runGit(["-C", dir, "rev-parse", "--show-toplevel"]);
  } catch {
    return null;
  }
  if (result.code !== 0) return null;
  const top = result.stdout.trim();
  if (top === "") return null;
  try {
    return await realpath(top);
  } catch {
    return top;
  }
}

/** 앞 `n - 1` 개 공백까지만 나눈다. 마지막 필드(경로)는 공백을 포함할 수 있다. */
function splitFields(record: string, n: number): string[] {
  const out: string[] = [];
  let rest = record;
  for (let i = 0; i < n - 1; i++) {
    const idx = rest.indexOf(" ");
    if (idx < 0) break;
    out.push(rest.slice(0, idx));
    rest = rest.slice(idx + 1);
  }
  out.push(rest);
  return out;
}

function normalizeCode(ch: string | undefined): string {
  return ch === undefined || ch === "." ? " " : ch;
}

/** `git status --porcelain=v2 --branch -z` 출력을 파싱한다. */
export function parsePorcelainV2(raw: string): GitStatusResponse {
  let branch: string | null = null;
  let ahead = 0;
  let behind = 0;
  const entries: GitStatusEntry[] = [];
  const tokens = raw.split("\0");

  for (let i = 0; i < tokens.length; i++) {
    const record = tokens[i] ?? "";
    if (record === "") continue;
    if (record.startsWith("# ")) {
      const [key, ...rest] = record.slice(2).split(" ");
      if (key === "branch.head") {
        const head = rest.join(" ");
        branch = head === "(detached)" || head === "" ? null : head;
      } else if (key === "branch.ab") {
        ahead = Number.parseInt((rest[0] ?? "+0").slice(1), 10) || 0;
        behind = Number.parseInt((rest[1] ?? "-0").slice(1), 10) || 0;
      }
      continue;
    }
    const kind = record[0];
    if (kind === "?" || kind === "!") {
      entries.push({ path: record.slice(2), index: kind, worktree: kind });
    } else if (kind === "1") {
      const f = splitFields(record, 9);
      entries.push({ path: f[8] ?? "", index: normalizeCode(f[1]?.[0]), worktree: normalizeCode(f[1]?.[1]) });
    } else if (kind === "2") {
      const f = splitFields(record, 10);
      entries.push({ path: f[9] ?? "", index: normalizeCode(f[1]?.[0]), worktree: normalizeCode(f[1]?.[1]) });
      i++; // -z 모드에서는 원래 경로가 다음 토큰으로 온다
    } else if (kind === "u") {
      const f = splitFields(record, 11);
      entries.push({ path: f[10] ?? "", index: normalizeCode(f[1]?.[0]), worktree: normalizeCode(f[1]?.[1]) });
    }
  }
  return { isRepo: true, branch, ahead, behind, entries: entries.filter((e) => e.path !== "") };
}

/** `git -C cwd status --porcelain=v2 --branch -z`. 리포가 아니면 `isRepo: false` 와 빈 값. */
export async function gitStatus(cwd: string): Promise<GitStatusResponse> {
  const result = await runGit([
    "-C", cwd, "status", "--porcelain=v2", "--branch", "--untracked-files=normal", "--ignored=traditional", "-z",
  ]);
  if (result.code !== 0) return NOT_REPO;
  return parsePorcelainV2(result.stdout);
}

/** 리포 루트 기준 상대경로 → 한 글자 코드. worktree 코드 우선, 없으면 index 코드. untracked `?`, ignored `!`. */
export async function gitStatusMap(cwd: string): Promise<Map<string, string>> {
  const status = await gitStatus(cwd);
  const map = new Map<string, string>();
  for (const entry of status.entries) {
    const code = entry.worktree !== " " ? entry.worktree : entry.index;
    if (code === " ") continue;
    map.set(entry.path.endsWith("/") ? entry.path.slice(0, -1) : entry.path, code);
  }
  return map;
}
