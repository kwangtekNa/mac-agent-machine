import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  WorktreeError,
  addWorktree,
  changesVsBase,
  commitAll,
  detectBaseBranch,
  hasMergeInProgress,
  isAncestor,
  isValidBranchName,
  mergeIntoBase,
  removeWorktree,
  syncFromBase,
  unmergedFiles,
  worktreeIsDirty,
} from "../../src/git/worktree.js";
import { git, initRepo, makeTmpHome, removeTmp } from "../helpers/tmp-home.js";

const AUTHOR = "민수 (mam-team) <minsu@mam.local>";
const SHA_RE = /^[0-9a-f]{40}$/;

let root: string;

beforeAll(async () => {
  root = await makeTmpHome("mam-wt-");
});

afterAll(async () => {
  await removeTmp(root);
});

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** `root/<name>` 에 `main` 브랜치와 커밋 1개(`a.txt`, `shared.txt`, `.gitignore`)를 가진 저장소를 만든다. */
async function repoWithCommit(name: string): Promise<string> {
  const dir = join(root, name);
  await initRepo(dir);
  await writeFile(join(dir, "a.txt"), "hello\n");
  await writeFile(join(dir, "shared.txt"), "line1\n");
  await writeFile(join(dir, ".gitignore"), "ignored.txt\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "init");
  return dir;
}

/** 저장소 밖(`root/<name>-wt/<handle>`)에 worktree 를 만들고 경로를 돌려준다. */
async function worktreeFor(repo: string, name: string, handle: string): Promise<{ wt: string; branch: string }> {
  const wt = join(root, `${name}-wt`, handle);
  const branch = `mam/${name}/${handle}`;
  await addWorktree({ repo, path: wt, branch, base: "main" });
  return { wt, branch };
}

async function commitFile(dir: string, file: string, content: string, message: string): Promise<void> {
  await writeFile(join(dir, file), content);
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", message);
}

async function porcelain(dir: string): Promise<string> {
  return git(dir, "status", "--porcelain");
}

async function hasMergeHead(dir: string): Promise<boolean> {
  try {
    await git(dir, "rev-parse", "--verify", "--quiet", "MERGE_HEAD");
    return true;
  } catch {
    return false;
  }
}

describe("detectBaseBranch", () => {
  it("returns the current branch of the checkout", async () => {
    const repo = await repoWithCommit("base-main");
    expect(await detectBaseBranch(repo)).toBe("main");
    await git(repo, "checkout", "-q", "-b", "feature/x");
    expect(await detectBaseBranch(repo)).toBe("feature/x");
  });

  it("throws code detached on a detached HEAD", async () => {
    const repo = await repoWithCommit("base-detached");
    await git(repo, "checkout", "-q", "--detach");
    const err = await detectBaseBranch(repo).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorktreeError);
    expect(err).toMatchObject({ code: "detached" });
  });

  it("throws code not_repo outside a repository or for a missing directory", async () => {
    const plain = join(root, "plain");
    await mkdir(plain);
    await expect(detectBaseBranch(plain)).rejects.toMatchObject({ code: "not_repo" });
    await expect(detectBaseBranch(join(root, "does-not-exist"))).rejects.toMatchObject({ code: "not_repo" });
  });

  it("rejects relative paths as invalid_request", async () => {
    await expect(detectBaseBranch("relative/dir")).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("isValidBranchName", () => {
  it("accepts mam/<team-slug>/<handle> style names", () => {
    expect(isValidBranchName("mam/backend/minsu")).toBe(true);
    expect(isValidBranchName("mam/backend/minsu-2")).toBe(true);
    expect(isValidBranchName("main")).toBe(true);
    expect(isValidBranchName("release/v1.2.3")).toBe(true);
    expect(isValidBranchName("feat_x")).toBe(true);
  });

  it("rejects empty, whitespace, '..', option-like and malformed names", () => {
    expect(isValidBranchName("")).toBe(false);
    expect(isValidBranchName("a b")).toBe(false);
    expect(isValidBranchName("a\tb")).toBe(false);
    expect(isValidBranchName("a..b")).toBe(false);
    expect(isValidBranchName("-x")).toBe(false);
    expect(isValidBranchName("--force")).toBe(false);
    expect(isValidBranchName("/a")).toBe(false);
    expect(isValidBranchName("a/")).toBe(false);
    expect(isValidBranchName("a//b")).toBe(false);
    expect(isValidBranchName("a.lock")).toBe(false);
    expect(isValidBranchName("a/.b")).toBe(false);
    expect(isValidBranchName("한글")).toBe(false);
    expect(isValidBranchName("a@{b}")).toBe(false);
    expect(isValidBranchName("a;rm -rf")).toBe(false);
  });
});

describe("addWorktree", () => {
  it("creates a worktree outside the repo on a new branch, creating parent directories", async () => {
    const repo = await repoWithCommit("add");
    const { wt, branch } = await worktreeFor(repo, "add", "minsu");
    expect(await exists(join(wt, "a.txt"))).toBe(true);
    expect((await git(repo, "branch", "--list", branch)).trim()).toContain(branch);
    expect((await git(wt, "symbolic-ref", "--short", "HEAD")).trim()).toBe(branch);
    expect((await git(wt, "rev-parse", "HEAD")).trim()).toBe((await git(repo, "rev-parse", "main")).trim());
    expect(await git(repo, "worktree", "list", "--porcelain")).toContain(`branch refs/heads/${branch}`);
  });

  it("attaches to an existing branch without -b", async () => {
    const repo = await repoWithCommit("add-existing");
    await git(repo, "branch", "mam/add-existing/jiyeon", "main");
    await commitFile(repo, "b.txt", "b\n", "second");
    const before = (await git(repo, "branch", "--list")).trim().split("\n").length;

    const { wt, branch } = await worktreeFor(repo, "add-existing", "jiyeon");
    expect((await git(wt, "symbolic-ref", "--short", "HEAD")).trim()).toBe(branch);
    // 기존 브랜치(init 시점)에 붙었으므로 두 번째 커밋의 파일은 없다.
    expect(await exists(join(wt, "b.txt"))).toBe(false);
    expect((await git(repo, "branch", "--list")).trim().split("\n").length).toBe(before);
  });

  it("re-attaches the same branch after the worktree was removed", async () => {
    const repo = await repoWithCommit("add-again");
    const { wt, branch } = await worktreeFor(repo, "add-again", "minsu");
    await removeWorktree(repo, wt);
    await addWorktree({ repo, path: wt, branch, base: "main" });
    expect((await git(wt, "symbolic-ref", "--short", "HEAD")).trim()).toBe(branch);
  });

  it("rejects relative paths and invalid branch names as invalid_request", async () => {
    const repo = await repoWithCommit("add-invalid");
    await expect(addWorktree({ repo, path: "relative/wt", branch: "mam/x/y", base: "main" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(addWorktree({ repo, path: join(root, "add-invalid-wt"), branch: "a..b", base: "main" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(addWorktree({ repo, path: join(root, "add-invalid-wt"), branch: "mam/x/y", base: "-x" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(await exists(join(root, "add-invalid-wt"))).toBe(false);
  });

  it("throws git_failed when the base does not exist", async () => {
    const repo = await repoWithCommit("add-nobase");
    const err = await addWorktree({ repo, path: join(root, "add-nobase-wt"), branch: "mam/x/y", base: "nope" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(WorktreeError);
    expect(err).toMatchObject({ code: "git_failed" });
    expect((err as WorktreeError).detail).toBeTruthy();
  });
});

describe("worktreeIsDirty", () => {
  it("is false for a clean worktree, true with untracked or modified files, false for ignored files", async () => {
    const repo = await repoWithCommit("dirty");
    const { wt } = await worktreeFor(repo, "dirty", "minsu");
    expect(await worktreeIsDirty(wt)).toBe(false);
    await writeFile(join(wt, "ignored.txt"), "ignored\n");
    expect(await worktreeIsDirty(wt)).toBe(false);
    await writeFile(join(wt, "new.txt"), "new\n");
    expect(await worktreeIsDirty(wt)).toBe(true);
  });

  it("throws not_repo outside a repository", async () => {
    const plain = join(root, "plain-dirty");
    await mkdir(plain);
    await expect(worktreeIsDirty(plain)).rejects.toMatchObject({ code: "not_repo" });
  });
});

describe("commitAll", () => {
  it("returns null when there is nothing to commit (including ignored-only changes)", async () => {
    const repo = await repoWithCommit("commit-empty");
    const { wt } = await worktreeFor(repo, "commit-empty", "minsu");
    const head = (await git(wt, "rev-parse", "HEAD")).trim();
    expect(await commitAll(wt, { message: "민수: nothing", author: AUTHOR })).toBeNull();
    await writeFile(join(wt, "ignored.txt"), "ignored\n");
    expect(await commitAll(wt, { message: "민수: nothing", author: AUTHOR })).toBeNull();
    expect((await git(wt, "rev-parse", "HEAD")).trim()).toBe(head);
  });

  it("commits tracked, untracked and deleted changes with the given author", async () => {
    const repo = await repoWithCommit("commit");
    const { wt, branch } = await worktreeFor(repo, "commit", "minsu");
    await writeFile(join(wt, "a.txt"), "hello\nworld\n");
    await mkdir(join(wt, "src"));
    await writeFile(join(wt, "src", "new.ts"), "export const x = 1;\n");
    await git(wt, "rm", "-q", "shared.txt");

    const sha = await commitAll(wt, { message: "민수: 로그인 버그 수정", author: AUTHOR });
    expect(sha).toMatch(SHA_RE);
    expect((await git(wt, "rev-parse", "HEAD")).trim()).toBe(sha);
    expect((await git(wt, "log", "-1", "--format=%an")).trim()).toBe("민수 (mam-team)");
    expect((await git(wt, "log", "-1", "--format=%ae")).trim()).toBe("minsu@mam.local");
    expect((await git(wt, "log", "-1", "--format=%s")).trim()).toBe("민수: 로그인 버그 수정");
    expect((await git(wt, "show", "--name-status", "--format=", "HEAD")).trim().split("\n").sort()).toEqual([
      "A\tsrc/new.ts",
      "D\tshared.txt",
      "M\ta.txt",
    ]);
    expect(await porcelain(wt)).toBe("");
    // 브랜치가 앞서 있고 원본 체크아웃은 그대로다.
    expect((await git(repo, "rev-parse", branch)).trim()).toBe(sha);
    expect(await exists(join(repo, "shared.txt"))).toBe(true);
  });
});

describe("changesVsBase", () => {
  it("counts commits and lists numstat files (raw paths, binary as 0/0)", async () => {
    const repo = await repoWithCommit("changes");
    const { wt, branch } = await worktreeFor(repo, "changes", "minsu");
    await commitFile(wt, "a.txt", "hello\nworld\n", "one");
    await mkdir(join(wt, "docs"));
    await writeFile(join(wt, "docs", "한글 문서.md"), "# 제목\n\n본문\n");
    await writeFile(join(wt, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
    await git(wt, "rm", "-q", "shared.txt");
    await git(wt, "add", "-A");
    await git(wt, "commit", "-q", "-m", "two");

    const res = await changesVsBase(repo, "main", branch);
    expect(res.commits).toBe(2);
    expect(res.head).toBe((await git(repo, "rev-parse", branch)).trim());
    expect([...res.files].sort((x, y) => x.path.localeCompare(y.path))).toEqual([
      { path: "a.txt", additions: 1, deletions: 0 },
      { path: "blob.bin", additions: 0, deletions: 0 },
      { path: "docs/한글 문서.md", additions: 3, deletions: 0 },
      { path: "shared.txt", additions: 0, deletions: 1 },
    ]);
  });

  it("returns zero commits and no files when the branch equals the base", async () => {
    const repo = await repoWithCommit("changes-none");
    const { branch } = await worktreeFor(repo, "changes-none", "minsu");
    const res = await changesVsBase(repo, "main", branch);
    expect(res).toEqual({ commits: 0, files: [], head: (await git(repo, "rev-parse", "main")).trim() });
  });

  it("ignores commits that only exist on the base (three-dot diff)", async () => {
    const repo = await repoWithCommit("changes-base");
    const { wt, branch } = await worktreeFor(repo, "changes-base", "minsu");
    await commitFile(repo, "base-only.txt", "base\n", "base");
    await commitFile(wt, "branch-only.txt", "branch\n", "branch");
    const res = await changesVsBase(repo, "main", branch);
    expect(res.commits).toBe(1);
    expect(res.files).toEqual([{ path: "branch-only.txt", additions: 1, deletions: 0 }]);
  });

  it("rejects invalid ref names and unknown branches", async () => {
    const repo = await repoWithCommit("changes-invalid");
    await expect(changesVsBase(repo, "main", "a..b")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(changesVsBase(repo, "main", "mam/none/none")).rejects.toMatchObject({ code: "git_failed" });
  });
});

describe("mergeIntoBase", () => {
  it("merges with --no-ff, keeps the branch and uses the message", async () => {
    const repo = await repoWithCommit("merge");
    const { wt, branch } = await worktreeFor(repo, "merge", "minsu");
    await commitFile(wt, "feature.txt", "feature\n", "민수: 기능 추가");
    const branchHead = (await git(repo, "rev-parse", branch)).trim();

    const res = await mergeIntoBase({ repo, base: "main", branch, message: "Merge 민수 (mam/merge/minsu)" });
    expect(res.status).toBe("merged");
    if (res.status !== "merged") throw new Error("unreachable");
    expect(res.sha).toMatch(SHA_RE);
    expect((await git(repo, "rev-parse", "HEAD")).trim()).toBe(res.sha);
    expect(res.sha).not.toBe(branchHead);
    expect((await git(repo, "log", "--merges", "--format=%s")).trim().split("\n")).toEqual(["Merge 민수 (mam/merge/minsu)"]);
    expect((await git(repo, "rev-parse", `${res.sha}^2`)).trim()).toBe(branchHead);
    expect(await exists(join(repo, "feature.txt"))).toBe(true);
    expect((await git(repo, "branch", "--list", branch)).trim()).toContain(branch);
    expect((await git(repo, "symbolic-ref", "--short", "HEAD")).trim()).toBe("main");
    expect(await porcelain(repo)).toBe("");
  });

  it("returns dirty when the project checkout has uncommitted changes and does not merge", async () => {
    const repo = await repoWithCommit("merge-dirty");
    const { wt, branch } = await worktreeFor(repo, "merge-dirty", "minsu");
    await commitFile(wt, "feature.txt", "feature\n", "feat");
    await writeFile(join(repo, "wip.txt"), "wip\n");
    const head = (await git(repo, "rev-parse", "HEAD")).trim();
    expect(await mergeIntoBase({ repo, base: "main", branch, message: "m" })).toEqual({ status: "dirty" });
    expect((await git(repo, "rev-parse", "HEAD")).trim()).toBe(head);
    expect(await exists(join(repo, "wip.txt"))).toBe(true);
  });

  it("returns wrong_branch with the current branch when the checkout is not on the base", async () => {
    const repo = await repoWithCommit("merge-wrong");
    const { wt, branch } = await worktreeFor(repo, "merge-wrong", "minsu");
    await commitFile(wt, "feature.txt", "feature\n", "feat");
    await git(repo, "checkout", "-q", "-b", "other");
    expect(await mergeIntoBase({ repo, base: "main", branch, message: "m" })).toEqual({ status: "wrong_branch", current: "other" });
    expect((await git(repo, "log", "--merges", "--format=%s")).trim()).toBe("");
  });

  it("throws detached when the checkout is detached", async () => {
    const repo = await repoWithCommit("merge-detached");
    const { branch } = await worktreeFor(repo, "merge-detached", "minsu");
    await git(repo, "checkout", "-q", "--detach");
    await expect(mergeIntoBase({ repo, base: "main", branch, message: "m" })).rejects.toMatchObject({ code: "detached" });
  });

  it("aborts on conflict, reports the files and leaves the base checkout clean", async () => {
    const repo = await repoWithCommit("merge-conflict");
    const { wt, branch } = await worktreeFor(repo, "merge-conflict", "minsu");
    await commitFile(wt, "shared.txt", "from-branch\n", "branch side");
    await commitFile(repo, "shared.txt", "from-main\n", "main side");
    const head = (await git(repo, "rev-parse", "HEAD")).trim();

    const res = await mergeIntoBase({ repo, base: "main", branch, message: "m" });
    expect(res).toEqual({ status: "conflict", conflictFiles: ["shared.txt"] });
    expect(await porcelain(repo)).toBe("");
    expect(await hasMergeHead(repo)).toBe(false);
    expect((await git(repo, "rev-parse", "HEAD")).trim()).toBe(head);
    expect((await git(repo, "show", "HEAD:shared.txt")).toString()).toBe("from-main\n");
    expect((await git(repo, "branch", "--list", branch)).trim()).toContain(branch);
  });

  it("rejects invalid branch names and unknown branches without touching the checkout", async () => {
    const repo = await repoWithCommit("merge-invalid");
    await expect(mergeIntoBase({ repo, base: "main", branch: "a b", message: "m" })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(mergeIntoBase({ repo, base: "main", branch: "mam/none/none", message: "m" })).rejects.toMatchObject({ code: "git_failed" });
    expect(await porcelain(repo)).toBe("");
    expect(await hasMergeHead(repo)).toBe(false);
  });
});

describe("syncFromBase", () => {
  it("merges new base commits into the worktree and reports up_to_date afterwards", async () => {
    const repo = await repoWithCommit("sync");
    const { wt } = await worktreeFor(repo, "sync", "minsu");
    expect(await syncFromBase(wt, "main")).toEqual({ status: "up_to_date" });

    await commitFile(repo, "base-new.txt", "base\n", "base commit");
    expect(await syncFromBase(wt, "main")).toEqual({ status: "merged" });
    expect(await exists(join(wt, "base-new.txt"))).toBe(true);
    expect(await hasMergeInProgress(wt)).toBe(false);
    expect(await porcelain(wt)).toBe("");
    expect(await syncFromBase(wt, "main")).toEqual({ status: "up_to_date" });
  });

  it("keeps the worktree branch commits when merging a diverged base", async () => {
    const repo = await repoWithCommit("sync-diverged");
    const { wt, branch } = await worktreeFor(repo, "sync-diverged", "minsu");
    await commitFile(wt, "feature.txt", "feature\n", "feat");
    await commitFile(repo, "base-new.txt", "base\n", "base commit");
    expect(await syncFromBase(wt, "main")).toEqual({ status: "merged" });
    expect(await exists(join(wt, "feature.txt"))).toBe(true);
    expect(await exists(join(wt, "base-new.txt"))).toBe(true);
    expect((await git(wt, "symbolic-ref", "--short", "HEAD")).trim()).toBe(branch);
    // 원본 체크아웃(main)은 움직이지 않았다.
    expect(await exists(join(repo, "feature.txt"))).toBe(false);
  });

  it("returns conflict with the files and leaves MERGE_HEAD and markers in the worktree", async () => {
    const repo = await repoWithCommit("sync-conflict");
    const { wt } = await worktreeFor(repo, "sync-conflict", "minsu");
    expect(await hasMergeInProgress(wt)).toBe(false);
    await commitFile(wt, "shared.txt", "from-branch\n", "branch side");
    await commitFile(repo, "shared.txt", "from-main\n", "main side");

    expect(await syncFromBase(wt, "main")).toEqual({ status: "conflict", conflictFiles: ["shared.txt"] });
    expect(await hasMergeInProgress(wt)).toBe(true);
    expect(await hasMergeHead(wt)).toBe(true);
    expect(await readFile(join(wt, "shared.txt"), "utf8")).toContain("<<<<<<<");
    // 원본 체크아웃은 영향이 없다.
    expect(await porcelain(repo)).toBe("");
    expect(await hasMergeHead(repo)).toBe(false);
  });

  it("rejects invalid base names", async () => {
    const repo = await repoWithCommit("sync-invalid");
    const { wt } = await worktreeFor(repo, "sync-invalid", "minsu");
    await expect(syncFromBase(wt, "-x")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(syncFromBase(wt, "nope")).rejects.toMatchObject({ code: "git_failed" });
  });
});

describe("removeWorktree", () => {
  it("removes a clean worktree, prunes, and keeps the branch", async () => {
    const repo = await repoWithCommit("remove");
    const { wt, branch } = await worktreeFor(repo, "remove", "minsu");
    await commitFile(wt, "feature.txt", "feature\n", "feat");
    await removeWorktree(repo, wt);
    expect(await exists(wt)).toBe(false);
    expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain(`branch refs/heads/${branch}`);
    expect((await git(repo, "branch", "--list", branch)).trim()).toContain(branch);
  });

  it("throws dirty and leaves the directory when the worktree has uncommitted changes", async () => {
    const repo = await repoWithCommit("remove-dirty");
    const { wt } = await worktreeFor(repo, "remove-dirty", "minsu");
    await writeFile(join(wt, "wip.txt"), "wip\n");
    const err = await removeWorktree(repo, wt).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorktreeError);
    expect(err).toMatchObject({ code: "dirty" });
    expect(await exists(join(wt, "wip.txt"))).toBe(true);
    expect(await git(repo, "worktree", "list", "--porcelain")).toContain("branch refs/heads/mam/remove-dirty/minsu");
  });

  it("rejects relative paths as invalid_request", async () => {
    const repo = await repoWithCommit("remove-invalid");
    await expect(removeWorktree(repo, "relative/wt")).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("unmergedFiles / isAncestor (step 6)", () => {
  it("lists conflicted files during an in-progress merge and nothing when clean", async () => {
    const repo = await repoWithCommit("unmerged");
    const { wt } = await worktreeFor(repo, "unmerged", "minsu");
    expect(await unmergedFiles(wt)).toEqual([]);
    await commitFile(wt, "shared.txt", "from-branch\n", "branch side");
    await commitFile(repo, "shared.txt", "from-main\n", "main side");
    expect(await syncFromBase(wt, "main")).toEqual({ status: "conflict", conflictFiles: ["shared.txt"] });
    expect(await unmergedFiles(wt)).toEqual(["shared.txt"]);
    await expect(unmergedFiles("relative/path")).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("isAncestor tells whether a commit is reachable from a ref", async () => {
    const repo = await repoWithCommit("ancestor");
    const { wt, branch } = await worktreeFor(repo, "ancestor", "minsu");
    await commitFile(wt, "feature.txt", "feature\n", "feat");
    const head = (await git(repo, "rev-parse", branch)).trim();
    expect(await isAncestor(repo, head, "main")).toBe(false);
    expect(await isAncestor(repo, "main", head)).toBe(true);
    const res = await mergeIntoBase({ repo, base: "main", branch, message: "m" });
    expect(res.status).toBe("merged");
    expect(await isAncestor(repo, head, "main")).toBe(true);
    await expect(isAncestor(repo, "0000000000000000000000000000000000000000", "main")).rejects.toMatchObject({ code: "git_failed" });
  });
});
