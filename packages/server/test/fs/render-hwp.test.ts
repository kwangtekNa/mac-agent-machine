import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AgentUnavailableError } from "../../src/errors.js";
import { HWP_CONVERTER_MISSING_MESSAGE, renderHwp } from "../../src/fs/render-hwp.js";
import { makeTmpHome, removeTmp } from "../helpers/tmp-home.js";

let tmp: string;
let doc: string;
let fakeOk: string;
let fakeFail: string;
const saved = process.env.MAM_HWP5HTML_BIN;

/**
 * pyhwp 의 `hwp5html <file> --output <dir>` 를 흉내 내는 가짜 변환기.
 * 출력 디렉토리에 index.xhtml / styles.css / bindata/a.png 를 쓴다(실제 pyhwp 의 산출물 구조).
 */
const FAKE_OK = `#!/bin/sh
out=""
prev=""
for a in "$@"; do
  [ "$prev" = "--output" ] && out="$a"
  prev="$a"
done
[ -n "$out" ] || exit 2
mkdir -p "$out/bindata"
cat > "$out/index.xhtml" <<'XHTML'
<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<title>hwp5html</title>
<link rel="stylesheet" type="text/css" href="styles.css"/>
<script src="https://example.com/tracker.js"></script>
</head>
<body>
<div class="HeadingParaShape"><p class="p0" onclick="alert(1)">한글 본문 &amp; 표</p></div>
<img src="bindata/a.png" alt="그림"/>
<img src="bindata/missing.png" alt="없음"/>
</body>
</html>
XHTML
printf '%s' '@import url(https://fonts.example.com/x.css); .p0 { font-weight: bold; background-image: url(bindata/a.png); }' > "$out/styles.css"
printf '%s' 'PNGDATA' > "$out/bindata/a.png"
exit 0
`;

const FAKE_FAIL = `#!/bin/sh
echo "hwp5html: InvalidHwp5FileError: not a hwp5 file" >&2
echo "second line" >&2
exit 1
`;

async function writeScript(path: string, body: string): Promise<string> {
  await writeFile(path, body);
  await chmod(path, 0o755);
  return path;
}

beforeAll(async () => {
  tmp = await makeTmpHome("mam-hwp-");
  await mkdir(join(tmp, "docs"), { recursive: true });
  doc = join(tmp, "docs", "보고서.hwp");
  await writeFile(doc, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  fakeOk = await writeScript(join(tmp, "fake-hwp5html.sh"), FAKE_OK);
  fakeFail = await writeScript(join(tmp, "fake-hwp5html-fail.sh"), FAKE_FAIL);
});

afterEach(() => {
  if (saved === undefined) delete process.env.MAM_HWP5HTML_BIN;
  else process.env.MAM_HWP5HTML_BIN = saved;
});

afterAll(async () => {
  await removeTmp(tmp);
});

describe("renderHwp", () => {
  it("merges the converter output into one self-contained html", async () => {
    process.env.MAM_HWP5HTML_BIN = fakeOk;
    const { html, warnings } = await renderHwp(doc);
    expect(html.startsWith('<article class="hwp">')).toBe(true);
    expect(html.endsWith("</article>")).toBe(true);
    expect(html).toContain("한글 본문 &amp; 표");
    // styles.css 가 <style> 로 인라인되고 외부 스타일시트 링크는 사라진다
    expect(html).toContain("<style>");
    expect(html).toContain("font-weight: bold");
    expect(html).not.toContain("styles.css");
    expect(html).not.toContain("<link");
    // 이미지는 data URI
    expect(html).toContain(`data:image/png;base64,${Buffer.from("PNGDATA").toString("base64")}`);
    expect(html).not.toContain("bindata/a.png");
    // 스크립트·인라인 핸들러·외부 URL 은 전부 제거된다
    expect(html).not.toContain("<script");
    expect(html).not.toContain("tracker.js");
    expect(html).not.toContain("onclick");
    expect(html).not.toMatch(/https?:\/\//);
    // 못 찾은 그림은 경고로만 남는다
    expect(warnings.some((w) => w.includes("이미지"))).toBe(true);
  });

  it("is 501 agent_unavailable when the converter is configured but missing", async () => {
    process.env.MAM_HWP5HTML_BIN = join(tmp, "no-such-hwp5html");
    await expect(renderHwp(doc)).rejects.toBeInstanceOf(AgentUnavailableError);
    await expect(renderHwp(doc)).rejects.toMatchObject({ code: "agent_unavailable" });
    await expect(renderHwp(doc)).rejects.toThrow(HWP_CONVERTER_MISSING_MESSAGE);
    expect(HWP_CONVERTER_MISSING_MESSAGE).toContain("python3 -m pip install --user pyhwp");
  });

  it("maps a converter failure to internal (500) and logs only the first stderr line", async () => {
    process.env.MAM_HWP5HTML_BIN = fakeFail;
    const logged: string[] = [];
    await expect(renderHwp(doc, { logger: { warn: (m) => logged.push(m) } })).rejects.toMatchObject({
      code: "internal",
      status: 500,
    });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("InvalidHwp5FileError");
    expect(logged[0]).not.toContain("second line");
  });
});
