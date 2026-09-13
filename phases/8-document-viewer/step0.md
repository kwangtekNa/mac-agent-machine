# Step 0: fs-download-render-server

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md` (CRITICAL 3, 4, 5, 6)
- `/docs/PROTOCOL.md` 0절(오류 코드 목록), 1절 `GET /fs/read`(utf8/base64, 415 규칙)·`GET /fs/list`, 표기 관례
- `/packages/protocol/src/rest.ts` (`FsReadResponseSchema`, `ErrorCodeSchema`), `common.ts`, `index.ts`, `/packages/protocol/test/fixtures.test.ts`
- `/ios/MacAgentTests/ProtocolFixturesTests.swift` (파일 수 72 — phase 7 step 0 이후 기준. 실제 값은 파일에서 확인)
- `/packages/server/src/fs/read.ts` (`FsError`, 415 매핑, 크기 상한), `sandbox.ts` (`resolveInsideHome`, `statResolved`), `language.ts`, `/packages/server/src/agent-host/routes/fs.ts`, `http.ts` (`send`, `validate`), `errors.ts`
- `/packages/server/src/git/status.ts` (`runGit` 의 spawn 패턴)
- `/packages/server/test/fs/*.test.ts`, `/packages/server/test/agent-host/rest.test.ts`, `helpers/tmp-home.ts`
- `/packages/server/package.json` (의존성 추가 위치)

이전 phase 에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 배경

폰의 파일 브라우저에서 PDF·Word·한글 문서를 바로 보고 싶다. iOS 는 PDF·Office 문서를 QuickLook 으로 열 수 있으므로 서버는 **파일 원본을 내려주는** 엔드포인트가 필요하고, 한글(HWP/HWPX)은 iOS 가 못 열므로 **서버가 HTML 로 변환** 해 준다.

## 확정된 결정

- 문서 크기 상한 **100 MiB**. 넘으면 415 `unsupported_media`(기존 `/fs/read` 와 같은 매핑) 와 문구 "파일이 100 MiB 를 넘어 미리 볼 수 없습니다".
- HWP(5.x 바이너리)는 Mac 에 설치된 **pyhwp 의 `hwp5html`** 로 변환한다. 없으면 501 + code `agent_unavailable` + 문구 "한글(HWP) 변환기가 없습니다. Mac 에서 `python3 -m pip install --user pyhwp` 를 실행하세요."(로그인 미지원 501 과 같은 규칙).
- HWPX(zip + OWPML XML)는 서버가 직접 변환한다(`unzip` spawn + XML 파서). 문단·줄바꿈·표·이미지(data URI)·기본 서식(굵게·기울임·제목 크기 근사)까지. 완벽한 레이아웃은 목표가 아니다.
- 변환 결과 HTML 은 자체 완결(외부 리소스 없음, 스크립트 없음, 이미지는 data URI). 총 8 MiB 를 넘으면 이미지를 빼고 경고에 적는다.

## 작업

### 1. `docs/PROTOCOL.md` 1절

- `### GET /fs/download?path= (2026-09-13 추가)`: 홈 안 일반 파일의 **원본 바이트** 를 스트리밍. 응답은 JSON 이 아니다: `Content-Type` 은 확장자로(`application/pdf`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `…spreadsheetml.sheet`, `…presentationml.presentation`, `application/msword`, `application/vnd.ms-excel`, `application/vnd.ms-powerpoint`, `application/rtf`, `application/x-hwp`, `application/hwp+zip`, 그 외 `application/octet-stream`), `Content-Length`, `Content-Disposition: inline; filename*=UTF-8''<인코딩된 이름>`. 오류는 기존 JSON 봉투(403 홈 밖, 404 없음, 400 디렉토리, 415 100 MiB 초과). 프로토콜 헤더 규칙은 동일.
- `### GET /fs/render?path= (2026-09-13 추가)` → `FsRenderResponse { path, kind: "hwp" | "hwpx", html: string, warnings: string[] }`. 확장자가 `.hwp`/`.hwpx` 가 아니면 400. 변환기 없음 501 `agent_unavailable`. 변환 실패 500 `internal`(stderr 첫 줄은 로그에만).
- `GET /fs/list` 항목에는 변경 없음(앱이 확장자로 판단한다).

### 2. zod + fixture

`FsRenderResponseSchema`(`rest.ts`; `kind` 는 `z.enum(["hwp","hwpx"])`), `fixtures/rest/fs-render.json`(hwpx, 짧은 `<article>` HTML, warnings 1개), `fixtures.test.ts` 테이블 + `ADDED_2026_09_13` 에 추가, iOS 테이블 `JSONValue` 임시 등록 + 파일 수 +1(iOS step 1 이 실제 타입으로 바꾼다).

### 3. `src/fs/download.ts`

```ts
export const DOWNLOAD_LIMIT_BYTES = 100 * 1024 * 1024;
export function contentTypeFor(fileName: string): string;
export function contentDispositionFor(fileName: string): string;   // RFC 5987 filename*
/** 검사 후 { stream, size, contentType, disposition } 를 돌려준다. 라우트가 reply.header(...).send(stream). */
export async function openDownload(home: string, inputPath: string): Promise<{ stream: ReadStream; size: number; contentType: string; disposition: string }>;
```

`resolveInsideHome` → `statResolved` (디렉토리 400, 없음 404) → 크기 415 → `createReadStream`.

### 4. `src/fs/render-hwpx.ts`, `src/fs/render-hwp.ts`, `src/fs/render.ts`

- 의존성: `fast-xml-parser` 를 `packages/server` 에 추가한다(XML 파싱). zip 은 `spawn("unzip", ["-Z1", file])` 로 목록, `spawn("unzip", ["-p", file, entry])` 로 항목 추출(바이너리는 Buffer). 다른 zip 라이브러리는 넣지 않는다.
- `renderHwpx(file) → { html, warnings }`: `Contents/header.xml`(스타일 이름·글자 크기 힌트), `Contents/section*.xml` 순서대로. 매핑: `hp:p` → `<p>`(문단 속성 align), `hp:t` → 텍스트(줄바꿈 `hp:lineBreak` → `<br>`), `hp:tbl` → `<table>`(`hp:tr`/`hp:tc`, `colSpan/rowSpan`), `hp:pic` → `<img src="data:…">`(`BinData/<id>` 을 base64, mime 은 확장자), 굵게/기울임/밑줄은 `charPr` 참조로 `<b>/<i>/<u>`, 제목 스타일(`styleIDRef` 이름에 "제목"/"Heading")은 `<h2>/<h3>`. 모르는 요소는 텍스트만 남기고 `warnings` 에 종류를 1회 기록. HTML 은 `<article class="hwpx">…</article>` + 최소 CSS(`<style>` 인라인: 본문 폰트 시스템, 표 테두리, 이미지 max-width 100%). 스크립트·외부 URL 은 절대 넣지 않는다(텍스트는 HTML 이스케이프).
- `renderHwp(file) → { html, warnings }`: `hwp5html` 을 `spawn(bin, [file, "--output", tmpDir])`(pyhwp 의 실제 CLI 인자를 확인해 맞춘다; `python3 -m hwp5.hwp5html` 대안 포함) → `tmpDir/index.xhtml` 과 `styles.css`·`bindata/*` 를 읽어 CSS 인라인·이미지 data URI 로 합친 뒤 tmpDir 삭제. 바이너리 탐색: `MAM_HWP5HTML_BIN` → `command -v hwp5html`(로그인 셸 고정 명령) → `python3 -m hwp5.hwp5html --version` 성공 여부. 없으면 `AgentUnavailableError`(501).
- `renderDocument(home, inputPath)`: 확장자 분기, 100 MiB 상한, 결과 HTML 8 MiB 초과 시 이미지 제거 + warning.

### 5. 라우트 `routes/fs.ts`

`GET /fs/download`(`validate({ query })`, JSON `send` 대신 `reply.header(...).status(200).send(stream)`; 오류는 기존 `MamError` 매핑), `GET /fs/render` → `send(host, reply, FsRenderResponseSchema, …)`.

### 6. 테스트 (먼저 쓴다)

- `test/fs/download.test.ts`: `contentTypeFor`(pdf/docx/xlsx/pptx/doc/hwp/hwpx/기타), `contentDispositionFor`(한글 파일명 인코딩), `openDownload` 홈 밖 403·디렉토리 400·없음 404·100 MiB 초과 415(파일은 `truncate` 로 희소 파일을 만들어 크기만 키운다)·정상 스트림 바이트 동일.
- `test/fs/render-hwpx.test.ts`: 테스트가 `zip` CLI(spawn)로 만든 최소 HWPX(`mimetype`, `Contents/header.xml`, `Contents/section0.xml` 에 문단 2개·표 1개·굵은 글자·이미지 1개(`BinData/image1.png` 1×1))를 변환해 `<p>`, `<table>`, `<b>`, `data:image/png;base64` 가 있고 스크립트가 없으며 텍스트가 이스케이프되는지; 모르는 요소 warning; 8 MiB 초과 시 이미지 제거 warning.
- `test/fs/render-hwp.test.ts`: `MAM_HWP5HTML_BIN` 에 가짜 셸 스크립트(테스트가 tmp 에 생성, `index.xhtml`·`styles.css`·`bindata/a.png` 를 출력 디렉토리에 씀)를 지정해 합쳐진 HTML 검증; 바이너리 없음 → 501 `agent_unavailable`; 실패(exit 1) → 500.
- `test/agent-host/rest.test.ts` 확장: `GET /fs/download` 헤더·바이트, `GET /fs/render` hwpx 200·`.txt` 400·hwp 501(바이너리 없음 환경).

## Acceptance Criteria

```bash
npm ci
npm run typecheck
npm test
test -f packages/server/src/fs/download.ts
test -f packages/server/src/fs/render-hwpx.ts
test -f packages/protocol/fixtures/rest/fs-render.json
grep -q "GET /fs/download" docs/PROTOCOL.md
grep -q "fs-render.json" ios/MacAgentTests/ProtocolFixturesTests.swift
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 모든 경로가 `resolveInsideHome` 을 거치는가(CRITICAL 3)? `unzip`·`hwp5html` 이 spawn 인자 배열인가(CRITICAL 4)?
   - 변환 HTML 에 스크립트·외부 리소스가 없고 텍스트가 이스케이프되는가(폰 WKWebView 에서 열린다)?
   - 파일 내용을 로그에 남기지 않는가(CRITICAL 6)? fixture → zod → 문서 → iOS 테이블이 맞는가(CRITICAL 5)?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- pyhwp 를 사용자 Mac 에 설치하지 마라(`pip install` 금지). 이유: 사용자 환경 변경은 사용자가 한다. 테스트는 가짜 바이너리로.
- `fast-xml-parser` 외의 새 런타임 의존성(zip 라이브러리 등)을 넣지 마라. 이유: `unzip` CLI 로 충분하다.
- 변환 HTML 에 `<script>`·외부 `src/href` 를 넣지 마라.
- iOS 를 수정하지 마라(테이블 등록 제외).
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
