import { spawn } from "node:child_process";
import { access, constants, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentUnavailableError, InternalError } from "../errors.js";
import type { RenderedHtml, RenderOptions } from "./render.js";

export const HWP_CONVERTER_MISSING_MESSAGE =
  "한글(HWP) 변환기가 없습니다. Mac 에서 `python3 -m pip install --user pyhwp` 를 실행하세요.";

const HWP5HTML_TIMEOUT_MS = 120_000;

/**
 * pyhwp 의 `hwp5html` 진입점. 모듈에 `__main__` 가드가 없어 `python3 -m hwp5.hwp5html` 로는
 * 아무 일도 일어나지 않으므로 console_script 와 같은 `hwp5.hwp5html:main` 을 직접 부른다.
 * 고정 문자열이며 사용자 입력이 섞이지 않는다(CRITICAL 4: 셸은 거치지 않는다).
 */
const PYTHON_ENTRY = "from hwp5.hwp5html import main; main()";

export interface Hwp5HtmlBin {
  bin: string;
  prefixArgs: string[];
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(bin: string, args: readonly string[], timeoutMs = HWP5HTML_TIMEOUT_MS): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, [...args], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        env: { ...process.env, LC_ALL: "C" },
      });
    } catch (err) {
      resolve({ code: null, stdout: "", stderr: err instanceof Error ? err.message : String(err) });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (e) => resolve({ code: null, stdout: "", stderr: e.message }));
    child.on("close", (code) =>
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }),
    );
  });
}

