# Step 8: ipad-polish-device

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/IOS.md` (4절 iPad 3열, 5절 디자인·문구·접근성, 8절 UI 테스트)
- `/docs/RUNBOOK.md` (사용자 온보딩 절. iPhone 설치 절을 추가한다)
- `/ios/project.yml`, `/ios/MacAgent/App/*.swift`, `/ios/MacAgent/Features/**` (step 0~7 전부)
- `/scripts/dev-smoke.sh` (`--keep`, `MAM_DEV_PORT`), `/scripts/test.sh`

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

iPad 레이아웃, 접근성과 다크모드 점검, 앱 아이콘, 실기기 설치 안내, 그리고 개발 서버에 붙는 UI 테스트 1개로 Phase 1을 마감한다.

### 1. iPad (`App/RootView.swift`, `App/SplitRootView.swift`)

- `horizontalSizeClass == .regular`면 `NavigationSplitView(columnVisibility:)` 3열: 사이드바 `SessionsHomeView`(선택 상태를 `AppState.selectedSessionId`로), 콘텐츠 `TimelineView(sessionId:)`(선택 없으면 `ContentUnavailableView("세션을 선택하세요")`), 디테일 `FileBrowserView`(선택 세션의 cwd. 타임라인 툴바 "파일" 버튼은 regular에서 디테일 열 토글로 동작). compact는 기존 `NavigationStack` 그대로.
- 회전·멀티태스킹 크기 변화 시 상태가 유지되어야 한다(모델은 `AppState`가 세션별로 보관: `timelineModels[sessionId]`, 최대 5개 LRU).

### 2. 접근성·다크모드·Dynamic Type

- 아이콘만 있는 모든 버튼에 `accessibilityLabel`. 타임라인 카드는 `accessibilityElement(children: .combine)` + 요약 라벨("도구 실행 npm test, 완료").
- 승인 배너 버튼은 `accessibilityHint`("이 명령 실행을 허용합니다").
- Dynamic Type `.accessibility3`에서 컴포저·배너·세션 행이 잘리지 않는지 시뮬레이터에서 확인(`xcrun simctl ui booted content_size extra-extra-extra-large`). 필요한 곳에 `ViewThatFits` 또는 세로 배치 폴백.
- 다크모드 전 화면 스크린샷 점검(`xcrun simctl ui booted appearance dark`). 커스텀 색이 없으므로 대비 문제가 있으면 시스템 색 선택을 바꾼다.
- `accessibilityReduceMotion`이면 배너 애니메이션 없음(step 6 확인).

### 3. 앱 아이콘과 런치

- `ios/scripts/make-icon.swift`(CoreGraphics, `swift ios/scripts/make-icon.swift`로 실행): 1024×1024 PNG. 디자인: 시스템 파랑(`#0A84FF`에 해당하는 UIColor.systemBlue 값) 배경 위에 흰색 두꺼운 프롬프트 막대(`▍` 형태의 둥근 사각형)와 그 오른쪽 아래 작은 흰 점(커서). SF Symbols 이미지를 아이콘에 쓰지 않는다(라이선스). 결과를 `Assets.xcassets/AppIcon.appiconset/AppIcon.png`에 넣고 `Contents.json`의 iOS 단일 1024 슬롯에 연결.
- 런치 화면은 `UILaunchScreen`(빈 시스템 배경) 유지.

### 4. 빈 상태·오류 문구 점검

`docs/IOS.md` 5.5 기준으로 모든 `ContentUnavailableView`, 오류 문자열, 버튼 라벨을 훑어 통일한다(동사형, 원인 + 다음 행동). `Localizable.xcstrings`에 누락 없이 수집되는지 `SWIFT_EMIT_LOC_STRINGS` 빌드 후 확인.

### 5. UI 테스트 (`ios/MacAgentUITests/`)

- `project.yml`에 `MacAgentUITests`(`bundle.ui-testing`, 의존 `MacAgent`) 타깃 추가, 스킴 test 액션에 포함.
- `ApprovalFlowUITests.swift`: 환경변수 `MAM_UI_TEST_SERVER`가 없으면 `XCTSkip`. 있으면: 앱 실행(`launchEnvironment`로 서버 주소 전달 → 앱은 이 값이 있으면 저장된 설정 대신 사용) → 연결됨 → `+` → 에이전트 Claude, 경로는 "다른 경로"에 `~/.mam` 입력(agent-host가 시작 시 만드는 디렉토리라 항상 존재한다. UI 테스트는 서버 쪽 파일시스템을 건드릴 수 없으므로 새 디렉토리를 만들지 않는다) → 세션 시작 → 컴포저에 "hello" → 보내기 → 배너 "허용" 버튼 존재(타임아웃 30초) → 탭 → "허용됨" 텍스트 존재 → 완료 행(`초 ·` 포함 텍스트) 존재. 접근성 식별자(`accessibilityIdentifier`)를 컴포저·보내기·배너 버튼에 붙인다.
- `scripts/test.sh`는 그대로 두되, UI 테스트는 서버 없으면 skip이므로 게이트가 느려지지 않는다.

### 6. 문서

- `docs/RUNBOOK.md`에 "iPhone에 설치" 절: Xcode에서 `ios/Local.xcconfig`의 `DEVELOPMENT_TEAM` 설정 → 기기 연결 → 개발자 모드 켜기 → 실행 → 설정 > 일반 > VPN 및 기기 관리에서 신뢰 → 무료 계정은 7일마다 재설치 → iPhone에 Tailscale 앱 설치·로그인 → 앱에 `https://<magicdns 호스트>` 입력. TestFlight는 Phase 3.
- `README.md` iOS 절: 시뮬레이터 실행, 개발 서버, UI 테스트 실행 명령.

## Acceptance Criteria

```bash
cd ios && xcodegen generate --quiet && xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet test && cd ..
# iPad 빌드
cd ios && xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M4)' -quiet build && cd ..
# UI 테스트 (개발 서버 필요)
bash scripts/dev-smoke.sh --keep >/tmp/mam-ui-server.log 2>&1 &
SERVER_PID=$!
sleep 20
cd ios && MAM_UI_TEST_SERVER=http://127.0.0.1:7777 xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet test -only-testing:MacAgentUITests && cd ..
kill $SERVER_PID; sleep 3; pgrep -f "agent-host --socket" && exit 1 || true
test -f ios/MacAgent/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png
bash scripts/test.sh
```

iPad 시뮬레이터 이름이 다르면 `xcrun simctl list devices available | grep iPad`에서 iOS 26 런타임의 iPad 하나로 바꿔 쓰고 summary에 적어라.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - `docs/IOS.md` 4절의 iPad 3열 배치와 compact 흐름이 모두 동작하는가?
   - 접근성 라벨·Dynamic Type·다크모드·reduce motion 점검 결과가 summary에 있는가?
   - UI 테스트가 서버 없이는 skip되어 게이트를 막지 않는가?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- 실기기에 설치를 시도하지 마라(연결된 기기가 없고 사람의 승인이 필요하다). 문서만.
- TestFlight·App Store Connect·APNs 설정을 하지 마라(Phase 3).
- SF Symbols 렌더링을 앱 아이콘 이미지로 쓰지 마라(Apple 라이선스). 단순 도형만.
- 위젯·Live Activity·멀티윈도우를 추가하지 마라(IOS.md 9절).
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
