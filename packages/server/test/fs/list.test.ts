import { writeFileSync } from "node:fs";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FsListResponseSchema } from "@mam/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LIST_LIMIT, listDirectory } from "../../src/fs/list.js";
import { initRepo, makeTmpHome, removeTmp } from "../helpers/tmp-home.js";

let home: string;
let realHome: string;

beforeAll(async () => {
  home = await makeTmpHome("mam-list-");
  realHome = await realpath(home);
  const proj = join(home, "proj");
  await mkdir(join(proj, "src"), { recursive: true });
  await mkdir(join(proj, "b-dir"));
  await mkdir(join(proj, "A-dir"));
  await mkdir(join(proj, "newdir"));
  await writeFile(join(proj, "Zeta.txt"), "z");
  await writeFile(join(proj, "alpha.ts"), "a");
  await writeFile(join(proj, ".hidden"), "h");
  await writeFile(join(proj, "new.txt"), "n");
  await writeFile(join(proj, "src", "index.ts"), "i");
  await symlink(join(proj, "alpha.ts"), join(proj, "link"));
  await initRepo(proj);

  await mkdir(join(home, "plain"));
  await writeFile(join(home, "plain", "f.txt"), "f");

  const many = join(home, "many");
  await mkdir(many);
  for (let i = 0; i < LIST_LIMIT + 1; i++) writeFileSync(join(many, `f${String(i).padStart(5, "0")}`), "");
});

afterAll(async () => {
  await removeTmp(home);
});

describe("listDirectory", () => {
  it("sorts directories first, then names case-insensitively, and marks hidden entries", async () => {
    const res = await listDirectory(home, "~/proj");
    expect(res.path).toBe(join(realHome, "proj"));
    expect(res.parent).toBe(realHome);
    expect(res.isGitRepo).toBe(true);
    expect(res.truncated).toBe(false);
    expect(res.entries.map((e) => e.name)).toEqual([
      ".git", "A-dir", "b-dir", "newdir", "src", ".hidden", "alpha.ts", "link", "new.txt", "Zeta.txt",
    ]);
    const byName = Object.fromEntries(res.entries.map((e) => [e.name, e]));
    expect(byName[".git"]).toMatchObject({ type: "dir", isHidden: true, size: null });
    expect(byName["alpha.ts"]).toMatchObject({ type: "file", isHidden: false, size: 1, path: join(realHome, "proj", "alpha.ts") });
    expect(byName["link"]).toMatchObject({ type: "symlink", size: null });
    expect(byName[".hidden"]).toMatchObject({ type: "file", isHidden: true });
    for (const e of res.entries) {
      expect(new Date(e.mtime).toISOString()).toBe(e.mtime);
      expect(e.gitStatus).toBeNull();
    }
    expect(FsListResponseSchema.safeParse(res).success).toBe(true);
  });

  it("merges git status codes and marks directories with changes below as M", async () => {
    const gitStatus = new Map<string, string>([
      ["src/index.ts", "M"],
      ["new.txt", "?"],
      ["newdir", "?"],
      ["Zeta.txt", "T"],
    ]);
    const res = await listDirectory(home, "~/proj", { gitStatus });
    const byName = Object.fromEntries(res.entries.map((e) => [e.name, e.gitStatus]));
    expect(byName["src"]).toBe("M");
    expect(byName["new.txt"]).toBe("?");
    expect(byName["newdir"]).toBe("?");
    expect(byName["Zeta.txt"]).toBe("M");
    expect(byName["alpha.ts"]).toBeNull();
    expect(byName["A-dir"]).toBeNull();

    const sub = await listDirectory(home, "~/proj/src", { gitStatus });
    expect(sub.parent).toBe(join(realHome, "proj"));
    expect(sub.entries.map((e) => [e.name, e.gitStatus])).toEqual([["index.ts", "M"]]);
  });

  it("reports non-repositories and ignores a status map without a repo", async () => {
    const res = await listDirectory(home, "~/plain", { gitStatus: new Map([["f.txt", "M"]]) });
    expect(res.isGitRepo).toBe(false);
    expect(res.entries.map((e) => [e.name, e.gitStatus])).toEqual([["f.txt", null]]);
  });

  it("returns null parent for the home root", async () => {
    const res = await listDirectory(home, "~");
    expect(res.path).toBe(realHome);
    expect(res.parent).toBeNull();
    expect(res.entries.map((e) => e.name)).toEqual(["many", "plain", "proj"]);
  });

  it("caps entries at 5,000 and flags truncation", async () => {
    const res = await listDirectory(home, "~/many");
    expect(res.entries).toHaveLength(LIST_LIMIT);
    expect(res.truncated).toBe(true);
    expect(res.entries[0]?.name).toBe("f00000");
  });

  it("rejects files, missing and outside paths", async () => {
    await expect(listDirectory(home, "~/plain/f.txt")).rejects.toMatchObject({ code: "invalid_request", status: 400 });
    await expect(listDirectory(home, "~/missing")).rejects.toMatchObject({ code: "not_found", status: 404 });
    await expect(listDirectory(home, "/etc")).rejects.toMatchObject({ code: "forbidden", status: 403 });
  });
});
