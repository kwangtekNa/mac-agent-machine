# Step 3: connect-settings-ui

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/IOS.md` (4절 내비게이션, 5절 디자인 시스템 특히 5.5 문구, 6절 `AppState`, 7절 오류)
- `/docs/PROTOCOL.md` (1절 `/me`, 로그인 플로우)
- `/docs/ADR.md` (ADR-008 로그인 방식: Claude는 URL + 코드 입력, Codex는 URL + 표시된 코드 입력)
- `/ios/MacAgent/Networking/*.swift` (step 2), `/ios/MacAgent/Models/Protocol/*.swift` (step 1)
- `/ios/MacAgent/App/RootView.swift` (step 0의 자리표시자. 이 step이 교체한다)

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

첫 실행 화면(서버 연결), 설정 화면, 에이전트 로그인 플로우 화면을 만든다. 세션 목록은 step 4이므로 연결 성공 후에는 임시로 "연결됨" 요약 화면(`SessionsHome` 자리표시자)을 보여준다.

### 1. `ios/MacAgent/App/AppState.swift`

```swift
@MainActor @Observable final class AppState {
  enum ConnectionState: Equatable { case disconnected, connecting, connected(MeResponse), failed(message: String) }
  let configStore: ServerConfigStore
  private(set) var connection: ConnectionState
  private(set) var client: APIClient?
  func connect(to url: URL) async          // 저장 + /me → connected 또는 failed(한국어 메시지)
  func reconnectSavedServer() async        // 앱 시작 시. 저장된 서버 없으면 disconnected
  func refreshMe() async
  func disconnect()                        // 설정 삭제
}
```

오류 메시지 매핑(`Shared/ErrorMessages.swift`): 전송 오류 → "서버에 연결할 수 없습니다. Tailscale이 켜져 있는지 확인하세요.", 403 → "이 계정은 서버에 등록되어 있지 않습니다. 관리자에게 이메일 등록을 요청하세요.", 426 → "앱을 업데이트해야 합니다.", 그 외 → 서버 메시지.

### 2. `ios/MacAgent/App/RootView.swift`

`connection`에 따라: `.disconnected`/`.failed` → `ConnectView`, `.connecting` → 진행 표시, `.connected` → `SessionsHomePlaceholderView`(툴바에 설정 기어 → `SettingsView` 시트). `MacAgentApp`은 `AppState`를 만들어 `.environment`로 내려주고 `.task { await appState.reconnectSavedServer() }`.

### 3. `ios/MacAgent/Features/Connect/`

- `ConnectView.swift`: 제목 "Mac 서버에 연결", 설명 한 줄("Tailscale에 연결된 Mac의 주소를 입력하세요"), `TextField("https://macmini.tailnet.ts.net")`(자동 대문자·자동수정 끔, `.URL` 키보드), 버튼 "연결"(빈 값이면 비활성), 실패 메시지는 필드 아래 `.red` 캡션. 개발 편의: 시뮬레이터에서만(`#if targetEnvironment(simulator)`) "개발 서버(127.0.0.1:7777)" 보조 버튼.
- `ConnectModel.swift`: 입력 문자열 → `ServerConfigStore.normalize` → `appState.connect`. 검증 오류도 한국어로.

### 4. `ios/MacAgent/Features/Settings/`

- `SettingsView.swift`(`Form`): 섹션 "서버"(주소, 사용자 이름, 이메일, 서버 버전, "연결 해제" destructive), 섹션 "에이전트"(Claude Code, Codex 각각 행: 사용 가능 여부, 버전, 로그인 상태(계정 이메일 또는 "로그인 필요"), 로그인 필요면 "로그인" 버튼 → `AgentLoginView` 시트), 섹션 "정보"(앱 버전, 프로토콜 1).
- `AgentLoginView.swift` + `LoginFlowModel.swift`:
  - 시작 시 `startLogin(agent:)`. 응답의 `instructions`를 본문으로, "링크 열기" 버튼(`openURL`)과 URL 복사 버튼.
  - `needsCode == true`(Claude): 코드 입력 필드 + "코드 제출" → `submitLoginCode`. `needsCode == false`(Codex): instructions에 포함된 코드가 눈에 띄도록 본문을 그대로 크게 표시하고 "코드 복사"(instructions에서 `[A-Z0-9]{4}-[A-Z0-9]{4}` 패턴을 찾아 복사, 없으면 버튼 숨김).
  - 2초 간격으로 `loginStatus` 폴링. `done` → "로그인 완료" + `appState.refreshMe()` 후 닫기. `error` → 메시지와 "다시 시도". 501/`agent_unavailable` → "이 서버에서는 앱 로그인을 지원하지 않습니다. SSH로 접속해 `claude setup-token` 또는 `codex login`을 실행하세요."
  - 화면이 사라지면 폴링 중단.

### 5. 문구·접근성

`docs/IOS.md` 5.5를 따른다. 모든 버튼에 동사형 라벨, 아이콘만 있는 버튼은 `accessibilityLabel`. 문자열은 `String(localized:)`로 감싸 `Localizable.xcstrings`에 수집되게 한다(`SWIFT_EMIT_LOC_STRINGS`가 켜져 있다).

### 6. 테스트 (`ios/MacAgentTests/Features/`)

- `AppStateTests.swift`: 스텁 `URLProtocol`로 `/me` 성공 → `.connected`, 403 → `.failed`(등록 안내 문구), 저장된 서버 없음 → `.disconnected`, `disconnect()`가 설정을 지움.
- `LoginFlowModelTests.swift`: needsCode true 흐름(start → code 제출 → pending → done), needsCode false 흐름, error, 501 매핑, 폴링 중단. 폴링 간격은 주입한 `sleep`으로 제어.
- `ConnectModelTests.swift`: normalize 오류 메시지 매핑.

## Acceptance Criteria

```bash
cd ios && xcodegen generate --quiet && xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet test && cd ..
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - `docs/IOS.md` 4절의 시작 흐름(저장된 서버 자동 연결 → 실패 시 이유 표시)을 따르는가?
   - 5.5 문구 규칙(문장형, 원인 + 다음 행동, 시스템 용어 노출 금지)을 지키는가?
   - 화면 코드가 `Features/<기능>/` 아래에, 전역 상태는 `AppState` 하나에 있는가?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- 여러 서버 저장·전환 UI를 만들지 마라. 이유: Phase 1 범위는 서버 1개다(IOS.md 9절).
- 비밀번호·토큰 입력 UI를 만들지 마라. 이유: 인증은 Tailscale 신원이고 로그인 코드는 일회성이다. 로그인 코드는 저장하지 않는다.
- 세션 목록·타임라인 화면을 미리 만들지 마라(step 4, 5). 자리표시자만 둔다.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
