import { mkdir, realpath, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GitStatusResponseSchema } from "@mam/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findRepoRoot, gitStatus, gitStatusMap, parsePorcelainV2 } from "../../src/git/status.js";
import { git, initRepo, makeTmpHome, removeTmp } from "../helpers/tmp-home.js";

let root: string;

beforeAll(async () => {
  root = await makeTmpHome("mam-git-");
});

afterAll(async () => {
  await removeTmp(root);
});

async function repoWithCommit(name: string): Promise<string> {
  const dir = join(root, name);
  await initRepo(dir);
  await writeFile(join(dir, "a.txt"), "hello\n");
  await writeFile(join(dir, "d.txt"), "d\n");
  await mkdir(join(dir, "sub"));
  await writeFile(join(dir, "sub", "f.txt"), "f\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "init");
  return dir;
}

describe("findRepoRoot", () => {
  it("returns the realpath of the repo root from any subdirectory", async () => {
    const dir = await repoWithCommit("root-repo");
    expect(await findRepoRoot(join(dir, "sub"))).toBe(await realpath(dir));
  });

  it("returns null outside a repository or for a missing directory", async () => {
    const plain = join(root, "plain");
    await mkdir(plain);
    expect(await findRepoRoot(plain)).toBeNull();
    expect(await findRepoRoot(join(root, "does-not-exist"))).toBeNull();
  });
});

describe("gitStatus", () => {
  it("reports a clean repository", async () => {
    const dir = await repoWithCommit("clean");
    const res = await gitStatus(dir);
    expect(res).toEqual({ isRepo: true, branch: "main", ahead: 0, behind: 0, entries: [] });
    expect(GitStatusResponseSchema.safeParse(res).success).toBe(true);
    expect(await gitStatusMap(dir)).toEqual(new Map());
  });

  it("reports modified, added, untracked, renamed and ignored entries", async () => {
    const dir = await repoWithCommit("dirty");
    await writeFile(join(dir, "a.txt"), "hello\nworld\n");
    await writeFile(join(dir, "b.txt"), "b\n");
    await git(dir, "add", "b.txt");
    await writeFile(join(dir, "c.txt"), "c\n");
    await git(dir, "mv", "d.txt", "e.txt");
    await writeFile(join(dir, ".gitignore"), "ig.txt\n");
    await writeFile(join(dir, "ig.txt"), "ignored\n");
    await mkdir(join(dir, "newdir"));
    await writeFile(join(dir, "newdir", "x.txt"), "x\n");
    await writeFile(join(dir, "sub", "f.txt"), "f\nmore\n");
    await git(dir, "add", "sub/f.txt");
    await writeFile(join(dir, "sub", "f.txt"), "f\nmore\nagain\n");

    const res = await gitStatus(dir);
    expect(res.isRepo).toBe(true);
    expect(res.branch).toBe("main");
    const entries = Object.fromEntries(res.entries.map((e) => [e.path, `${e.index}${e.worktree}`]));
    expect(entries).toEqual({
      ".gitignore": "??",
      "a.txt": " M",
      "b.txt": "A ",
      "c.txt": "??",
      "e.txt": "R ",
      "ig.txt": "!!",
      "newdir/": "??",
      "sub/f.txt": "MM",
    });
    expect(res.entries.some((e) => e.path === "d.txt")).toBe(false);
    expect(GitStatusResponseSchema.safeParse(res).success).toBe(true);

    const map = await gitStatusMap(dir);
    expect(map).toEqual(
      new Map([
        [".gitignore", "?"],
        ["a.txt", "M"],
        ["b.txt", "A"],
        ["c.txt", "?"],
        ["e.txt", "R"],
        ["ig.txt", "!"],
        ["newdir", "?"],
        ["sub/f.txt", "M"],
      ]),
    );

    const fromSub = await gitStatus(join(dir, "sub"));
    expect(fromSub.entries.map((e) => e.path)).toEqual(res.entries.map((e) => e.path));
  });

  it("returns isRepo=false for non-repositories", async () => {
    const plain = join(root, "plain2");
    await mkdir(plain);
    expect(await gitStatus(plain)).toEqual({ isRepo: false, branch: null, ahead: 0, behind: 0, entries: [] });
    expect(await gitStatusMap(plain)).toEqual(new Map());
  });

  it("reports ahead/behind against the upstream", async () => {
    const origin = await repoWithCommit("origin");
    const work = join(root, "work");
    await git(root, "clone", "-q", origin, work);
    await writeFile(join(work, "local.txt"), "l\n");
    await git(work, "add", "local.txt");
    await git(work, "commit", "-q", "-m", "local");
    await writeFile(join(origin, "remote.txt"), "r\n");
    await git(origin, "add", "remote.txt");
    await git(origin, "commit", "-q", "-m", "remote");
    await git(work, "fetch", "-q");
    const res = await gitStatus(work);
    expect(res).toMatchObject({ isRepo: true, branch: "main", ahead: 1, behind: 1, entries: [] });
  });

  it("reports null branch when HEAD is detached", async () => {
    const dir = await repoWithCommit("detached");
    await git(dir, "checkout", "-q", "--detach");
    expect((await gitStatus(dir)).branch).toBeNull();
  });

  it("does not rename tracked paths on disk moves without git mv", async () => {
    const dir = await repoWithCommit("plain-move");
    await rename(join(dir, "d.txt"), join(dir, "moved.txt"));
    const map = await gitStatusMap(dir);
    expect(map.get("d.txt")).toBe("D");
    expect(map.get("moved.txt")).toBe("?");
  });
});

describe("parsePorcelainV2", () => {
  it("parses headers, ordinary, rename (with spaces) and unmerged records in -z form", () => {
    const raw = [
      "# branch.oid abc",
      "# branch.head feature/x",
      "# branch.upstream origin/feature/x",
      "# branch.ab +3 -2",
      "1 .M N... 100644 100644 100644 abc abc a.txt",
      "2 R. N... 100644 100644 100644 abc def R100 new name.txt",
      "old.txt",
      "u UU N... 100644 100644 100644 100644 a b c conflict.txt",
      "? untracked.txt",
      "! build/",
    ].join("\0") + "\0";
    expect(parsePorcelainV2(raw)).toEqual({
      isRepo: true,
      branch: "feature/x",
      ahead: 3,
      behind: 2,
      entries: [
        { path: "a.txt", index: " ", worktree: "M" },
        { path: "new name.txt", index: "R", worktree: " " },
        { path: "conflict.txt", index: "U", worktree: "U" },
        { path: "untracked.txt", index: "?", worktree: "?" },
        { path: "build/", index: "!", worktree: "!" },
      ],
    });
  });
});
