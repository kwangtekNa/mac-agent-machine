import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SandboxError, resolveInsideHome } from "../../src/fs/sandbox.js";
import { makeTmpHome, removeTmp } from "../helpers/tmp-home.js";

let home: string;
let realHome: string;
let outside: string;

beforeAll(async () => {
  home = await makeTmpHome("mam-sb-");
  realHome = await realpath(home);
  outside = await makeTmpHome("mam-sb-outside-");
  await mkdir(join(home, "work", "app"), { recursive: true });
  await writeFile(join(home, "work", "a.txt"), "a");
  await writeFile(join(outside, "secret.txt"), "s");
  await symlink(outside, join(home, "escape-dir"));
  await symlink(join(outside, "secret.txt"), join(home, "escape-file"));
  await symlink(join(home, "work", "a.txt"), join(home, "inner-link"));
});

afterAll(async () => {
  await removeTmp(home);
  await removeTmp(outside);
});

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (err) {
    expect(err).toBeInstanceOf(SandboxError);
    return (err as SandboxError).code;
  }
}

describe("resolveInsideHome", () => {
  it("returns the realpath for paths inside home (/var → /private/var)", async () => {
    expect(tmpdir().startsWith("/var/")).toBe(true);
    expect(realHome.startsWith("/private/var/")).toBe(true);
    expect(await resolveInsideHome(home, join(home, "work"))).toBe(join(realHome, "work"));
    expect(await resolveInsideHome(realHome, join(home, "work"))).toBe(join(realHome, "work"));
    expect(await resolveInsideHome(home, join(realHome, "work", "app"))).toBe(join(realHome, "work", "app"));
  });

  it("resolves home itself and ~ / ~/ substitution", async () => {
    expect(await resolveInsideHome(home, home)).toBe(realHome);
    expect(await resolveInsideHome(home, "~")).toBe(realHome);
    expect(await resolveInsideHome(home, "~/")).toBe(realHome);
    expect(await resolveInsideHome(home, "~/work/a.txt")).toBe(join(realHome, "work", "a.txt"));
    expect(await resolveInsideHome(home, "work/app")).toBe(join(realHome, "work", "app"));
  });

  it("rejects .. escapes with forbidden", async () => {
    expect(await codeOf(resolveInsideHome(home, join(home, "..")))).toBe("forbidden");
    expect(await codeOf(resolveInsideHome(home, join(home, "work", "..", "..")))).toBe("forbidden");
    expect(await codeOf(resolveInsideHome(home, "~/../../etc/passwd"))).toBe("forbidden");
    expect(await codeOf(resolveInsideHome(home, "/etc/passwd"))).toBe("forbidden");
    expect(await codeOf(resolveInsideHome(home, "/"))).toBe("forbidden");
  });

  it("does not reveal existence outside home", async () => {
    expect(await codeOf(resolveInsideHome(home, "/definitely/not/here"))).toBe("forbidden");
    expect(await codeOf(resolveInsideHome(home, join(outside, "nope")))).toBe("forbidden");
  });

  it("rejects symlinks that point outside home", async () => {
    expect(await codeOf(resolveInsideHome(home, join(home, "escape-dir")))).toBe("forbidden");
    expect(await codeOf(resolveInsideHome(home, join(home, "escape-dir", "secret.txt")))).toBe("forbidden");
    expect(await codeOf(resolveInsideHome(home, join(home, "escape-dir", "new.txt")))).toBe("forbidden");
    expect(await codeOf(resolveInsideHome(home, "~/escape-file"))).toBe("forbidden");
  });

  it("follows symlinks that stay inside home", async () => {
    expect(await resolveInsideHome(home, "~/inner-link")).toBe(join(realHome, "work", "a.txt"));
  });

  it("supports a missing last segment but reports deeper missing paths as not_found", async () => {
    expect(await resolveInsideHome(home, "~/work/new-file.txt")).toBe(join(realHome, "work", "new-file.txt"));
    expect(await codeOf(resolveInsideHome(home, "~/missing/deeper"))).toBe("not_found");
    expect(await codeOf(resolveInsideHome(home, join(home, "missing", "a", "b")))).toBe("not_found");
  });

  it("exposes HTTP status through MamError", async () => {
    await expect(resolveInsideHome(home, "/etc")).rejects.toMatchObject({ code: "forbidden", status: 403 });
    await expect(resolveInsideHome(home, "~/x/y")).rejects.toMatchObject({ code: "not_found", status: 404 });
  });
});
