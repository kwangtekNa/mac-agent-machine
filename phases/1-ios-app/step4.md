# Step 4: sessions-ui

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/IOS.md` (4절 내비게이션의 SessionsHome, 5절 디자인, 6절 `SessionsStore`, 7절)
- `/docs/PROTOCOL.md` (1절 `/projects`, `/sessions`, `POST /sessions`, `POST /sessions/:id/close`, 4절 모드)
- `/ios/MacAgent/App/AppState.swift`, `RootView.swift`, `/ios/MacAgent/Features/Settings/` (step 3)
- `/ios/MacAgent/Networking/APIClient.swift` (step 2), `/ios/MacAgent/Models/Protocol/Session.swift` (step 1)

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

연결 후 첫 화면인 세션 홈(프로젝트·세션 목록)과 새 세션 시트를 만든다. 세션을 탭하면 열리는 타임라인 화면은 step 5이므로 여기서는 `TimelineView(sessionId:)` 자리표시자(세션 제목과 상태만 표시)를 `Features/Timeline/TimelineView.swift`에 만들어 둔다.

### 1. `ios/MacAgent/Features/Sessions/SessionsStore.swift`

```swift
@MainActor @Observable final class SessionsStore {
  private(set) var projects: [Project]
  private(set) var sessions: [Session]
  private(set) var isLoading: Bool
  private(set) var errorMessage: String?
  init(client: APIClient)
  func refresh() async                                    // projects + sessions 병렬
  func create(agent: AgentKind, cwd: String, title: String?, mode: SessionMode) async throws -> Session
  func close(_ session: Session) async throws
  var active: [Session]                                    // running | waiting_approval, waiting 먼저, updatedAt desc
  func sessions(inProject path: String) -> [Session]       // updatedAt desc
  var pendingApprovalTotal: Int
}
```

### 2. `ios/MacAgent/Features/Sessions/SessionsHomeView.swift`

- `List`(insetGrouped):
  - 섹션 "지금 진행 중"(`active`가 비어 있지 않을 때만): 세션 행. `waiting_approval`이면 행 오른쪽에 `.yellow` `hand.raised.fill` + 대기 건수.
  - 섹션 "프로젝트": `/projects` 각 항목 행(폴더 아이콘, 이름, 경로 `.caption .secondary`, git 리포면 `arrow.triangle.branch` 작은 아이콘, 세션 수) → `ProjectSessionsView`.
  - 섹션 "최근 세션": 상위 10개.
- 빈 상태: `ContentUnavailableView("아직 세션이 없습니다", systemImage: "bubble.left.and.text.bubble.right", description: Text("오른쪽 위 + 로 시작하세요"))`.
- 툴바: 왼쪽 설정 기어(step 3 `SettingsView` 시트), 오른쪽 `+`(`NewSessionSheet`).
- `refreshable`, 화면 등장 시와 15초 주기로 `refresh()`(승인 대기 배지 갱신용. 화면이 사라지면 타이머 중단).
- 오류는 리스트 상단 노란 배너 행 + "다시 시도".

### 3. `SessionRowView.swift`

에이전트 배지(텍스트 캡슐 "Claude" 또는 "Codex", `.secondary` 배경), 제목(없으면 `preview` 첫 줄, 그것도 없으면 "새 세션"), 두 번째 줄 `cwd`의 마지막 두 컴포넌트 + 상대 시간(`Shared/Formatters.swift`의 `relativeTime(_:)`, "방금", "3분 전", "어제"), 상태 점(`idle` 회색, `running` 파랑 + `ProgressView`, `waiting_approval` 노랑, `error` 빨강, `closed` 없음). 스와이프 액션 "닫기"(closed가 아닐 때). 탭 → `TimelineView(sessionId:)`.

### 4. `ProjectSessionsView.swift`

프로젝트 하나의 세션 목록(같은 행 뷰). 툴바 `+`는 이 프로젝트의 `cwd`가 미리 채워진 `NewSessionSheet`.

### 5. `NewSessionSheet.swift`

`Form`: 에이전트 `Picker`(segmented, `me.agents`에서 `available && loggedIn`이 아닌 항목은 비활성 + 이유 캡션 "로그인 필요"/"설치되지 않음"), 디렉토리(프로젝트 `Picker` + "다른 경로" 선택 시 `TextField("~/work/my-app")`), 모드 `Picker`(`ask` 기본, `auto-edit`, `plan`. `full-auto`는 여기 없음. 설명 한 줄씩: "ask: 명령 실행과 파일 변경 전에 묻습니다" 등), 제목(선택). 버튼 "세션 시작" → `store.create` → 시트 닫고 새 세션의 타임라인으로 push. 오류(403 홈 밖, 400 없는 경로, `agent_unavailable`)는 폼 하단 메시지.

### 6. `RootView` 연결

`.connected`일 때 `SessionsHomeView`를 `NavigationStack` 루트로. step 3의 자리표시자 제거. `SessionsStore`는 `AppState.client`가 바뀔 때 새로 만든다.

### 7. 테스트 (`ios/MacAgentTests/Features/Sessions/`)

- `SessionsStoreTests.swift`: 스텁 응답(fixture `rest/projects.json`, `rest/sessions.json` + 상태를 바꾼 변형)으로 `active` 정렬(waiting 먼저), `sessions(inProject:)`, `pendingApprovalTotal`, `create`가 올바른 본문(`agent, cwd, mode, title`)을 보내고 목록에 추가, `close`가 상태를 갱신, 오류 메시지 매핑.
- `FormattersTests.swift`: 상대 시간, 경로 축약(`/Users/alice/work/app` → `work/app`).

## Acceptance Criteria

```bash
cd ios && xcodegen generate --quiet && xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet test && cd ..
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - `docs/IOS.md` 4절의 SessionsHome 구조(진행 중 → 프로젝트 → 최근)와 5.5 문구를 따르는가?
   - `full-auto`가 새 세션 시트에 없고 서버 기본 `ask`를 존중하는가(ADR-015)?
   - 목록 로직이 뷰가 아니라 `SessionsStore`에 있어 테스트되는가?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- 세션 삭제(이벤트 로그 삭제) 기능을 만들지 마라. 서버에 그런 API가 없고 v1 범위 밖이다. "닫기"만.
- 임의 디렉토리 탐색용 파일 브라우저를 여기서 만들지 마라(step 7). 경로는 프로젝트 선택 또는 텍스트 입력.
- 타임라인 카드나 소켓 연결을 미리 만들지 마라(step 5). 자리표시자만.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
