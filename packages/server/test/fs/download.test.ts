import { mkdir, open, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  contentDispositionFor,
  contentTypeFor,
  DOWNLOAD_LIMIT_BYTES,
  openDownload,
} from "../../src/fs/download.js";
import { FsError } from "../../src/fs/read.js";
import { SandboxError } from "../../src/fs/sandbox.js";
import { makeTmpHome, removeTmp } from "../helpers/tmp-home.js";

let home: string;
let realHome: string;

const PDF_BYTES = Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "binary");

beforeAll(async () => {
  home = await makeTmpHome("mam-download-");
  realHome = await realpath(home);
  await mkdir(join(home, "docs"), { recursive: true });
  await writeFile(join(home, "docs", "보고서.pdf"), PDF_BYTES);
  await writeFile(join(home, "docs", "plain.txt"), "hello\n");
  // 희소 파일: 내용을 쓰지 않고 크기만 100 MiB + 1 로 키운다.
  const handle = await open(join(home, "docs", "huge.pdf"), "w");
  await handle.truncate(DOWNLOAD_LIMIT_BYTES + 1);
  await handle.close();
  const exact = await open(join(home, "docs", "exact.pdf"), "w");
  await exact.truncate(DOWNLOAD_LIMIT_BYTES);
  await exact.close();
});

afterAll(async () => {
  await removeTmp(home);
});

describe("contentTypeFor", () => {
  it("maps document extensions and falls back to octet-stream", () => {
    expect(contentTypeFor("a.pdf")).toBe("application/pdf");
    expect(contentTypeFor("/x/y/보고서.PDF")).toBe("application/pdf");
    expect(contentTypeFor("a.docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(contentTypeFor("a.xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(contentTypeFor("a.pptx")).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    expect(contentTypeFor("a.doc")).toBe("application/msword");
    expect(contentTypeFor("a.xls")).toBe("application/vnd.ms-excel");
    expect(contentTypeFor("a.ppt")).toBe("application/vnd.ms-powerpoint");
    expect(contentTypeFor("a.rtf")).toBe("application/rtf");
    expect(contentTypeFor("a.hwp")).toBe("application/x-hwp");
    expect(contentTypeFor("a.hwpx")).toBe("application/hwp+zip");
    expect(contentTypeFor("a.bin")).toBe("application/octet-stream");
    expect(contentTypeFor("noext")).toBe("application/octet-stream");
  });
});

describe("contentDispositionFor", () => {
  it("percent-encodes the file name as RFC 5987 filename*", () => {
    expect(contentDispositionFor("report.pdf")).toBe("inline; filename*=UTF-8''report.pdf");
    expect(contentDispositionFor("/Users/alice/docs/보고서.pdf")).toBe(
      `inline; filename*=UTF-8''${encodeURIComponent("보고서.pdf")}`,
    );
  });

  it("encodes characters that are not RFC 5987 attr-char", () => {
    const value = contentDispositionFor(`a b'c(d)e*f".pdf`);
    expect(value.startsWith("inline; filename*=UTF-8''")).toBe(true);
    const encoded = value.slice("inline; filename*=UTF-8''".length);
    expect(encoded).not.toMatch(/[ '()*"]/);
    expect(decodeURIComponent(encoded)).toBe(`a b'c(d)e*f".pdf`);
  });
});

describe("openDownload", () => {
  it("streams the exact bytes with type, size and disposition", async () => {
    const res = await openDownload(home, "~/docs/보고서.pdf");
    expect(res.size).toBe(PDF_BYTES.length);
    expect(res.contentType).toBe("application/pdf");
    expect(res.disposition).toBe(`inline; filename*=UTF-8''${encodeURIComponent("보고서.pdf")}`);
    const chunks: Buffer[] = [];
    for await (const chunk of res.stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks)).toEqual(PDF_BYTES);
  });

  it("serves unknown extensions as octet-stream", async () => {
    const res = await openDownload(home, join(realHome, "docs", "plain.txt"));
    expect(res.contentType).toBe("application/octet-stream");
    res.stream.destroy();
  });

  it("rejects files over 100 MiB with unsupported_media (415)", async () => {
    await expect(openDownload(home, "~/docs/huge.pdf")).rejects.toMatchObject({
      code: "unsupported_media",
      status: 415,
    });
    await expect(openDownload(home, "~/docs/huge.pdf")).rejects.toBeInstanceOf(FsError);
    await expect(openDownload(home, "~/docs/huge.pdf")).rejects.toThrow(
      "파일이 100 MiB 를 넘어 미리 볼 수 없습니다",
    );
  });

  it("allows a file of exactly 100 MiB", async () => {
    const res = await openDownload(home, "~/docs/exact.pdf");
    expect(res.size).toBe(DOWNLOAD_LIMIT_BYTES);
    res.stream.destroy();
  });

  it("rejects directories with invalid_request (400)", async () => {
    await expect(openDownload(home, "~/docs")).rejects.toMatchObject({
      code: "invalid_request",
      status: 400,
    });
  });

  it("maps missing files to not_found and outside paths to forbidden", async () => {
    await expect(openDownload(home, "~/docs/nope.pdf")).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
    await expect(openDownload(home, "~/docs/nope.pdf")).rejects.toBeInstanceOf(SandboxError);
    await expect(openDownload(home, "/etc/hosts")).rejects.toMatchObject({
      code: "forbidden",
      status: 403,
    });
  });
});
