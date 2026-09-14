import { execFile } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderHwpx } from "../../src/fs/render-hwpx.js";
import { renderDocument } from "../../src/fs/render.js";
import { makeTmpHome, removeTmp } from "../helpers/tmp-home.js";

const execFileAsync = promisify(execFile);

/** 1×1 투명 PNG. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

const HEADER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head">
  <hh:refList>
    <hh:charProperties itemCnt="3">
      <hh:charPr id="0" height="1000"/>
      <hh:charPr id="1" height="1000"><hh:bold/><hh:italic/></hh:charPr>
      <hh:charPr id="2" height="1000"><hh:underline type="BOTTOM"/></hh:charPr>
    </hh:charProperties>
    <hh:paraProperties itemCnt="2">
      <hh:paraPr id="0"><hh:align horizontal="LEFT" vertical="BASELINE"/></hh:paraPr>
      <hh:paraPr id="1"><hh:align horizontal="CENTER" vertical="BASELINE"/></hh:paraPr>
    </hh:paraProperties>
    <hh:styles itemCnt="2">
      <hh:style id="0" type="PARA" name="바탕글" engName="Normal"/>
      <hh:style id="1" type="PARA" name="제목 1" engName="Heading 1"/>
    </hh:styles>
  </hh:refList>
</hh:head>
`;

function sectionXml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">
${body}
</hs:sec>
`;
}

const SECTION_XML = sectionXml(`
  <hp:p paraPrIDRef="0" styleIDRef="0">
    <hp:run charPrIDRef="0"><hp:t>첫 문단 &lt;script&gt;alert(1)&lt;/script&gt; &amp; "인용"</hp:t></hp:run>
  </hp:p>
  <hp:p paraPrIDRef="1" styleIDRef="1">
    <hp:run charPrIDRef="1"><hp:t>굵은 제목</hp:t></hp:run>
  </hp:p>
  <hp:p paraPrIDRef="0" styleIDRef="0">
    <hp:run charPrIDRef="2"><hp:t>앞<hp:lineBreak/>뒤</hp:t></hp:run>
  </hp:p>
  <hp:p paraPrIDRef="0" styleIDRef="0">
    <hp:run charPrIDRef="0">
      <hp:tbl rowCnt="2" colCnt="2">
        <hp:tr>
          <hp:tc><hp:cellSpan colSpan="2" rowSpan="1"/><hp:subList><hp:p><hp:run charPrIDRef="0"><hp:t>머리 셀</hp:t></hp:run></hp:p></hp:subList></hp:tc>
        </hp:tr>
        <hp:tr>
          <hp:tc><hp:cellSpan colSpan="1" rowSpan="1"/><hp:subList><hp:p><hp:run charPrIDRef="0"><hp:t>셀1</hp:t></hp:run></hp:p></hp:subList></hp:tc>
          <hp:tc><hp:cellSpan colSpan="1" rowSpan="1"/><hp:subList><hp:p><hp:run charPrIDRef="0"><hp:t>셀2</hp:t></hp:run></hp:p></hp:subList></hp:tc>
        </hp:tr>
      </hp:tbl>
    </hp:run>
  </hp:p>
  <hp:p paraPrIDRef="0" styleIDRef="0">
    <hp:run charPrIDRef="0"><hp:pic><hp:img binaryItemIDRef="image1"/></hp:pic></hp:run>
  </hp:p>
  <hp:p paraPrIDRef="0" styleIDRef="0">
    <hp:run charPrIDRef="0"><hp:equation><hp:script>E=mc^2</hp:script></hp:equation></hp:run>
  </hp:p>
`);

const MANIFEST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<opf:package xmlns:opf="http://www.idpf.org/2007/opf/">
  <opf:manifest>
    <opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>
    <opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/>
    <opf:item id="image1" href="BinData/image1.png" media-type="image/png"/>
  </opf:manifest>
</opf:package>
`;

let tmp: string;
let realTmp: string;
let sample: string;

/** `zip` CLI 로 최소 HWPX(zip + OWPML)를 만든다. 셸을 거치지 않고 인자 배열만 쓴다. */
async function makeHwpx(name: string, files: Record<string, string | Buffer>): Promise<string> {
  const src = join(tmp, `${name}-src`);
  for (const [rel, content] of Object.entries(files)) {
    const target = join(src, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const out = join(tmp, `${name}.hwpx`);
  await execFileAsync("zip", ["-q", "-r", "-X", out, ...Object.keys(files)], { cwd: src });
  return out;
}

function baseFiles(section = SECTION_XML, image: Buffer = PNG_1X1): Record<string, string | Buffer> {
  return {
    mimetype: "application/hwp+zip",
    "Contents/content.hpf": MANIFEST_XML,
    "Contents/header.xml": HEADER_XML,
    "Contents/section0.xml": section,
    "BinData/image1.png": image,
  };
}

beforeAll(async () => {
  tmp = await makeTmpHome("mam-hwpx-");
  realTmp = await realpath(tmp);
  sample = await makeHwpx("sample", baseFiles());
});

afterAll(async () => {
  await removeTmp(tmp);
});

describe("renderHwpx", () => {
  it("maps paragraphs, line breaks, tables, formatting and images", async () => {
    const { html } = await renderHwpx(sample);
    expect(html.startsWith('<article class="hwpx">')).toBe(true);
    expect(html.endsWith("</article>")).toBe(true);
    expect(html).toContain("<p");
    expect(html).toContain("첫 문단");
    expect(html).toContain("<br>");
    expect(html).toContain("앞<br>뒤");
    expect(html).toContain("<table>");
    expect(html).toContain('<td colspan="2">');
    expect(html).toContain("머리 셀");
    expect(html).toContain("셀2");
    expect(html).toContain("<b>");
    expect(html).toContain("<i>");
    expect(html).toContain("<u>");
    expect(html).toContain("<h2");
    expect(html).toContain("굵은 제목");
    expect(html).toContain("text-align:center");
    expect(html).toContain(`data:image/png;base64,${PNG_1X1.toString("base64")}`);
  });

  it("escapes text and never emits scripts or external resources", async () => {
    const { html } = await renderHwpx(sample);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;인용&quot;");
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/\ssrc="(?!data:)/);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain("<link");
  });

  it("keeps the text of unknown elements and records the kind once", async () => {
    const { html, warnings } = await renderHwpx(sample);
    expect(html).toContain("E=mc^2");
    expect(warnings).toContain("변환하지 않은 요소: 수식");
    expect(warnings.filter((w) => w.includes("수식"))).toHaveLength(1);
  });

  it("includes inline CSS only (no external stylesheet)", async () => {
    const { html } = await renderHwpx(sample);
    expect(html).toContain("<style>");
    expect(html).toContain("max-width:100%");
  });

  it("renders every section in order", async () => {
    const two = await makeHwpx("two-sections", {
      ...baseFiles(),
      "Contents/section1.xml": sectionXml(
        `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>두 번째 구역</hp:t></hp:run></hp:p>`,
      ),
    });
    const { html } = await renderHwpx(two);
    expect(html.indexOf("첫 문단")).toBeLessThan(html.indexOf("두 번째 구역"));
  });

  it("warns about a missing binary item instead of failing", async () => {
    const missing = await makeHwpx("missing-image", {
      mimetype: "application/hwp+zip",
      "Contents/header.xml": HEADER_XML,
      "Contents/section0.xml": sectionXml(
        `<hp:p><hp:run charPrIDRef="0"><hp:pic><hp:img binaryItemIDRef="nope"/></hp:pic></hp:run></hp:p>`,
      ),
    });
    const { html, warnings } = await renderHwpx(missing);
    expect(html).not.toContain("<img");
    expect(warnings.some((w) => w.includes("이미지"))).toBe(true);
  });
});

describe("renderDocument size guard", () => {
  it("drops images and warns when the html is over 8 MiB", async () => {
    const big = await makeHwpx("big-image", baseFiles(SECTION_XML, Buffer.alloc(7 * 1024 * 1024, 0)));
    const res = await renderDocument(tmp, big);
    expect(res.kind).toBe("hwpx");
    expect(res.html).not.toContain("data:image");
    expect(res.html).not.toContain("<img");
    expect(res.html).toContain("첫 문단");
    expect(Buffer.byteLength(res.html)).toBeLessThan(8 * 1024 * 1024);
    expect(res.warnings.some((w) => w.includes("8 MiB"))).toBe(true);
  });

  it("keeps images when the html is small", async () => {
    const res = await renderDocument(tmp, sample);
    expect(res.path).toBe(join(realTmp, "sample.hwpx"));
    expect(res.html).toContain("data:image/png;base64,");
    expect(res.warnings.some((w) => w.includes("8 MiB"))).toBe(false);
  });

  it("rejects a non-document extension with invalid_request (400)", async () => {
    const txt = join(tmp, "note.txt");
    await writeFile(txt, "hello\n");
    await expect(renderDocument(tmp, txt)).rejects.toMatchObject({ code: "invalid_request", status: 400 });
  });

  it("maps missing files to not_found and outside paths to forbidden", async () => {
    await expect(renderDocument(tmp, "~/nope.hwpx")).rejects.toMatchObject({ code: "not_found", status: 404 });
    await expect(renderDocument(tmp, "/etc/hosts")).rejects.toMatchObject({ code: "forbidden", status: 403 });
  });
});
