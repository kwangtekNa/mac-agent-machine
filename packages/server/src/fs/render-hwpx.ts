import { spawn } from "node:child_process";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import { InternalError } from "../errors.js";
import type { RenderedHtml } from "./render.js";

const UNZIP_TIMEOUT_MS = 30_000;

/** HWPX 는 zip + OWPML XML 이다. zip 라이브러리를 넣지 않고 `unzip` CLI 만 인자 배열로 쓴다(CRITICAL 4). */
function runUnzip(args: readonly string[]): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("unzip", [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: UNZIP_TIMEOUT_MS,
      killSignal: "SIGKILL",
      env: { ...process.env, LC_ALL: "C" },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (e) => reject(new InternalError(`unzip 실행 실패: ${e.message}`)));
    child.on("close", (code, signal) => {
      if (signal !== null) {
        reject(new InternalError(`unzip 이 ${signal} 로 종료되었습니다 (타임아웃 ${UNZIP_TIMEOUT_MS}ms)`));
        return;
      }
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") });
    });
  });
}

/** `unzip -p` 는 항목 이름을 와일드카드 패턴으로 본다. 메타문자를 백슬래시로 막아 정확히 그 항목만 꺼낸다. */
function literalEntry(entry: string): string {
  return entry.replace(/([*?[\]\\])/g, "\\$1");
}

async function listEntries(file: string): Promise<string[]> {
  const { code, stdout } = await runUnzip(["-Z1", file]);
  if (code !== 0) throw new InternalError("HWPX 압축을 열지 못했습니다");
  return stdout
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.endsWith("/"));
}

async function readEntry(file: string, entry: string): Promise<Buffer> {
  const { code, stdout } = await runUnzip(["-p", file, literalEntry(entry)]);
  if (code !== 0) throw new InternalError(`HWPX 항목을 읽지 못했습니다: ${entry}`);
  return stdout;
}

// ---------------------------------------------------------------- XML 훑기

const ATTRS = ":@";
const TEXT = "#text";

type XNode = Record<string, unknown>;

/** 문서 순서를 지키려고 `preserveOrder` 를 쓴다(`[{ "p": [...], ":@": {...} }]`). 숫자 변환은 끈다. */
const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
});

function nodeName(node: XNode): string {
  for (const key of Object.keys(node)) {
    if (key !== ATTRS) return key;
  }
  return "";
}

function childrenOf(node: XNode): XNode[] {
  const value = node[nodeName(node)];
  return Array.isArray(value) ? (value as XNode[]) : [];
}

function attr(node: XNode, name: string): string | undefined {
  const bag = node[ATTRS] as Record<string, unknown> | undefined;
  const value = bag?.[`@_${name}`];
  return value === undefined ? undefined : String(value);
}

function textOf(node: XNode): string {
  const value = node[TEXT];
  return typeof value === "string" ? value : "";
}

/** 문서 순서대로 모든 요소를 낸다(텍스트 노드와 `?xml` 같은 선언은 건너뛴다). */
function* walk(nodes: readonly XNode[]): Generator<XNode> {
  for (const node of nodes) {
    const name = nodeName(node);
    if (name === "" || name === TEXT || name.startsWith("?") || name.startsWith("!")) continue;
    yield node;
    yield* walk(childrenOf(node));
  }
}

function findAll(nodes: readonly XNode[], name: string): XNode[] {
  const found: XNode[] = [];
  for (const node of walk(nodes)) {
    if (nodeName(node) === name) found.push(node);
  }
  return found;
}

function firstChild(node: XNode, name: string): XNode | undefined {
  return childrenOf(node).find((child) => nodeName(child) === name);
}

// ---------------------------------------------------------------- header.xml

interface CharProps {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  height: number | null;
}

interface HeaderInfo {
  charPr: Map<string, CharProps>;
  align: Map<string, string>;
  styleName: Map<string, string>;
  baseHeight: number | null;
}

