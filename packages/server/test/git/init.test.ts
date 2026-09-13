import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GitInitResponseSchema } from "@mam/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MamError } from "../../src/errors.js";
import { DEFAULT_GITIGNORE, assertNotInsideRepo, initRepository } from "../../src/git/init.js";
import { git, initRepo, makeTmpHome, removeTmp } from "../helpers/tmp-home.js";

const SHA_RE = /^[0-9a-f]{40}$/;

let tmp: string;
let home: string;

beforeEach(async () => {
  tmp = await makeTmpHome("mam-git-init-");
  home = await realpath(tmp);
});

afterEach(async () => {
  await removeTmp(tmp);
});

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function lsFiles(dir: string): Promise<string[]> {
  return (await git(dir, "ls-files", "-z")).split("\0").filter((p) => p !== "");
}

/** `home/<name>` 에 파일 3개 + `node_modules/x.js` + `.DS_Store` 를 둔다. 커밋 대상은 3개, 합계 바이트는 반환값. */
async function projectDir(name: string): Promise<{ dir: string; bytes: number }> {
  const dir = join(home, name);
  await mkdir(join(dir, "src"), { recursive: true });
  await mkdir(join(dir, "node_modules"), { recursive: true });
  const files: Array<[string, string]> = [
    ["README.md", "# hello\n"],
    ["src/index.ts", "export const a = 1;\n"],
    ["package.json", '{ "name": "x" }\n'],
  ];
  let bytes = 0;
  for (const [rel, content] of files) {
    await writeFile(join(dir, rel), content);
    bytes += Buffer.byteLength(content);
  }
  await writeFile(join(dir, "node_modules", "x.js"), "module.exports = 1;\n");
  await writeFile(join(dir, ".DS_Store"), Buffer.from([0, 1, 2]));
  return { dir, bytes };
}

async function expectError(promise: Promise<unknown>, status: number, code: string, messageIncludes?: string): Promise<void> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(MamError);
    expect((err as MamError).status).toBe(status);
    expect((err as MamError).code).toBe(code);
    if (messageIncludes !== undefined) expect((err as MamError).message).toContain(messageIncludes);
    return;
  }
  throw new Error(`expected ${status} ${code}`);
}

