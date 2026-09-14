import path from "node:path";
import type { FsRenderResponse } from "@mam/protocol";
import { DOWNLOAD_LIMIT_BYTES, DOWNLOAD_TOO_LARGE_MESSAGE } from "./download.js";
import { FsError } from "./read.js";
import { renderHwp } from "./render-hwp.js";
import { renderHwpx } from "./render-hwpx.js";
import { resolveInsideHome, statResolved } from "./sandbox.js";

/** 변환 결과 HTML 상한. 넘으면 이미지를 빼고 경고에 적는다(폰이 한 번에 받아 그린다). */
export const HTML_LIMIT_BYTES = 8 * 1024 * 1024;

export const IMAGES_DROPPED_WARNING = "문서가 커서(HTML 8 MiB 초과) 이미지를 빼고 보여 줍니다";

export interface RenderedHtml {
  html: string;
  warnings: string[];
}

export interface RenderOptions {
  /** 변환기 stderr 같은 진단만 남긴다. 문서 내용은 절대 로그에 넣지 않는다(CRITICAL 6). */
  logger?: { warn(message: string): void };
}

const IMG_TAG = /<img\b[^>]*>/gi;
const DATA_URL = /url\(\s*(['"]?)data:[^)]*\1\s*\)/gi;

function withoutImages(html: string): string {
  return html.replace(IMG_TAG, "").replace(DATA_URL, "none");
}

/** 8 MiB 를 넘으면 이미지를 빼고 경고를 더한다. */
export function limitHtmlSize(rendered: RenderedHtml): RenderedHtml {
  if (Buffer.byteLength(rendered.html) <= HTML_LIMIT_BYTES) return rendered;
  return {
    html: withoutImages(rendered.html),
    warnings: [...rendered.warnings, IMAGES_DROPPED_WARNING],
  };
}

/**
 * `GET /fs/render`. 홈 안의 `.hwp`/`.hwpx` 를 자체 완결 HTML 로 바꾼다.
 * CRITICAL 3: 경로는 `resolveInsideHome` 을 거친 것만 쓴다.
 */
export async function renderDocument(home: string, inputPath: string, opts: RenderOptions = {}): Promise<FsRenderResponse> {
  const resolved = await resolveInsideHome(home, inputPath);
  const st = await statResolved(resolved);
  if (st.isDirectory()) throw new FsError("invalid_request", "디렉토리는 변환할 수 없습니다");
  if (!st.isFile()) throw new FsError("invalid_request", "일반 파일이 아닙니다");

  const ext = path.extname(resolved).slice(1).toLowerCase();
  if (ext !== "hwp" && ext !== "hwpx") {
    throw new FsError("invalid_request", "한글(HWP/HWPX) 문서만 변환할 수 있습니다");
  }
  if (st.size > DOWNLOAD_LIMIT_BYTES) throw new FsError("unsupported_media", DOWNLOAD_TOO_LARGE_MESSAGE);

  const rendered = ext === "hwp" ? await renderHwp(resolved, opts) : await renderHwpx(resolved);
  const limited = limitHtmlSize(rendered);
  return { path: resolved, kind: ext, html: limited.html, warnings: limited.warnings };
}
