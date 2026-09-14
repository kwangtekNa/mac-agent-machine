import { createReadStream, type ReadStream } from "node:fs";
import path from "node:path";
import { FsError } from "./read.js";
import { resolveInsideHome, statResolved } from "./sandbox.js";

/** 원본 내려받기·문서 변환의 크기 상한. 넘으면 415 `unsupported_media`. */
export const DOWNLOAD_LIMIT_BYTES = 100 * 1024 * 1024;

export const DOWNLOAD_TOO_LARGE_MESSAGE = "파일이 100 MiB 를 넘어 미리 볼 수 없습니다";

export const DEFAULT_CONTENT_TYPE = "application/octet-stream";

/** 확장자 → MIME. 폰이 QuickLook 으로 여는 문서 형식만 이름을 붙이고 나머지는 octet-stream 이다. */
const CONTENT_TYPES: Readonly<Record<string, string | undefined>> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint",
  rtf: "application/rtf",
  hwp: "application/x-hwp",
  hwpx: "application/hwp+zip",
};

export function contentTypeFor(fileName: string): string {
  return CONTENT_TYPES[path.extname(fileName).slice(1).toLowerCase()] ?? DEFAULT_CONTENT_TYPE;
}

/**
 * RFC 5987 `filename*`. `encodeURIComponent` 가 남기는 `'()*` 까지 퍼센트 인코딩해
 * attr-char 만 남긴다(한글 파일명은 전부 인코딩된다).
 */
export function contentDispositionFor(fileName: string): string {
  const encoded = encodeURIComponent(path.basename(fileName)).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `inline; filename*=UTF-8''${encoded}`;
}

export interface DownloadHandle {
  stream: ReadStream;
  size: number;
  contentType: string;
  disposition: string;
}

/**
 * CRITICAL 3: `resolveInsideHome` 으로 홈 안인지 확인한 경로만 연다.
 * 디렉토리 400, 없음 404(SandboxError), 100 MiB 초과 415.
 */
export async function openDownload(home: string, inputPath: string): Promise<DownloadHandle> {
  const resolved = await resolveInsideHome(home, inputPath);
  const st = await statResolved(resolved);
  if (st.isDirectory()) throw new FsError("invalid_request", "디렉토리는 내려받을 수 없습니다");
  if (!st.isFile()) throw new FsError("invalid_request", "일반 파일이 아닙니다");
  if (st.size > DOWNLOAD_LIMIT_BYTES) throw new FsError("unsupported_media", DOWNLOAD_TOO_LARGE_MESSAGE);
  return {
    stream: createReadStream(resolved),
    size: st.size,
    contentType: contentTypeFor(resolved),
    disposition: contentDispositionFor(resolved),
  };
}
