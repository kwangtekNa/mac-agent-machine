# Step 5: timeline-ui

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/IOS.md` (5절 디자인 시스템 전체, 6절 `TimelineModel` 적용 규칙, 7절 오류·엣지)
- `/docs/PROTOCOL.md` (2절 WS 이벤트, 3절 TimelineItem 10종, 4절 모드)
- `/packages/protocol/fixtures/ws/*.json` (테스트 입력으로 그대로 쓴다)
- `/ios/MacAgent/Networking/SessionSocket.swift` (step 2), `/ios/MacAgent/Models/Protocol/TimelineItem.swift`, `ServerEvent.swift` (step 1)
- `/ios/MacAgent/Features/Sessions/` (step 4), `/ios/MacAgent/Features/Timeline/TimelineView.swift` (step 4 자리표시자. 이 step이 교체한다)
- `/packages/server/src/agents/fake/` (개발 서버의 Fake 어댑터가 어떤 이벤트 순서를 내는지)

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

앱의 핵심 화면인 세션 타임라인을 만든다. 이벤트 → 아이템 배열 적용 로직(`TimelineModel`), 10종 카드, 컴포저, 모드 메뉴. 승인 **응답** UI(배너·시트)는 step 6이며, 여기서는 승인 아이템을 읽기 전용 카드로 그리고 컴포저 위에 배너 자리만 남긴다. 파일 브라우저 버튼은 step 7까지 비활성 자리표시자.

### 1. `ios/MacAgent/Features/Timeline/TimelineModel.swift`

```swift
@MainActor @Observable final class TimelineModel {
  private(set) var session: Session?
  private(set) var items: [TimelineItem]          // seq 오름차순
  private(set) var pendingApprovals: [Approval]   // requestedAt 오름차순
  private(set) var status: SessionStatus
  private(set) var mode: SessionMode
  private(set) var hasOlderHistory: Bool          // snapshot.truncated
  private(set) var transientError: String?        // recoverable error, 3초 후 nil
  private(set) var fatalError: String?            // recoverable == false 또는 status == .error
  var socketState: SessionSocket.State
  init(sessionId: String, client: APIClient, socketFactory: ...)
  func start() async          // GET /sessions/:id 로 초기 items → socket connect(since: lastSeq)
  func stop()                 // 소켓 종료 (백그라운드 전환 시)
  func resume()               // since 로 재접속
  func apply(_ event: ServerEvent)                 // 유일한 변경 경로. 순수 함수처럼 테스트 가능
  func send(text: String) async
  func interrupt() async
  func setMode(_ mode: SessionMode) async
}
```

적용 규칙은 `docs/IOS.md` 6절 그대로. 추가 규칙:

- `items`는 `id → index` 딕셔너리를 함께 유지해 델타 적용이 O(1)이 되게 한다. 델타는 `field`에 따라 `assistant_message.text`/`reasoning.text`/`tool_call.output`/`file_change.patch`에 append. 대상 아이템이 없으면 무시(로그).
- `seq <= lastSeq`인 이벤트(재생 중복)는 무시한다. 단 `seq == 0`(snapshot, pong)은 예외.
- `session.snapshot`은 `start()`가 REST로 받은 items와 합친다: snapshot의 `replayFrom` 이후는 snapshot이 진실이므로 같은 id는 교체, 나머지는 유지.
- `turn.completed`는 아이템을 만들지 않는다(서버가 `turn_summary` 아이템을 따로 보낸다).
- `send`는 `status == .running`이면 UI에서 막고, 서버가 `session is busy`를 돌려주면 `transientError`.
- 백그라운드: 뷰가 `scenePhase`를 보고 `stop()`/`resume()` 호출.

### 2. `ios/MacAgent/Shared/ItemStyle.swift`

`docs/IOS.md` 5.2 표를 코드로: `struct ItemStyle { let symbol: String; let tint: Color; let defaultExpanded: Bool }`, `static func style(for item: TimelineItem) -> ItemStyle`. 표와 다르게 만들지 마라.

### 3. 카드 (`ios/MacAgent/Features/Timeline/Cards/`)

공통 컨테이너 `ItemCard`: 왼쪽 24pt 아이콘 열(상태에 따라 `ProgressView().controlSize(.mini)` 오버레이), 제목 한 줄, 오른쪽 위 `.caption2 .secondary` 시각(HH:mm), 본문 슬롯. 배경 `Color(.secondarySystemGroupedBackground)`, `cornerRadius 12`, 그림자 없음, 내부 여백 12.

- `UserMessageCard`: 옅은 `accentColor.opacity(0.10)` 배경, 본문 텍스트(마크다운 아님, 선택 가능), 첨부 이미지 썸네일.
- `AssistantMessageCard`: MarkdownUI `Markdown(text)`. 테마는 `.gitHub`를 기반으로 폰트를 시스템 `.body`로, 코드블록은 `.monospaced` + 가로 스크롤 + `Color(.tertiarySystemGroupedBackground)`. 스트리밍 중(`status == .running`)에는 50ms 디바운스로 렌더. `phase == .commentary`면 `.secondary` 색.
- `ReasoningCard`: `DisclosureGroup("생각 요약")` 기본 접힘, 본문 `.secondary`.
- `ToolCallCard`: 아이콘·색은 `ItemStyle`(tool별), 제목 `title`(monospaced, 1줄), 오른쪽에 `exitCode`가 0이 아니면 빨간 캡슐 `exit 1`. 펼치면 `output`을 monospaced `.caption` 가로 스크롤 텍스트로(최대 높이 240, 그 안에서 세로 스크롤), `truncated`면 "출력 일부만 표시" 캡션. `input`은 "입력 보기" 토글로 JSON pretty.
- `FileChangeCard`: 파일 목록(경로 monospaced, `+10 −2` 녹/적 캡션, kind 아이콘: add `plus`, modify `pencil`, delete `minus`, rename `arrow.right`). "변경 내용" 토글 → `Shared/DiffTextView.swift`: unified diff를 줄 단위로 `+` 줄 `.green.opacity(0.15)` 배경, `-` 줄 `.red.opacity(0.15)`, `@@` 줄 `.secondary`, 그 외 기본. monospaced, 가로 스크롤.
- `PlanCard`: 단계 목록. `completed`는 `checkmark.circle.fill .green`, `in_progress`는 `circle.dotted` + `ProgressView`, `pending`은 `circle`.
- `ApprovalCard`(읽기 전용): 대기 중이면 노란 배경 카드에 제목·prompt와 "아래 배너에서 응답하세요" 캡션(step 6이 실제 버튼을 붙인다), 처리됨이면 한 줄 요약 "허용됨 · 12:03" / "거절됨 · 12:04"(`resolution.optionId`를 라벨로 매핑: allow→허용됨, allow_session→항상 허용됨, deny→거절됨, abort→중단됨, 그 외 optionId 그대로).
- `TurnSummaryRow`: 카드 아님. 가운데 정렬 `.caption .secondary` 한 줄 `12초 · 1.2k 토큰 · $0.03`(`costUsd` 없으면 생략). `Shared/Formatters.swift`에 `duration(ms:)`, `tokens(_:)`, `usd(_:)` 추가.
- `ErrorCard`: 빨간 아이콘, 메시지, `recoverable`이면 "다시 시도"(마지막 사용자 메시지를 재전송하는 대신 컴포저에 포커스만).
- `SystemRow`: `info.circle` + 캡션 한 줄.

### 4. `TimelineView.swift`, `Composer.swift`, `ModeMenu.swift`

- `ScrollViewReader` + `ScrollView` + `LazyVStack(spacing: 12)`. `hasOlderHistory`면 맨 위에 "이전 기록이 더 있습니다" 캡션. 바닥 추적: 마지막 아이템이 보이면 `isAtBottom = true`; 새 이벤트가 오고 `isAtBottom`이면 스크롤, 아니면 하단에 "새 이벤트 ↓" 칩(탭하면 스크롤).
- 상단: `fatalError`가 있으면 빨간 배너 + "다시 시도"(`resume()`); `socketState`가 `.reconnecting`이면 "다시 연결 중…" 얇은 바.
- 하단 `safeAreaInset(edge: .bottom)`: `ApprovalBannerSlot`(step 6이 채울 빈 뷰, `pendingApprovals`가 비어 있지 않으면 높이 0이 아닌 자리표시자 캡션 "승인 대기 1건") + `Composer`.
- `Composer`: `TextField("메시지", axis: .vertical).lineLimit(1...6)`, 오른쪽 버튼은 `status == .running`이면 `stop.circle.fill`(중단, `.red`), 아니면 `arrow.up.circle.fill`(보내기, 빈 텍스트면 비활성). `socketState != .open`이면 비활성. 보내기 후 필드 비움. `transientError`는 필드 위 `.red` 캡션 3초.
- 툴바: 제목 = 세션 제목(없으면 프로젝트 이름), 부제 상태 텍스트("응답 중", "승인 대기", "대기", "오류"). 오른쪽: `ModeMenu`(현재 모드 아이콘: ask `questionmark.bubble`, auto-edit `pencil.and.outline`, plan `list.bullet.clipboard`, full-auto `bolt.fill`), "파일"(`folder`, step 7까지 `.disabled(true)`), 세션 정보(`info.circle` → 시트: cwd, agent, nativeId, 생성 시각, "세션 닫기").
- `ModeMenu`: `Menu`에 4개. `full-auto` 선택 시 `confirmationDialog("에이전트가 확인 없이 명령을 실행하고 파일을 수정합니다", "full-auto로 전환")` 후 `setMode`.
- 세션 정보 시트의 "세션 닫기" → REST close → 이전 화면으로.

### 5. 테스트 (`ios/MacAgentTests/Features/Timeline/`)

- `TimelineModelTests.swift`(fixture 이벤트를 `ServerEvent`로 디코드해 `apply`): 스냅샷 → items/pending/status; `item.started` 추가와 같은 id 교체; 델타 append(`item.delta.json`)와 대상 없음 무시; `item.completed` 교체; `seq` 중복 무시; `approval.requested` → pending + status waiting; `approval.resolved` → pending 제거 + 아이템 resolution 반영(같은 approvalId를 가진 `item.completed`가 뒤따르는 경우도); `session.status`; `error` recoverable/fatal; `turn.completed`가 아이템을 만들지 않음; REST 초기 items와 snapshot 병합.
- `ItemStyleTests.swift`: 5.2 표의 대표 8개 매핑.
- `DiffTextViewTests.swift`(줄 분류 함수 `DiffLine.classify`): `+`/`-`/`@@`/`+++`·`---` 헤더는 헤더로.
- `FormattersTests.swift` 확장: duration/tokens/usd.

### 6. 수동 확인

`bash scripts/dev-smoke.sh --keep`으로 서버를 띄우고 시뮬레이터에서 새 세션 → "hello" 전송 → Fake 어댑터의 스트리밍 텍스트, tool_call, 승인 대기 카드(읽기 전용), 이후 `approval`을 `curl`로 REST 응답(`POST /api/v1/sessions/<id>/approvals/<apr>` 본문 `{"approvalId":"...","optionId":"allow"}`)해 카드가 "허용됨"으로 바뀌고 `turn_summary`가 뜨는지 확인하라. 스크린샷을 `xcrun simctl io booted screenshot`으로 찍어 직접 보고, 5절 디자인과 다른 점을 고쳐라. summary에 확인 결과를 적어라.

## Acceptance Criteria

```bash
cd ios && xcodegen generate --quiet && xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet test && cd ..
ls ios/MacAgent/Features/Timeline/Cards/*.swift | wc -l      # 9개 이상
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - `docs/IOS.md` 5.2 표의 아이콘·색·기본 펼침 상태와 5.3 레이아웃 규칙을 그대로 따르는가? 커스텀 hex 색이 없는가?
   - 이벤트 적용이 `TimelineModel.apply` 한 곳에서만 일어나고 뷰는 상태만 읽는가?
   - 낙관적 `user_message` 삽입이 없는가(6절)?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- 승인 응답 버튼·시트를 만들지 마라(step 6). 이유: 배너 규칙이 별도 step에서 정의된다. 읽기 전용 카드와 슬롯만.
- 터미널 에뮬레이션(ANSI 렌더링, xterm 류)을 넣지 마라. `tool_call.output`은 텍스트로만 보여준다.
- 카드마다 등장 애니메이션·그림자·그라데이션을 넣지 마라(IOS.md 5절). 애니메이션은 배너 등장 1회뿐이며 그것도 step 6.
- MarkdownUI·Highlightr 외 패키지를 추가하지 마라.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