const ALIGNMENTS: Readonly<Record<string, string | undefined>> = {
  CENTER: "center",
  RIGHT: "right",
  JUSTIFY: "justify",
  DISTRIBUTE: "justify",
};

const EMPTY_HEADER: HeaderInfo = {
  charPr: new Map(),
  align: new Map(),
  styleName: new Map(),
  baseHeight: null,
};

function parseHeader(xml: string): HeaderInfo {
  const doc = parser.parse(xml) as XNode[];
  const charPr = new Map<string, CharProps>();
  const heights = new Map<number, number>();
  for (const node of findAll(doc, "charPr")) {
    const id = attr(node, "id");
    if (id === undefined) continue;
    const raw = attr(node, "height");
    const height = raw === undefined ? null : Number.parseInt(raw, 10);
    const valid = height !== null && Number.isFinite(height) && height > 0 ? height : null;
    if (valid !== null) heights.set(valid, (heights.get(valid) ?? 0) + 1);
    charPr.set(id, {
      bold: firstChild(node, "bold") !== undefined,
      italic: firstChild(node, "italic") !== undefined,
      underline: firstChild(node, "underline") !== undefined,
      height: valid,
    });
  }
  const align = new Map<string, string>();
  for (const node of findAll(doc, "paraPr")) {
    const id = attr(node, "id");
    if (id === undefined) continue;
    const horizontal = findAll([node], "align")[0];
    const css = horizontal ? ALIGNMENTS[(attr(horizontal, "horizontal") ?? "").toUpperCase()] : undefined;
    if (css) align.set(id, css);
  }
  const styleName = new Map<string, string>();
  for (const node of findAll(doc, "style")) {
    const id = attr(node, "id");
    const name = attr(node, "name") ?? attr(node, "engName");
    if (id !== undefined && name !== undefined) styleName.set(id, name);
  }
  // 본문 글자 크기 = 가장 흔한 charPr height. 이보다 충분히 큰 글자만 크게 그린다.
  let baseHeight: number | null = null;
  let best = 0;
  for (const [height, count] of heights) {
    if (count > best || (count === best && baseHeight !== null && height < baseHeight)) {
      baseHeight = height;
      best = count;
    }
  }
  return { charPr, align, styleName, baseHeight };
}

// ---------------------------------------------------------------- BinData

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

interface BinItem {
  mime: string;
  data: Buffer;
}

