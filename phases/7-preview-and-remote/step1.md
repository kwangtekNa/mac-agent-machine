# Step 1: ios-preview

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md` (CRITICAL 8)
- `/docs/IOS.md` 5절, 10.2(방 화면 툴바), 6절 상태 흐름
- `/docs/PROTOCOL.md` `GET /net/ports (2026-09-13 추가)` (step 0)
- `/packages/protocol/fixtures/rest/net-ports.json`
- `/ios/MacAgent/Models/Protocol/REST.swift`, `/ios/MacAgent/Networking/APIClient.swift`, `ServerConfigStore.swift`(저장된 서버 URL → 호스트)
- `/ios/MacAgentTests/ProtocolFixturesTests.swift` (`net-ports.json` 이 `JSONValue` 로 임시 등록, 파일 수 72)
- `/ios/MacAgent/Features/Rooms/RoomView.swift`(툴바), `Cards/MessageCard.swift`(MarkdownUI), `/ios/MacAgent/Features/Timeline/TimelineView.swift`(툴바), `Cards/AssistantMessageCard.swift`(MarkdownUI `Theme.macAgent`), `Cards/ToolCallCard.swift`, `Shared/TextContentViewer.swift`
- `/ios/MacAgent/Features/Settings/AgentLoginView.swift` (`openURL` 환경 사용 예)
- MarkdownUI 의 링크 처리: `Markdown` 뷰는 링크 탭에 `openURL` 환경 액션을 쓴다 — `.environment(\.openURL, OpenURLAction { … })` 로 가로챌 수 있다.

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

폰에서 Mac 의 개발 서버를 열어 본다: (1) 메시지·타임라인의 `localhost` 링크를 Mac 주소로 바꿔 **앱 안 브라우저** 로 열기, (2) 방·세션 툴바의 "미리보기" 버튼 → 열린 포트 목록 시트.

### 확정된 결정

- 변환 대상 호스트: `localhost`, `127.0.0.1`, `0.0.0.0`, `[::1]`(스킴 http/https, 포트·경로·쿼리 유지). 호스트만 앱에 저장된 서버 URL 의 호스트로 바꾼다(포트는 원래 것). 그 외 URL 은 그대로 시스템 `openURL`.
- 앱 안 브라우저 = `SFSafariViewController`(`SafariServices`, 새 패키지 없음). 닫으면 원래 화면으로.
- 미리보기 시트: `GET /net/ports` 목록(행: `3000 · node`, `address` 가 `127.0.0.1`/`::1` 이면 회색 캡션 "Mac 안에서만 열림 — 폰에서 안 열릴 수 있습니다"), 직접 포트 입력 필드, 최근 연 포트(UserDefaults, 최대 5개). 행 탭 → `http://<서버 호스트>:<port>/`.

### 1. 모델·클라이언트

`NetPort`, `NetPortsResponse`(REST.swift), `APIClient.listeningPorts() -> [NetPort]`, fixture 테이블을 실제 타입으로(72 유지).

### 2. 순수 로직 `Features/Preview/PreviewLink.swift`

```swift
enum PreviewLink {
    static let localHosts: Set<String> = ["localhost", "127.0.0.1", "0.0.0.0", "::1"]
    /// localhost 계열 URL 을 서버 호스트로 바꾼다. 아니면 nil.
    static func rewrite(_ url: URL, serverURL: URL) -> URL?
    static func previewURL(port: Int, serverURL: URL) -> URL      // http://<host>:<port>/
    static func isMacOnly(_ port: NetPort) -> Bool                // address 가 127.0.0.1 / ::1
}
struct RecentPortsStore { … }   // UserDefaults, 최대 5개, 최근 순
```

### 3. 링크 가로채기

`MessageCard`(에이전트 메시지)와 `AssistantMessageCard` 의 `Markdown` 에 `.environment(\.openURL, OpenURLAction { url in … })`: `PreviewLink.rewrite` 가 값을 주면 `SafariSheet` 로 열고 `.handled`, 아니면 `.systemAction`. `ToolCallCard`/`TextContentViewer` 의 일반 텍스트는 변환하지 않는다(범위 밖). 시트 표시는 `@State var safariURL: URL?` + `.sheet(item:)`.

### 4. `Features/Preview/SafariView.swift`, `PreviewPortsSheet.swift`

- `SafariView: UIViewControllerRepresentable`(`SFSafariViewController`, `dismissButtonStyle .close`).
- `PreviewPortsSheet(client:serverURL:)`: 등장 시 `listeningPorts()`, 당겨서 새로고침, 섹션 "열린 포트"(빈 목록이면 "열린 포트가 없습니다. 에이전트에게 개발 서버를 띄워 달라고 하세요."), "직접 입력"(숫자 필드 + 열기), "최근". 식별자 `preview.port.<port>`, `preview.custom`, `preview.open`.
- 툴바 버튼 "미리보기"(`safari` 아이콘, 식별자 `room.preview` / `timeline.preview`)를 `RoomView` 와 `TimelineView` 의 trailing 그룹에 추가.

### 5. 테스트 (먼저 쓴다)

- `PreviewLinkTests`: 변환 표(`http://localhost:3000/a?b=1` → `http://192.168.0.14:3000/a?b=1`, `https://127.0.0.1:8443`, `http://[::1]:5173`, `http://0.0.0.0:3000`, 포트 없는 `http://localhost` → 80 유지, `https://example.com` → nil, 서버 URL 이 `https://mac.tailnet.ts.net:7777` 이어도 포트는 원본 것), `previewURL`, `isMacOnly`, `RecentPortsStore` 순서·상한.
- `PreviewPortsSheetStateTests`: 정렬·캡션 규칙·빈 목록 문구(순수 상태 구조체로 뽑는다).
- `APIClientTests` 확장: `GET /api/v1/net/ports`.

## Acceptance Criteria

```bash
cd ios && xcodegen generate --quiet && xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet test && cd ..
test -f ios/MacAgent/Features/Preview/PreviewLink.swift
test -f ios/MacAgent/Features/Preview/SafariView.swift
grep -q "room.preview" ios/MacAgent/Features/Rooms/RoomView.swift
! grep -n "JSONValue.self" ios/MacAgentTests/ProtocolFixturesTests.swift
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 새 SwiftPM 패키지 없이 `SafariServices` 만 썼는가(ADR-012)?
   - localhost 계열이 아닌 링크는 기존처럼 시스템이 여는가?
   - `xcodegen generate` 실행(CRITICAL 8)?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- WKWebView 로 자체 브라우저를 만들지 마라. 이유: `SFSafariViewController` 가 쿠키·인증·공유를 그대로 제공한다.
- 서버를 수정하지 마라. 불일치는 `needs_input`.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
