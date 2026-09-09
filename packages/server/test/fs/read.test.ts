import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FsError, readFileForClient } from "../../src/fs/read.js";
import { SandboxError } from "../../src/fs/sandbox.js";
import { makeTmpHome, removeTmp } from "../helpers/tmp-home.js";

const MIB = 1024 * 1024;
let home: string;
let realHome: string;

beforeAll(async () => {
  home = await makeTmpHome("mam-read-");
  realHome = await realpath(home);
  await mkdir(join(home, "proj"), { recursive: true });
  await writeFile(join(home, "proj", "index.ts"), "export const a = 1;\n");
  await writeFile(join(home, "proj", "empty.txt"), "");
  await writeFile(join(home, "proj", "big.txt"), Buffer.alloc(MIB + 10, 0x61));
  await writeFile(join(home, "proj", "multibyte.txt"), "가".repeat(400_000));
  await writeFile(join(home, "proj", "blob.bin"), Buffer.from([0x41, 0x42, 0x00, 0x43]));
  await writeFile(join(home, "proj", "late-nul.txt"), Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0])]));
  await writeFile(join(home, "proj", "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]));
  await writeFile(join(home, "proj", "icon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  await writeFile(join(home, "proj", "huge.jpg"), Buffer.alloc(5 * MIB + 1, 0xff));
});

afterAll(async () => {
  await removeTmp(home);
});

describe("readFileForClient", () => {
  it("returns utf8 text with metadata and language", async () => {
    const res = await readFileForClient(home, "~/proj/index.ts");
    expect(res).toMatchObject({
      path: join(realHome, "proj", "index.ts"),
      size: 20,
      isBinary: false,
      encoding: "utf8",
      content: "export const a = 1;\n",
      truncated: false,
      language: "typescript",
    });
    expect(new Date(res.mtime).toISOString()).toBe(res.mtime);
  });

  it("handles an empty file", async () => {
    const res = await readFileForClient(home, join(home, "proj", "empty.txt"));
    expect(res).toMatchObject({ size: 0, content: "", isBinary: false, truncated: false, language: "plaintext" });
  });

  it("truncates text to 1 MiB", async () => {
    const res = await readFileForClient(home, "~/proj/big.txt");
    expect(res.truncated).toBe(true);
    expect(res.size).toBe(MIB + 10);
    expect(res.content.length).toBe(MIB);
  });

  it("does not emit a broken multibyte character at the cut", async () => {
    const res = await readFileForClient(home, "~/proj/multibyte.txt");
    expect(res.truncated).toBe(true);
    expect(res.content).not.toContain("�");
    expect(res.content.length).toBe(Math.floor(MIB / 3));
    expect(Buffer.byteLength(res.content)).toBeLessThanOrEqual(MIB);
  });

  it("rejects non-image binaries with unsupported_media (415)", async () => {
    await expect(readFileForClient(home, "~/proj/blob.bin")).rejects.toMatchObject({ code: "unsupported_media", status: 415 });
    await expect(readFileForClient(home, "~/proj/blob.bin")).rejects.toBeInstanceOf(FsError);
  });

  it("only sniffs the first 8 KiB for NUL", async () => {
    const res = await readFileForClient(home, "~/proj/late-nul.txt");
    expect(res.isBinary).toBe(false);
    expect(res.size).toBe(9001);
  });

  it("returns images as base64", async () => {
    const res = await readFileForClient(home, "~/proj/pic.png");
    expect(res).toMatchObject({ isBinary: true, encoding: "base64", truncated: false, size: 10 });
    expect(Buffer.from(res.content, "base64")).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]));
  });

  it("treats svg as an image", async () => {
    const res = await readFileForClient(home, "~/proj/icon.svg");
    expect(res.encoding).toBe("base64");
    expect(res.isBinary).toBe(true);
    expect(Buffer.from(res.content, "base64").toString()).toContain("<svg");
  });

  it("rejects images over 5 MiB", async () => {
    await expect(readFileForClient(home, "~/proj/huge.jpg")).rejects.toMatchObject({ code: "unsupported_media", status: 415 });
  });

  it("rejects directories with invalid_request (400)", async () => {
    await expect(readFileForClient(home, "~/proj")).rejects.toMatchObject({ code: "invalid_request", status: 400 });
  });

  it("maps missing files to not_found and outside paths to forbidden", async () => {
    await expect(readFileForClient(home, "~/proj/nope.txt")).rejects.toMatchObject({ code: "not_found", status: 404 });
    await expect(readFileForClient(home, "~/nope/nope.txt")).rejects.toBeInstanceOf(SandboxError);
    await expect(readFileForClient(home, "/etc/hosts")).rejects.toMatchObject({ code: "forbidden", status: 403 });
  });
});