/** `Contents/content.hpf` 매니페스트의 `id → BinData/<파일>` 와 파일 이름 양쪽으로 그림을 찾는다. */
function manifestHrefs(xml: string): Map<string, string> {
  const map = new Map<string, string>();
  const doc = parser.parse(xml) as XNode[];
  for (const node of findAll(doc, "item")) {
    const id = attr(node, "id");
    const href = attr(node, "href");
    if (id !== undefined && href !== undefined) map.set(id, href.replace(/^\.\//, ""));
  }
  return map;
}

async function loadBinData(file: string, entries: readonly string[]): Promise<Map<string, BinItem>> {
  const binEntries = entries.filter((entry) => entry.toLowerCase().startsWith("bindata/"));
  if (binEntries.length === 0) return new Map();

  const manifest = entries.find((entry) => entry.toLowerCase() === "contents/content.hpf");
  const hrefs = manifest ? manifestHrefs((await readEntry(file, manifest)).toString("utf8")) : new Map<string, string>();
  const byEntry = new Map<string, BinItem>();
  const items = new Map<string, BinItem>();

  for (const entry of binEntries) {
    const base = path.basename(entry);
    const ext = path.extname(base).slice(1).toLowerCase();
    const mime = IMAGE_MIME[ext];
    if (mime === undefined) continue; // 그림이 아닌 첨부는 HTML 에 넣지 않는다
    const item: BinItem = { mime, data: await readEntry(file, entry) };
    byEntry.set(entry.toLowerCase(), item);
    items.set(base.toLowerCase(), item);
    items.set(base.slice(0, base.length - (ext.length ? ext.length + 1 : 0)).toLowerCase(), item);
  }
  for (const [id, href] of hrefs) {
    const item = byEntry.get(href.toLowerCase());
    if (item) items.set(id.toLowerCase(), item);
  }
  return items;
}

// ---------------------------------------------------------------- HTML 만들기

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 구조만 담당해 조용히 지나가는 요소들. 여기에도 없고 라벨도 없으면 경고를 남긴다. */
const SILENT_ELEMENTS: ReadonlySet<string> = new Set([
  "sec", "p", "run", "t", "lineBreak", "tab", "hyphen", "nbSpace", "fwSpace",
  "tbl", "tr", "tc", "subList", "cellAddr", "cellSpan", "cellSz", "cellMargin",
  "pic", "img", "imgRect", "imgClip", "inMargin", "outMargin", "sz", "pos", "offset",
  "orgSz", "curSz", "flip", "rotationInfo", "renderingInfo", "matrix", "scaMatrix",
  "rotMatrix", "transMatrix", "lineShape", "fillBrush", "shadow", "effects",
  "secPr", "grid", "startNum", "visibility", "lineNumberShape", "pagePr", "margin",
  "footNotePr", "endNotePr", "pageBorderFill", "masterPage", "ctrl", "colPr",
  "linesegarray", "lineseg", "tabPr", "numbering", "bullet", "switch", "case", "default",
  "fieldBegin", "fieldEnd", "markpenBegin", "markpenEnd", "titleMark", "autoNum", "newNum",
  "pageNum", "pageHiding", "pageNumCtrl", "indexmark", "bookmark", "header", "footer",
  "parameterset", "parameteritem", "parameterarray", "charPr", "paraPr", "noteLine",
  "noteSpacing", "numFormat", "placement", "beginNum", "autoSpacing", "ratio", "drawText",
  "shapeComment", "shapeObject", "colSz", "script",
]);

/** 변환하지 않는 내용 요소의 사람이 읽는 이름. 경고에 이 이름을 1회만 적는다. */
const UNSUPPORTED_LABELS: Readonly<Record<string, string>> = {
  equation: "수식",
  chart: "차트",
  ole: "OLE 개체",
  video: "동영상",
  textart: "글맵시",
  container: "묶음 개체",
  rect: "도형(사각형)",
  ellipse: "도형(타원)",
  line: "도형(선)",
  arc: "도형(호)",
  polygon: "도형(다각형)",
  curve: "도형(곡선)",
  connectLine: "도형(연결선)",
  footnote: "각주",
  endnote: "미주",
  formObject: "양식 개체",
};

const STYLE = `<style>
.hwpx{font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Helvetica Neue",sans-serif;font-size:16px;line-height:1.7;color:#1c1c1e;word-break:break-word;}
.hwpx p{margin:0 0 0.6em;}
.hwpx h2{font-size:1.5em;margin:1.2em 0 0.5em;}
.hwpx h3{font-size:1.2em;margin:1em 0 0.4em;}
.hwpx table{border-collapse:collapse;width:100%;margin:0.8em 0;}
.hwpx td{border:1px solid #c7c7cc;padding:6px 8px;vertical-align:top;}
.hwpx img{max-width:100%;height:auto;}
@media (prefers-color-scheme:dark){.hwpx{color:#f2f2f7;}.hwpx td{border-color:#48484a;}}
</style>`;

interface Ctx {
  header: HeaderInfo;
  bin: Map<string, BinItem>;
  warnings: Set<string>;
}

function warnUnsupported(ctx: Ctx, name: string): void {
  ctx.warnings.add(`변환하지 않은 요소: ${UNSUPPORTED_LABELS[name] ?? name}`);
}

function headingLevel(styleName: string | undefined): 2 | 3 | null {
  if (styleName === undefined) return null;
  const name = styleName.trim();
  if (!/제목|개요|heading/i.test(name)) return null;
  return /(^|[^0-9])1\s*$/.test(name) ? 2 : 3;
}

function runOpenClose(ctx: Ctx, charPrIDRef: string | undefined): { open: string; close: string } {
  const props = charPrIDRef === undefined ? undefined : ctx.header.charPr.get(charPrIDRef);
  if (props === undefined) return { open: "", close: "" };
  const open: string[] = [];
  const close: string[] = [];
  const base = ctx.header.baseHeight;
  if (base !== null && props.height !== null && props.height >= base * 1.25) {
    const em = Math.min(3, Math.round((props.height / base) * 100) / 100);
    open.push(`<span style="font-size:${em}em">`);
    close.unshift("</span>");
  }
  if (props.bold) {
    open.push("<b>");
    close.unshift("</b>");
  }
  if (props.italic) {
    open.push("<i>");
    close.unshift("</i>");
  }
  if (props.underline) {
    open.push("<u>");
    close.unshift("</u>");
  }
  return { open: open.join(""), close: close.join("") };
}

function renderPicture(node: XNode, ctx: Ctx): string {
  const img = findAll([node], "img")[0];
  const id = img === undefined ? undefined : attr(img, "binaryItemIDRef");
  const item = id === undefined ? undefined : ctx.bin.get(id.toLowerCase());
  if (item === undefined) {
    ctx.warnings.add("이미지를 찾지 못해 건너뛴 그림이 있습니다");
    return "";
  }
  return `<img src="data:${item.mime};base64,${item.data.toString("base64")}" alt="">`;
}

function renderTable(node: XNode, ctx: Ctx): string {
  const rows: string[] = [];
  for (const tr of childrenOf(node).filter((child) => nodeName(child) === "tr")) {
    const cells: string[] = [];
    for (const tc of childrenOf(tr).filter((child) => nodeName(child) === "tc")) {
      const span = firstChild(tc, "cellSpan");
      const colSpan = (span && attr(span, "colSpan")) ?? attr(tc, "colSpan") ?? "1";
      const rowSpan = (span && attr(span, "rowSpan")) ?? attr(tc, "rowSpan") ?? "1";
      const attrs =
        (colSpan !== "1" ? ` colspan="${escapeHtml(colSpan)}"` : "") +
        (rowSpan !== "1" ? ` rowspan="${escapeHtml(rowSpan)}"` : "");
      const content = childrenOf(tc)
        .filter((child) => nodeName(child) === "subList")
        .flatMap((subList) => childrenOf(subList).filter((child) => nodeName(child) === "p"))
        .map((paragraph) => renderParagraph(paragraph, ctx))
        .join("");
      cells.push(`<td${attrs}>${content}</td>`);
    }
    if (cells.length > 0) rows.push(`<tr>${cells.join("")}</tr>`);
  }
  return rows.length === 0 ? "" : `<table>${rows.join("")}</table>`;
}

interface Sink {
  inline: string[];
  blocks: string[];
  flush(): void;
}

function renderNode(node: XNode, ctx: Ctx, sink: Sink, inText: boolean): void {
  const name = nodeName(node);
  if (name === TEXT) {
    const raw = textOf(node);
    // 요소 사이의 들여쓰기 공백은 버리고, hp:t 안의 공백은 그대로 둔다.
    if (!inText && raw.trim() === "") return;
    sink.inline.push(escapeHtml(raw));
    return;
  }
  if (name === "" || name.startsWith("?") || name.startsWith("!")) return;

  switch (name) {
    case "lineBreak":
      sink.inline.push("<br>");
      return;
    case "tab":
      sink.inline.push("&emsp;");
      return;
    case "nbSpace":
    case "fwSpace":
      sink.inline.push("&nbsp;");
      return;
    case "tbl": {
      sink.flush();
      const table = renderTable(node, ctx);
      if (table !== "") sink.blocks.push(table);
      return;
    }
    case "pic":
      sink.inline.push(renderPicture(node, ctx));
      return;
    case "run": {
      const { open, close } = runOpenClose(ctx, attr(node, "charPrIDRef"));
      if (open !== "") sink.inline.push(open);
      for (const child of childrenOf(node)) renderNode(child, ctx, sink, inText);
      if (close !== "") sink.inline.push(close);
      return;
    }
    case "t":
      for (const child of childrenOf(node)) renderNode(child, ctx, sink, true);
      return;
    case "p": {
      // 중첩 문단(각주·도형 안 등)은 블록으로 올린다.
      sink.flush();
      sink.blocks.push(renderParagraph(node, ctx));
      return;
    }
    default:
      if (!SILENT_ELEMENTS.has(name)) warnUnsupported(ctx, name);
      for (const child of childrenOf(node)) renderNode(child, ctx, sink, inText);
  }
}

function renderParagraph(node: XNode, ctx: Ctx): string {
  const align = ctx.header.align.get(attr(node, "paraPrIDRef") ?? "") ?? ALIGNMENTS[(attr(node, "align") ?? "").toUpperCase()];
  const level = headingLevel(ctx.header.styleName.get(attr(node, "styleIDRef") ?? ""));
  const tag = level === null ? "p" : `h${level}`;
  const style = align === undefined ? "" : ` style="text-align:${align}"`;

  const blocks: string[] = [];
  const inline: string[] = [];
  const sink: Sink = {
    inline,
    blocks,
    flush() {
      const html = inline.join("");
      inline.length = 0;
      if (html.trim() === "") return;
      blocks.push(`<${tag}${style}>${html}</${tag}>`);
    },
  };
  for (const child of childrenOf(node)) renderNode(child, ctx, sink, false);
  sink.flush();
  // 빈 문단은 원문의 빈 줄이므로 자리를 남긴다.
  return blocks.length === 0 ? `<${tag}${style}></${tag}>` : blocks.join("");
}

const SECTION_RE = /^contents\/section(\d+)\.xml$/;

function sectionEntries(entries: readonly string[]): string[] {
  return entries
    .map((entry) => ({ entry, match: SECTION_RE.exec(entry.toLowerCase()) }))
    .filter((it): it is { entry: string; match: RegExpExecArray } => it.match !== null)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]))
    .map((it) => it.entry);
}