async function isExecutable(target: string): Promise<boolean> {
  try {
    await access(target, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 로그인 셸의 `command -v hwp5html`. 고정 명령이라 사용자 입력이 섞이지 않는다(CRITICAL 4 예외). */
async function fromLoginShell(): Promise<string | null> {
  const result = await run(process.env.SHELL ?? "/bin/zsh", ["-lc", "command -v hwp5html"], 5000);
  const first = result.stdout.split("\n")[0]?.trim() ?? "";
  return result.code === 0 && path.isAbsolute(first) && (await isExecutable(first)) ? first : null;
}

/**
 * 탐색 순서: `MAM_HWP5HTML_BIN` → 로그인 셸의 `command -v hwp5html` → `python3` 의 hwp5 모듈.
 * 환경변수가 있으면 그것만 쓴다(설정이 틀렸는데 다른 변환기가 조용히 뜨지 않도록).
 */
export async function resolveHwp5Html(env: NodeJS.ProcessEnv = process.env): Promise<Hwp5HtmlBin | null> {
  const override = env.MAM_HWP5HTML_BIN?.trim();
  if (override !== undefined && override !== "") {
    return (await isExecutable(override)) ? { bin: override, prefixArgs: [] } : null;
  }
  const found = await fromLoginShell();
  if (found !== null) return { bin: found, prefixArgs: [] };
  const probe = await run("python3", ["-c", "import hwp5.hwp5html"], 15_000);
  return probe.code === 0 ? { bin: "python3", prefixArgs: ["-c", PYTHON_ENTRY] } : null;
}

// ---------------------------------------------------------------- 산출물 합치기

const IMAGE_MIME: Readonly<Record<string, string | undefined>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  tif: "image/tiff",
  tiff: "image/tiff",
  svg: "image/svg+xml",
};

const BASE_CSS = `
.hwp{font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Helvetica Neue",sans-serif;font-size:16px;line-height:1.7;color:#1c1c1e;word-break:break-word;}
.hwp table{border-collapse:collapse;}
.hwp td,.hwp th{border:1px solid #c7c7cc;padding:6px 8px;vertical-align:top;}
.hwp img{max-width:100%;height:auto;}
@media (prefers-color-scheme:dark){.hwp{color:#f2f2f7;}.hwp td,.hwp th{border-color:#48484a;}}
`;

function firstLine(value: string): string {
  return value.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
}

function bodyOf(xhtml: string): string {
  const match = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(xhtml);
  if (match !== null) return match[1] ?? "";
  return xhtml
    .replace(/<head\b[\s\S]*?<\/head>/gi, "")
    .replace(/<\?xml[\s\S]*?\?>/gi, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "")
    .replace(/<\/?(?:html|body)\b[^>]*>/gi, "");
}

/** 폰 WKWebView 에서 열리므로 스크립트·인라인 핸들러·외부 리소스를 전부 뺀다. */
function sanitizeHtml(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<script\b[^>]*>/gi, "")
    .replace(/<iframe\b[\s\S]*?<\/iframe\s*>/gi, "")
    .replace(/<(?:link|base|meta)\b[^>]*>/gi, "")
    .replace(/\son[a-zA-Z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/g, "");
}

/** 인라인 뒤에도 남은 외부 참조는 통째로 지운다(자체 완결 HTML 보장). */
function dropExternalRefs(html: string): string {
  return html.replace(/\s(?:src|href)\s*=\s*(?:"[^"]*"|'[^']*')/gi, (match) =>
    /=\s*["'](?:data:|#)/i.test(match) ? match : "",
  );
}

function sanitizeCss(css: string): string {
  return css
    .replace(/<\/?style\b[^>]*>/gi, "")
    .replace(/@import[^;]*;/gi, "")
    .replace(/url\(\s*(['"]?)(?!data:)[^)]*\1\s*\)/gi, "none");
}

function dataUri(item: { mime: string; data: Buffer }): string {
  return `data:${item.mime};base64,${item.data.toString("base64")}`;
}

async function readBinData(dir: string): Promise<Map<string, { mime: string; data: Buffer }>> {
  const items = new Map<string, { mime: string; data: Buffer }>();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return items;
  }
  for (const name of names) {
    const mime = IMAGE_MIME[path.extname(name).slice(1).toLowerCase()];
    if (mime === undefined) continue;
    try {
      items.set(name.toLowerCase(), { mime, data: await readFile(path.join(dir, name)) });
    } catch {
      // 읽지 못한 항목은 아래 인라인 단계에서 경고가 된다.
    }
  }
  return items;
}

function inlineBinRefs(
  text: string,
  bin: Map<string, { mime: string; data: Buffer }>,
  warnings: Set<string>,
): string {
  return text.replace(/(?:\.\/)?bindata\/([A-Za-z0-9._%-]+)/gi, (_match, name: string) => {
    const item = bin.get(decodeURIComponent(name).toLowerCase());
    if (item === undefined) {
      warnings.add("이미지를 찾지 못해 건너뛴 그림이 있습니다");
      return "";
    }
    return dataUri(item);
  });
}

/** pyhwp 가 만든 `index.xhtml` + `styles.css` + `bindata/` 를 자체 완결 HTML 하나로 합친다. */
export async function inlineConverterOutput(outDir: string): Promise<RenderedHtml> {
  const warnings = new Set<string>();
  let xhtml: string;
  try {
    xhtml = await readFile(path.join(outDir, "index.xhtml"), "utf8");
  } catch {
    throw new InternalError("한글(HWP) 변환 결과를 찾지 못했습니다");
  }
  let css = "";
  try {
    css = await readFile(path.join(outDir, "styles.css"), "utf8");
  } catch {
    warnings.add("문서 스타일을 찾지 못해 기본 서식으로 보여 줍니다");
  }
  const bin = await readBinData(path.join(outDir, "bindata"));
  const body = dropExternalRefs(inlineBinRefs(sanitizeHtml(bodyOf(xhtml)), bin, warnings));
  const style = `<style>${sanitizeCss(inlineBinRefs(css, bin, warnings))}${BASE_CSS}</style>`;
  return { html: `<article class="hwp">${style}${body.trim()}</article>`, warnings: [...warnings] };
}

/**
 * HWP(5.x 바이너리)는 Mac 에 설치된 pyhwp 의 `hwp5html` 로 변환한다.
 * 변환기가 없으면 501(`agent_unavailable`), 변환 실패는 500 이고 stderr 첫 줄은 로그에만 남긴다(CRITICAL 6).
 */
export async function renderHwp(file: string, opts: RenderOptions = {}): Promise<RenderedHtml> {
  const tool = await resolveHwp5Html();
  if (tool === null) throw new AgentUnavailableError(HWP_CONVERTER_MISSING_MESSAGE);

  const outDir = await mkdtemp(path.join(tmpdir(), "mam-hwp5html-"));
  try {
    const result = await run(tool.bin, [...tool.prefixArgs, file, "--output", outDir]);
    if (result.code !== 0) {
      opts.logger?.warn(`hwp5html 실패(code ${result.code}): ${firstLine(result.stderr)}`);
      throw new InternalError("한글(HWP) 문서를 변환하지 못했습니다");
    }
    return await inlineConverterOutput(outDir);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}
