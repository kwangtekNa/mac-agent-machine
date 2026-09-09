import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { FsEntry, FsEntryType, FsListResponse, GitStatusCode } from "@mam/protocol";
import { findRepoRoot } from "../git/status.js";
import { FsError } from "./read.js";
import { resolveInsideHome, statResolved } from "./sandbox.js";

export const LIST_LIMIT = 5000;

export interface ListOptions {
  /** 리포 루트 기준 상대경로 → 한 글자 상태 코드(`gitStatusMap` 결과). */
  gitStatus?: Map<string, string>;
}

/** `FsListResponse` + 5,000개 상한 초과 여부. 프로토콜 스키마에는 아직 없다(summary 제안). */
export interface FsListResult extends FsListResponse {
  truncated: boolean;
}

const KNOWN_CODES: ReadonlySet<string> = new Set(["M", "A", "D", "R", "?", "!"]);

/** porcelain 의 한 글자 코드를 프로토콜 enum 으로 정규화한다. */
function toStatusCode(raw: string): GitStatusCode | null {
  if (KNOWN_CODES.has(raw)) return raw as GitStatusCode;
  if (raw === "" || raw === " " || raw === ".") return null;
  if (raw === "C") return "A";
  return "M";
}

function compareDirents(a: Dirent, b: Dirent): number {
  const ad = a.isDirectory() ? 0 : 1;
  const bd = b.isDirectory() ? 0 : 1;
  if (ad !== bd) return ad - bd;
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function entryType(st: Stats): FsEntryType {
  if (st.isSymbolicLink()) return "symlink";
  if (st.isDirectory()) return "dir";
  if (st.isFile()) return "file";
  return "other";
}

function makeStatusLookup(
  repoRoot: string | null,
  dir: string,
  map: Map<string, string> | undefined,
): (name: string, isDir: boolean) => GitStatusCode | null {
  if (repoRoot === null || map === undefined || map.size === 0) return () => null;
  const dirRel = path.relative(repoRoot, dir);
  return (name, isDir) => {
    const rel = dirRel === "" ? name : `${dirRel}/${name}`;
    const direct = map.get(rel);
    if (direct !== undefined) return toStatusCode(direct);
    if (isDir) {
      const prefix = `${rel}/`;
      for (const key of map.keys()) if (key.startsWith(prefix)) return "M";
    }
    return null;
  };
}

export async function listDirectory(home: string, input: string, opts: ListOptions = {}): Promise<FsListResult> {
  const resolved = await resolveInsideHome(home, input);
  const realHome = await realpath(home);
  const st = await statResolved(resolved);
  if (!st.isDirectory()) throw new FsError("invalid_request", "디렉토리가 아닙니다");

  const [dirents, repoRoot] = await Promise.all([readdir(resolved, { withFileTypes: true }), findRepoRoot(resolved)]);
  dirents.sort(compareDirents);
  const truncated = dirents.length > LIST_LIMIT;
  const slice = truncated ? dirents.slice(0, LIST_LIMIT) : dirents;
  const statusOf = makeStatusLookup(repoRoot, resolved, opts.gitStatus);

  const stats = await Promise.all(
    slice.map(async (d): Promise<Stats | null> => {
      try {
        return await lstat(path.join(resolved, d.name));
      } catch {
        return null; // readdir 과 lstat 사이에 사라진 항목은 건너뛴다
      }
    }),
  );

  const entries: FsEntry[] = [];
  slice.forEach((d, i) => {
    const ls = stats[i];
    if (ls === null || ls === undefined) return;
    const type = entryType(ls);
    entries.push({
      name: d.name,
      path: path.join(resolved, d.name),
      type,
      size: type === "file" ? ls.size : null,
      mtime: ls.mtime.toISOString(),
      isHidden: d.name.startsWith("."),
      gitStatus: statusOf(d.name, type === "dir"),
    });
  });

  return {
    path: resolved,
    parent: resolved === realHome ? null : path.dirname(resolved),
    isGitRepo: repoRoot !== null,
    entries,
    truncated,
  };
}