/**
 * HWPX(zip + OWPML)를 서버가 직접 자체 완결 HTML 로 바꾼다.
 * 완벽한 레이아웃은 목표가 아니고 문단·줄바꿈·표·그림·기본 서식까지다.
 * 스크립트와 외부 리소스는 절대 넣지 않으며 본문 텍스트는 전부 이스케이프한다.
 */
export async function renderHwpx(file: string): Promise<RenderedHtml> {
  const entries = await listEntries(file);
  const sections = sectionEntries(entries);
  if (sections.length === 0) throw new InternalError("HWPX 문서에서 본문(Contents/section*.xml)을 찾지 못했습니다");

  const headerEntry = entries.find((entry) => entry.toLowerCase() === "contents/header.xml");
  const ctx: Ctx = {
    header: headerEntry ? parseHeader((await readEntry(file, headerEntry)).toString("utf8")) : EMPTY_HEADER,
    bin: await loadBinData(file, entries),
    warnings: new Set<string>(),
  };

  const blocks: string[] = [];
  for (const entry of sections) {
    const doc = parser.parse((await readEntry(file, entry)).toString("utf8")) as XNode[];
    const sec = findAll(doc, "sec")[0];
    const roots = sec === undefined ? doc : childrenOf(sec);
    const inline: string[] = [];
    const sink: Sink = {
      inline,
      blocks,
      flush() {
        const html = inline.join("");
        inline.length = 0;
        if (html.trim() !== "") blocks.push(`<p>${html}</p>`);
      },
    };
    for (const node of roots) renderNode(node, ctx, sink, false);
    sink.flush();
  }

  return { html: `<article class="hwpx">${STYLE}${blocks.join("")}</article>`, warnings: [...ctx.warnings] };
}