describe("initRepository", () => {
  it("empty directory → one --allow-empty commit on main, files 0, default .gitignore created", async () => {
    const dir = join(home, "empty");
    await mkdir(dir);
    const result = await initRepository(dir);
    expect(GitInitResponseSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({ initialized: true, branch: "main", files: 0, bytes: 0, createdGitignore: true });
    expect(result.commit).toMatch(SHA_RE);
    expect((await git(dir, "rev-parse", "HEAD")).trim()).toBe(result.commit);
    expect((await git(dir, "symbolic-ref", "--short", "HEAD")).trim()).toBe("main");
    expect((await git(dir, "rev-list", "--count", "HEAD")).trim()).toBe("1");
    expect((await git(dir, "log", "-1", "--format=%s")).trim()).toBe("Initial commit");
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe(DEFAULT_GITIGNORE);
    expect(await lsFiles(dir)).toEqual([".gitignore"]);
    expect((await git(dir, "status", "--porcelain")).trim()).toBe("");
  });

  it("3 files + node_modules + .DS_Store → files 3, ignored paths are not committed", async () => {
    const { dir, bytes } = await projectDir("proj");
    const result = await initRepository(dir);
    expect(result).toMatchObject({ initialized: true, branch: "main", files: 3, bytes, createdGitignore: true });
    expect(result.commit).toMatch(SHA_RE);
    const tracked = await lsFiles(dir);
    expect(tracked.sort()).toEqual([".gitignore", "README.md", "package.json", "src/index.ts"]);
    expect(tracked.some((p) => p.startsWith("node_modules"))).toBe(false);
    expect(tracked).not.toContain(".DS_Store");
    expect((await git(dir, "status", "--porcelain")).trim()).toBe("");
  });

  it("keeps an existing .gitignore untouched and reports createdGitignore false", async () => {
    const { dir } = await projectDir("own-ignore");
    const own = "# mine\n*.tmp\n";
    await writeFile(join(dir, ".gitignore"), own);
    await writeFile(join(dir, "scratch.tmp"), "tmp");
    const result = await initRepository(dir);
    expect(result.createdGitignore).toBe(false);
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe(own);
    const tracked = await lsFiles(dir);
    // 사용자의 .gitignore 는 기존 파일이므로 커밋 대상이자 files 에 포함된다. node_modules 는 사용자 규칙에 없으니 커밋된다.
    expect(tracked).toContain(".gitignore");
    expect(tracked).toContain("node_modules/x.js");
    expect(tracked).not.toContain("scratch.tmp");
    expect(result.files).toBe(tracked.length);
  });

  it("dryRun leaves cwd untouched (no .git, no .gitignore) and matches the real run's files/bytes", async () => {
    const { dir, bytes } = await projectDir("dry");
    const dry = await initRepository(dir, { dryRun: true });
    expect(GitInitResponseSchema.safeParse(dry).success).toBe(true);
    expect(dry).toEqual({ initialized: false, branch: "main", commit: null, files: 3, bytes, createdGitignore: true });
    expect(await exists(join(dir, ".git"))).toBe(false);
    expect(await exists(join(dir, ".gitignore"))).toBe(false);
    expect((await git(dir, "rev-parse", "--is-inside-work-tree").catch(() => "no")).trim()).toBe("no");

    const real = await initRepository(dir);
    expect({ files: real.files, bytes: real.bytes, createdGitignore: real.createdGitignore }).toEqual({
      files: dry.files,
      bytes: dry.bytes,
      createdGitignore: dry.createdGitignore,
    });
  });

  it("dryRun on an empty directory reports files 0 and does not create anything", async () => {
    const dir = join(home, "dry-empty");
    await mkdir(dir);
    const dry = await initRepository(dir, { dryRun: true });
    expect(dry).toEqual({ initialized: false, branch: "main", commit: null, files: 0, bytes: 0, createdGitignore: true });
    expect(await exists(join(dir, ".git"))).toBe(false);
    expect(await exists(join(dir, ".gitignore"))).toBe(false);
  });

  it("409 when the directory is already a repository (also for dryRun)", async () => {
    const dir = join(home, "repo");
    await initRepo(dir);
    await expectError(initRepository(dir), 409, "conflict", dir);
    await expectError(initRepository(dir, { dryRun: true }), 409, "conflict", dir);
    await expectError(assertNotInsideRepo(dir), 409, "conflict", dir);
  });

  it("409 when a parent directory is a repository, naming the parent", async () => {
    const parent = join(home, "parent");
    await initRepo(parent);
    const child = join(parent, "packages", "child");
    await mkdir(child, { recursive: true });
    await writeFile(join(child, "a.txt"), "a");
    await expectError(initRepository(child), 409, "conflict", parent);
    await expectError(initRepository(child, { dryRun: true }), 409, "conflict", parent);
    expect(await exists(join(child, ".git"))).toBe(false);
    expect(await exists(join(child, ".gitignore"))).toBe(false);
  });

  it("commits with the MacAgent fallback author when user.name/email are not configured", async () => {
    const saved: Record<string, string | undefined> = {};
    for (const key of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    // tmp-home.ts 가 GIT_CONFIG_GLOBAL=/dev/null, GIT_CONFIG_NOSYSTEM=1 을 고정하므로 user.name 은 비어 있다.
    try {
      const { dir } = await projectDir("no-author");
      const result = await initRepository(dir);
      expect(result.commit).toMatch(SHA_RE);
      expect((await git(dir, "log", "-1", "--format=%an <%ae>")).trim()).toBe("MacAgent <mam@mam.local>");
      // 전역 설정은 건드리지 않는다: 저장소 안에서도 user.name 이 여전히 비어 있다.
      await expect(git(dir, "config", "--get", "user.name")).rejects.toThrow();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("uses opts.now for the commit date when given", async () => {
    const dir = join(home, "dated");
    await mkdir(dir);
    const now = () => new Date("2026-09-13T01:02:03.000Z");
    await initRepository(dir, { now });
    expect((await git(dir, "log", "-1", "--format=%at")).trim()).toBe(String(Math.floor(now().getTime() / 1000)));
  });
});
