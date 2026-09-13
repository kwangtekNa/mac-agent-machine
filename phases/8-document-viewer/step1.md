# Step 1: ios-document-viewer

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md` (CRITICAL 8)
- `/docs/IOS.md` 5절, 7절 오류·엣지(415 안내), 9.1(파일 탭), 10절
- `/docs/PROTOCOL.md` `GET /fs/download`, `GET /fs/render` (step 0), `GET /fs/read` 415 규칙
- `/packages/protocol/fixtures/rest/fs-render.json`
- `/ios/MacAgent/Features/Files/FileViewerView.swift` (`FileViewerLogic`, `Phase`, 이미지·텍스트·Markdown 분기, 툴바 wrap/공유/변경 보기), `FileBrowserView.swift`(파일 탭 → `FileViewerView(client:rootPath:path:isGitRepo:gitStatus:)`), `FileBrowserModel.swift`(`FileFormat.size`), `HighlightedCodeView.swift`
- `/ios/MacAgent/Models/Protocol/REST.swift`, `/ios/MacAgent/Networking/APIClient.swift`(`readFile` 의 60초 타임아웃 예), `/ios/MacAgent/Shared/ErrorMessages.swift`(`fileAccessMessage`, `loginUnsupported` 의 501 처리)
- `/ios/MacAgentTests/ProtocolFixturesTests.swift`(`fs-render.json` 임시 `JSONValue`), `Features/Files/FileViewerLogicTests.swift`, `Networking/APIClientTests.swift`, `Networking/StubURLProtocol.swift`

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

파일 브라우저에서 문서 파일을 탭하면 기존 `FileViewerView` 자리에 문서가 열린다: PDF·Office 등은 **QuickLook**, 한글(HWP/HWPX)은 서버 변환 HTML 을 **WKWebView** 로.

### 확정된 결정

- QuickLook 대상 확장자: `pdf, doc, docx, xls, xlsx, ppt, pptx, rtf, rtfd, pages, numbers, key, epub`(그 외는 지금처럼 `/fs/read` → 텍스트/이미지/415). csv·md·txt 는 기존 텍스트 뷰어 그대로.
- 한글: `hwp, hwpx` → `GET /fs/render`. 501 이면 안내 문구 + Mac 에서 할 명령을 그대로 보여준다.
- 크기 상한 100 MiB: `FsEntry.size` 를 알면 서버 호출 전에 막고("100 MiB 를 넘어 미리 볼 수 없습니다"), 모르면 서버 415 문구.
- 다운로드는 `URLSession.download` 로 앱 캐시 디렉토리(`Caches/mam-docs/<path hash>/<파일명>`)에 저장하고 뷰어를 닫을 때 지운다. 진행률 표시(`ProgressView(value:)`), 취소 가능.
- 툴바: QuickLook 은 시스템 공유 버튼이 있으므로 우리 툴바에는 파일 이름·크기만. HWP 뷰어 툴바에 "원본 공유"(`downloadFile` 후 `ShareLink`).

### 1. 모델·클라이언트

- `FsRenderResponse { path, kind: DocumentRenderKind(lenient: hwp, hwpx, unknown), html, warnings }`(REST.swift), fixture 테이블 실제 타입으로.
- `APIClient.renderDocument(path:) -> FsRenderResponse`(타임아웃 120초), `APIClient.downloadFile(path:to destination: URL, progress: @Sendable (Double) -> Void) async throws -> URL`(`URLSession.bytes` 또는 `download(for:)` + delegate; `X-MAM-Protocol` 헤더 필수, 2xx 아니면 본문을 오류 봉투로 파싱).

### 2. 순수 로직 `FileViewerLogic` 확장

```swift
enum DocumentKind: Equatable { case quickLook, hwp, hwpx }
static func documentKind(forFileName name: String) -> DocumentKind?
static let documentLimitBytes = 100 * 1024 * 1024
static func exceedsDocumentLimit(size: Int?) -> Bool
static func cacheURL(for path: String, fileName: String) -> URL   // Caches/mam-docs/<sha256 앞 16자>/<fileName>
static func hwpUnavailableMessage(_ serverMessage: String) -> String   // 501 문구 + 명령 강조
```

### 3. 뷰

- `FileViewerView`: `Phase` 에 `.downloading(progress)`, `.document(URL)`, `.rendered(FsRenderResponse)` 추가. `load()` 는 먼저 `documentKind(forFileName:)` 을 보고 분기: `quickLook` → 다운로드 → `.document`; `hwp/hwpx` → `renderDocument` → `.rendered`; nil → 기존 흐름. 크기 상한은 `FsEntry.size` 가 있으면 먼저(브라우저가 `FsEntry` 를 넘기도록 `FileViewerView` init 에 `size: Int?` 추가, 기존 호출부 갱신).
- `Features/Files/QuickLookView.swift`: `UIViewControllerRepresentable`(`QLPreviewController` + `QLPreviewControllerDataSource` 1개 항목, `QuickLook` 프레임워크). 닫힘은 내비게이션 뒤로가기(push 된 뷰 안에 임베드).
- `Features/Files/HTMLDocumentView.swift`: `WKWebView`(`WebKit`) `loadHTMLString(html, baseURL: nil)`, 스크립트 비활성(`WKWebpagePreferences.allowsContentJavaScript = false`), 링크 탭은 시스템 `openURL` 로 넘기지 않고 무시, 다크 모드는 CSS `color-scheme: light dark` 를 HTML 앞에 주입. `warnings` 가 있으면 상단 회색 배너 "일부 요소는 표시되지 않았습니다: …".
- 501 → `ContentUnavailableView("한글 변환기가 없습니다", systemImage: "doc.badge.gearshape", description: Text(hwpUnavailableMessage))` + "다시 시도".

### 4. 테스트 (먼저 쓴다)

- `FileViewerLogicTests` 확장: `documentKind`(대소문자, 점 없는 이름, `.md/.csv` 는 nil), `exceedsDocumentLimit`, `cacheURL` 결정성·파일명 유지·경로 분리, `hwpUnavailableMessage`.
- `APIClientTests` 확장: `renderDocument` 경로, `downloadFile` 이 헤더를 붙이고 바이트를 그대로 쓰며 진행률 콜백이 1.0 으로 끝나는지, 415/404 를 오류 봉투로 던지는지(`StubURLProtocol`).
- `ProtocolFixturesTests`: `fs-render.json` 실제 타입.
- 렌더 테스트: `HTMLDocumentView` 를 호스팅해 `WKWebView` 가 존재하고 JavaScript 가 비활성인지; `QuickLookView` 호스팅 시 `QLPreviewController` 존재.

## Acceptance Criteria

```bash
cd ios && xcodegen generate --quiet && xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet test && cd ..
test -f ios/MacAgent/Features/Files/QuickLookView.swift
test -f ios/MacAgent/Features/Files/HTMLDocumentView.swift
grep -q "documentKind" ios/MacAgent/Features/Files/FileViewerView.swift
! grep -n "JSONValue.self" ios/MacAgentTests/ProtocolFixturesTests.swift
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 새 SwiftPM 패키지 없이 `QuickLook`·`WebKit` 시스템 프레임워크만 썼는가(ADR-012)?
   - WKWebView 에서 JavaScript 가 꺼져 있고 외부 링크가 열리지 않는가?
   - 캐시 파일이 뷰어를 닫을 때 지워지는가?
   - `xcodegen generate` 실행(CRITICAL 8)?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- 문서를 `/fs/read` 의 base64 로 받지 마라. 이유: 100 MiB 문서는 `/fs/download` 스트리밍으로만.
- 서버·프로토콜을 수정하지 마라. 불일치는 `needs_input`.
- 기존 텍스트·이미지·Markdown 뷰어 동작을 바꾸지 마라.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
