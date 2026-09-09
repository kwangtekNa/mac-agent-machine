import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gitDiff } from "../../src/git/diff.js";
import { git, initRepo, makeTmpHome, removeTmp } from "../helpers/tmp-home.js";

let root: string;
let repo: string;
let outside: string;

beforeAll(async () => {
  root = await makeTmpHome("mam-diff-");
  repo = join(root, "repo");
  outside = join(root, "outside");
  await initRepo(repo);
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "secret\n");
  await writeFile(join(repo, "a.txt"), "hello\n");
  await writeFile(join(repo, "b.txt"), "b\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "init");
  await writeFile(join(repo, "a.txt"), "hello\nworld\n");
  await writeFile(join(repo, "b.txt"), "b\nstaged\n");
  await git(repo, "add", "b.txt");
  await writeFile(join(repo, "new.txt"), "fresh\n");
  await symlink(join(outside, "secret.txt"), join(repo, "link"));
});

afterAll(async () => {
  await removeTmp(root);
});

describe("gitDiff", () => {
  it("returns the worktree diff of the whole repo", async () => {
    const { patch } = await gitDiff(repo);
    expect(patch).toContain("diff --git a/a.txt b/a.txt");
    expect(patch).toContain("+world");
    expect(patch).not.toContain("+staged");
  });

  it("limits the diff to a path (absolute or relative)", async () => {
    const abs = await gitDiff(repo, { path: join(repo, "a.txt") });
    const rel = await gitDiff(repo, { path: "a.txt" });
    expect(abs.patch).toContain("+world");
    expect(rel.patch).toBe(abs.patch);
    expect((await gitDiff(repo, { path: "b.txt" })).patch).toBe("");
  });

  it("returns the staged diff with staged=true", async () => {
    const { patch } = await gitDiff(repo, { staged: true });
    expect(patch).toContain("diff --git a/b.txt b/b.txt");
    expect(patch).toContain("+staged");
    expect(patch).not.toContain("+world");
  });

  it("produces a patch for an untracked file via --no-index", async () => {
    const { patch } = await gitDiff(repo, { path: "new.txt" });
    expect(patch).toContain("--- /dev/null");
    expect(patch).toContain("+++ b/new.txt");
    expect(patch).toContain("+fresh");
    expect((await gitDiff(repo, { path: join(repo, "new.txt") })).patch).toBe(patch);
    expect((await gitDiff(repo, { path: "new.txt", staged: true })).patch).toBe("");
  });

  it("never reads an untracked symlink that points outside the repo", async () => {
    const { patch } = await gitDiff(repo, { path: "link" });
    expect(patch).not.toContain("secret");
  });

  it("rejects paths outside the repository as invalid_request", async () => {
    await expect(gitDiff(repo, { path: join(outside, "secret.txt") })).rejects.toMatchObject({ code: "invalid_request", status: 400 });
  });

  it("returns an empty patch outside a repository or for unknown paths", async () => {
    expect(await gitDiff(outside)).toEqual({ patch: "" });
    expect(await gitDiff(repo, { path: "does-not-exist.txt" })).toEqual({ patch: "" });
  });
});
