import { open } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import type { FsReadResponse } from "@mam/protocol";
import { languageForPath } from "./language.js";
import { resolveInsideHome, statResolved } from "./sandbox.js";

export const TEXT_LIMIT_BYTES = 1024 * 1024;
export const IMAGE_LIMIT_BYTES = 5 * 1024 * 1024;
const SNIFF_BYTES = 8 * 1024;
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(["png", "jpg", "jpeg", "gif", "webp", "heic", "svg"]);

export type FsErrorCode = "unsupported_media" | "invalid_request";

/** 파일 API 오류. `unsupported_media` 는 프로토콜 오류 코드에 없으므로 라우트가 415 로 매핑한다. */
export class FsError extends Error {
  readonly code: FsErrorCode;
  readonly status: number;

  constructor(code: FsErrorCode, message: string) {
    super(message);
    this.name = "FsError";
    this.code = code;
    this.status = code === "unsupported_media" ? 415 : 400;
  }
}

export function isImagePath(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).slice(1).toLowerCase());
}

/** 파일 앞부분을 최대 `max` 바이트 읽는다. */
async function readPrefix(file: string, size: number, max: number): Promise<Buffer> {
  const handle = await open(file, "r");
  try {
    const buf = Buffer.allocUnsafe(Math.min(size, max));
    let offset = 0;
    while (offset < buf.length) {
      const { bytesRead } = await handle.read(buf, offset, buf.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buf.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

export async function readFileForClient(home: string, input: string): Promise<FsReadResponse> {
  const resolved = await resolveInsideHome(home, input);
  const st = await statResolved(resolved);
  if (st.isDirectory()) throw new FsError("invalid_request", "디렉토리는 읽을 수 없습니다");
  if (!st.isFile()) throw new FsError("invalid_request", "일반 파일이 아닙니다");

  const base = {
    path: resolved,
    size: st.size,
    mtime: st.mtime.toISOString(),
    language: languageForPath(resolved),
  };

  if (isImagePath(resolved)) {
    if (st.size > IMAGE_LIMIT_BYTES) throw new FsError("unsupported_media", "이미지가 5 MiB 를 넘습니다");
    const data = await readPrefix(resolved, st.size, IMAGE_LIMIT_BYTES);
    return { ...base, isBinary: true, encoding: "base64", content: data.toString("base64"), truncated: false };
  }

  const data = await readPrefix(resolved, st.size, TEXT_LIMIT_BYTES);
  if (data.subarray(0, SNIFF_BYTES).includes(0)) throw new FsError("unsupported_media", "바이너리 파일입니다");
  const truncated = st.size > TEXT_LIMIT_BYTES;
  // 잘린 경우 stream 디코딩으로 끝의 불완전한 멀티바이트 문자를 버린다.
  const content = truncated ? new TextDecoder("utf-8").decode(data, { stream: true }) : data.toString("utf8");
  return { ...base, isBinary: false, encoding: "utf8", content, truncated };
}
