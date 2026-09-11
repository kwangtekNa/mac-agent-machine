# IOS: MacAgent 앱 설계

iOS 앱의 구조, 화면, 디자인 시스템, 테스트 방식. `docs/PROTOCOL.md`가 데이터 계약이라면 이 문서는 그 위에 올라가는 앱의 계약이다. Phase 1의 모든 step이 이 문서를 따른다.

## 1. 한 줄 정의

이동 중에 iPhone으로 Mac 위의 에이전트 세션을 **읽고, 지시하고, 승인하고, 결과 파일을 확인하는** 앱. 터미널이 아니라 타임라인이다. 가장 자주 쓰는 동작은 "진행 상황 훑어보기"와 "승인 버튼 누르기"이며, 이 둘이 한 손 조작으로 끝나야 한다.

## 2. 기술 결정

| 항목 | 결정 |
|---|---|
| 이름 / 번들 ID | `MacAgent` / `dev.mam.MacAgent` (`ios/project.yml`의 `bundleIdPrefix: dev.mam`) |
| 최소 버전 | iOS 17.0. `@Observable`, `NavigationSplitView`, `AttributedString` 사용 |
| 언어 | Swift 6, strict concurrency `complete`. UI는 `@MainActor` |
| 프로젝트 | XcodeGen `ios/project.yml`. `*.xcodeproj`는 생성물(gitignore). 소스는 디렉토리 기반 자동 수집 |
| 서명 | `ios/Local.xcconfig`(gitignore)의 `DEVELOPMENT_TEAM`. 예시 파일 `ios/Local.xcconfig.example` 커밋 |
| 패키지 | SwiftPM 두 개만: `swift-markdown-ui`(에이전트 메시지 렌더링), `Highlightr`(파일 뷰어 하이라이트). 네트워킹·상태관리 패키지 없음 |
| 네트워킹 | `URLSession` + `URLSessionWebSocketTask`. JSON은 `Codable`, 날짜는 ISO-8601(소수점 초 허용) |
| 상태 | `@Observable` 클래스. 화면당 하나의 모델. 전역은 `AppState` 하나 |
| 테스트 | XCTest. 모델·클라이언트·뷰모델 단위 테스트 + fixture 디코딩 계약 테스트. UI 테스트는 step 8에서 1개 |
| 시뮬레이터 | iPhone 17 Pro (iOS 26.2). 개발 서버는 `bash scripts/dev-smoke.sh --keep`(`http://127.0.0.1:7777`) |

## 3. 디렉토리

```
ios/
├── project.yml
├── Local.xcconfig.example          # DEVELOPMENT_TEAM = XXXXXXXXXX
├── MacAgent/
│   ├── App/                         # MacAgentApp.swift, AppState.swift, RootView.swift
│   ├── Models/Protocol/             # PROTOCOL.md 미러 (Session, TimelineItem, Approval, ServerEvent, ClientMessage, REST)
│   ├── Networking/                  # APIClient, SessionSocket, ServerConfigStore, JSONCoding
│   ├── Features/
│   │   ├── Connect/                 # 서버 주소 입력, /me 확인
│   │   ├── Settings/                # 서버·에이전트 상태·로그인 플로우
│   │   ├── Sessions/                # 프로젝트·세션 목록, 새 세션 시트
│   │   ├── Timeline/                # 세션 화면: 카드, 컴포저, 모드 메뉴
│   │   ├── Approvals/               # 승인 배너, 승인 시트, 입력 폼
│   │   └── Files/                   # 파일 브라우저, 파일 뷰어, diff 뷰
│   ├── Shared/                      # ItemStyle(아이콘·색), 공용 뷰, 포맷터, 햅틱
│   └── Resources/                   # Assets.xcassets, Localizable.xcstrings
└── MacAgentTests/                   # 단위 테스트. fixtures 폴더 참조(../packages/protocol/fixtures)
```

## 4. 내비게이션

iPhone(compact):

```
ConnectView ──(연결 성공)──▶ SessionsHome
                               ├─ 프로젝트 목록 (섹션) ─▶ 프로젝트의 세션 목록
                               ├─ 최근 세션
                               ├─ [+] 새 세션 시트 (에이전트 · 디렉토리 · 모드)
                               └─ 세션 ─▶ TimelineView
                                            ├─ 툴바: 파일(시트) · 모드 메뉴 · 세션 정보
                                            ├─ 승인 배너 (있을 때만, 컴포저 위에 고정)
                                            └─ 컴포저 (보내기 / 중단)
                               └─ 설정 (툴바 기어)
```

iPad(regular): `NavigationSplitView` 3열. 사이드바 = 프로젝트·세션, 콘텐츠 = 타임라인, 디테일/인스펙터 = 파일 브라우저. 승인 배너와 컴포저는 타임라인 열 하단.

앱 실행 시 저장된 서버가 있으면 `/me`를 조용히 확인하고 바로 SessionsHome을 연다. 실패하면 ConnectView에 이유를 보여준다.

## 5. 디자인 시스템 (애플 네이티브)

원칙: 시스템이 주는 것을 쓰고, **이벤트 종류를 색과 아이콘으로 구분하는 것**에만 의견을 싣는다. 기억에 남아야 할 요소는 하나, 승인 배너다. 나머지는 조용하게.

### 5.1 타이포그래피

- 시스템 폰트, Dynamic Type 스타일만 사용(`.body`, `.subheadline`, `.caption`, `.headline`). 고정 포인트 크기 금지.
- 코드·경로·명령은 `.system(.body, design: .monospaced)` 또는 `.caption.monospaced()`. 코드블록은 가로 스크롤, 줄바꿈 토글은 파일 뷰어에만.
- 카드 제목은 한 줄, 넘치면 말줄임. 본문 마크다운은 MarkdownUI 기본 테마를 `.gitHub` 기반으로 하되 폰트는 시스템.

### 5.2 아이템 종류별 스타일 (`Shared/ItemStyle.swift`에 단일 정의)

| kind / tool | SF Symbol | 색(시스템 색) | 기본 상태 |
|---|---|---|---|
| user_message | 없음 | `accentColor` 배경 10%, 오른쪽 정렬 없이 왼쪽 정렬 + 굵은 "나" 라벨 없음, 그냥 옅은 배경 | 펼침 |
| assistant_message | 없음 | 배경 없음, 본문 | 펼침 |
| reasoning | `brain` | `.secondary` | 접힘, "생각 요약" 한 줄 |
| tool_call · bash | `terminal` | `.gray` | 제목 한 줄, 출력 접힘 |
| tool_call · read/glob/grep | `doc.text.magnifyingglass` | `.gray` | 접힘 |
| tool_call · write/edit | `pencil.line` | `.orange` | 접힘 |
| tool_call · web | `globe` | `.blue` | 접힘 |
| tool_call · mcp | `puzzlepiece.extension` | `.purple` | 접힘 |
| tool_call · task | `person.2` | `.indigo` | 접힘 |
| tool_call · other | `wrench.and.screwdriver` | `.gray` | 접힘 |
| file_change | `plus.forwardslash.minus` | `.teal` | 파일 목록 펼침, diff 접힘 |
| plan | `checklist` | `.mint` | 펼침 |
| approval (대기) | `hand.raised.fill` | `.yellow` 배경(카드 전체), 텍스트 `.primary` | 펼침, 버튼 노출 |
| approval (처리됨) | `hand.raised` | `.secondary` | 한 줄 요약 "허용됨 · 12:03" |
| turn_summary | `clock` | `.secondary` | 한 줄: `12초 · 1.2k 토큰 · $0.03` |
| error | `exclamationmark.triangle.fill` | `.red` | 펼침 |
| system | `info.circle` | `.secondary` | 한 줄 캡션 |

상태 표시: `running`은 아이콘 옆 `ProgressView().controlSize(.mini)`, `failed`는 아이콘을 `.red`, `cancelled`는 취소선 없이 `.secondary` + "취소됨".

### 5.3 레이아웃

- 타임라인은 `ScrollView` + `LazyVStack(spacing: 12)`. 카드는 `RoundedRectangle(cornerRadius: 12)`에 `.background(.thinMaterial)` 대신 `Color(.secondarySystemGroupedBackground)`. 그림자 없음.
- 카드 내부 여백 12pt, 아이콘 열 24pt 고정, 제목·본문은 왼쪽 정렬. 시간은 카드 오른쪽 위 `.caption2 .secondary`.
- 자동 스크롤: 사용자가 바닥에 있을 때만 새 이벤트를 따라간다. 위로 올라가 있으면 "새 이벤트 ↓" 작은 칩을 하단에 띄운다.
- 승인 배너: 컴포저 바로 위에 `.yellow.opacity(0.18)` 배경, 왼쪽 `hand.raised.fill`, 제목(굵게)·prompt 한 줄, 오른쪽에 옵션 버튼(`primary`는 `.borderedProminent`, `secondary`는 `.bordered`, `destructive`는 `.bordered` + `.tint(.red)`). 버튼이 3개를 넘으면 처음 2개 + "더 보기". 도착 시 `UINotificationFeedbackGenerator(.warning)` 햅틱 1회. 배너 등장은 아래에서 올라오는 애니메이션 1회, 그 외 애니메이션 없음.
- 컴포저: `TextField(axis: .vertical)` 1~6줄, 오른쪽 버튼은 `running`이면 `stop.circle.fill`(중단), 아니면 `arrow.up.circle.fill`(보내기). 연결 끊김이면 비활성 + 위에 "다시 연결 중…" 캡션.

### 5.4 색과 다크모드

시스템 색만 쓴다(`.yellow`, `.orange`, `.teal`, `.red`, `.gray`, `.secondary`, `Color(.systemGroupedBackground)` 계열). 커스텀 hex 없음. 다크모드는 자동. 접근성 "색 구분 없이"를 위해 색은 항상 아이콘과 함께 쓴다.

### 5.5 문구

한국어, 문장형, 짧은 동사. 버튼은 일어날 일을 그대로: `허용`, `거절`, `이 세션에서 항상 허용`, `중단`, `보내기`, `새 세션`, `연결`. 오류는 원인과 다음 행동을 한 문장씩: "서버에 연결할 수 없습니다. Tailscale이 켜져 있는지 확인하세요." 빈 화면은 행동 유도: "아직 세션이 없습니다. 오른쪽 위 + 로 시작하세요." 시스템 용어(`whois`, `agent-host`)는 사용자 문구에 쓰지 않는다. 문자열은 `Localizable.xcstrings`에 두고 코드에는 키 대신 한국어 원문을 `String(localized:)`로 쓴다.

## 6. 상태와 데이터 흐름

- `AppState`(`@Observable`, 앱 전역): `serverConfig`, `me`, `connectionState`(`.disconnected | .connecting | .connected(MeResponse) | .failed(String)`), `apiClient`.
- `SessionsStore`: 세션 목록·프로젝트 목록, 새로고침, 생성, 닫기. 세션 row의 `pendingApprovals`로 배지.
- `TimelineModel`(세션당 1개, 화면이 살아있는 동안 유지): `items: [TimelineItem]`(seq 순), `pendingApprovals`, `status`, `mode`, `connection`, `lastSeq`. `apply(_ event: ServerEvent)`가 유일한 변경 경로:
  - `session.snapshot` → items 교체(`truncated`면 상단에 "이전 기록 더 있음" 행), pendingApprovals 교체, session 갱신
  - `item.started` → 추가(같은 id 있으면 교체), `item.delta` → 해당 필드에 append, `item.completed` → 교체
  - `approval.requested` → pending 추가, `approval.resolved` → pending 제거 + 해당 approval 아이템에 resolution 반영
  - `session.status` → status/mode, `turn.completed` → 아무것도 안 함(turn_summary 아이템이 따로 온다), `error` → 임시 오류 행(recoverable) 또는 상단 배너
- `SessionSocket`: 연결 → 이벤트 `AsyncStream` → `TimelineModel.apply`. 끊기면 1s→2s→…30s 백오프로 `since=lastSeq` 재접속. 20초마다 `ping`. 앱이 백그라운드로 가면 소켓을 닫고, 포그라운드 복귀 시 `since`로 재접속(놓친 이벤트는 재생된다).
- 보내기: `turn.start`는 낙관적으로 `user_message` 아이템을 그리지 않는다. 서버가 `item.started user_message`를 보내므로 그것을 기다린다(중복 방지). 대신 컴포저를 비우고 보내는 중 표시.

## 7. 오류·엣지

- WS `error{recoverable:true}`("session is busy" 등)는 컴포저 위 캡션으로 3초 표시.
- 세션 `status == .error`면 타임라인 상단에 빨간 배너 + "다시 시도"(새 `turn.start`가 서버 측 재개를 트리거).
- 파일 뷰어 `truncated`면 상단에 "앞 1 MiB만 표시" 배너. 415는 "미리 볼 수 없는 파일 형식".
- 403(홈 밖)은 UI에서 발생하지 않아야 하지만 오면 "접근할 수 없는 경로".
- 승인이 여러 개 대기 중이면 배너는 가장 오래된 것 하나를 보여주고 "외 2건" 표시. 다른 클라이언트가 처리하면(`approval.resolved`) 배너가 즉시 사라진다.
- `full-auto` 모드 전환은 `confirmationDialog`로 "에이전트가 확인 없이 명령을 실행하고 파일을 수정합니다" 경고 후 적용.

## 8. 테스트 전략

- 계약: `MacAgentTests/ProtocolFixturesTests.swift`가 번들의 `fixtures/` 폴더 참조를 순회해 파일명 → 타입 표로 전부 디코딩한다. 표에 없는 fixture 파일이 있으면 실패(TS 쪽 테스트와 대칭). 클라이언트 메시지는 인코딩 결과를 fixture와 딕셔너리 비교.
- 단위: `TimelineModel.apply` 시나리오(스냅샷→델타→완료→승인→해결, seq 순서, 중복 id), `SessionSocket` 재접속 상태기계(가짜 transport), `APIClient`(`URLProtocol` 스텁), 배너 옵션 렌더링 규칙, 파일 브라우저 모델.
- UI: step 8에서 XCUITest 1개. `bash scripts/dev-smoke.sh --keep`으로 띄운 개발 서버(`MAM_UI_TEST_SERVER=http://127.0.0.1:7777` 환경변수)에 연결 → 새 세션 → "hello" 전송 → 승인 배너 표시 → 허용 → 완료 행 확인.
- 게이트: `scripts/test.sh`가 `ios/project.yml`을 보고 `xcodegen generate && xcodebuild test -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro'`를 돌린다. `MAM_TEST_SKIP_IOS=1`로 생략 가능.

## 9. 2차 추가분 (2026-09-10, Phase `2-usage-and-files`)

첫 실기기 사용 후 나온 요구: 파일 목록이 작업 중에 보여야 하고, 작업 디렉토리를 고를 때 폴더를 만들 수 있어야 하며, 컨텍스트·사용량·모델을 볼 수 있어야 한다.

### 9.1 세션 화면의 "대화 | 파일" 세그먼트

- 세션 화면 상단(내비게이션 바 바로 아래)에 `Picker(.segmented)`: **대화** / **파일**. 파일 쪽 라벨은 이 세션에서 변경된 파일 수를 붙인다(`파일 3`). 변경 수는 타임라인의 `file_change` 아이템에서 경로를 모아 센다(클라이언트 계산, 프로토콜 변경 없음). 0이면 그냥 "파일".
- 파일 탭은 지금의 `FileBrowserView`를 시트가 아니라 **인라인**으로 보여준다(루트 = 세션 cwd). 탭을 오가도 탐색 위치가 유지된다(`FileBrowserModel`은 `AppState`가 세션별로 보관). 툴바의 폴더 아이콘은 없앤다.
- 인라인 파일 탭은 세션 화면(바깥 `NavigationStack`) 안에 놓이므로 자체 `NavigationStack`을 중첩하지 않는다(중첩하면 세그먼트를 탭할 때 세션 화면이 pop 된다). 같은 자리에서 목록을 교체하는 제자리 탐색이며, 목록 위 헤더에 현재 폴더 이름·경로와 "‹ 상위 폴더" 버튼을 두고 위치는 `FileBrowserModel.stack`으로 유지한다. 파일은 시트로 연다. 시트·iPad 디테일 열의 push 탐색은 그대로다.
- 대화 탭의 컴포저와 승인 배너는 파일 탭에서도 하단에 그대로 남는다(승인을 놓치지 않게).
- iPad(regular)는 3열 그대로이며 세그먼트는 숨긴다.

### 9.2 디렉토리 피커와 새 폴더

- 새 세션 시트의 "디렉토리" 행은 세 가지 진입점: 프로젝트 목록에서 선택, **찾아보기**(`DirectoryPickerView`), 직접 입력.
- `DirectoryPickerView`: 홈(`~`)에서 시작하는 디렉토리 전용 브라우저(`FileBrowserModel`의 dirs-only 모드, 숨김 폴더 토글, git 배지). 하단 고정 버튼 "이 폴더 선택". 툴바 **새 폴더** → 이름 입력 알림 → `POST /fs/mkdir` → 만든 폴더로 들어간다. 이름 검증(빈 값, `/`, 제어 문자)은 제출 전에 막고 서버 400/409 메시지도 그대로 보여준다.

### 9.3 컨텍스트·사용량·모델

- **컨텍스트 게이지**: 세션 화면 제목 아래 부제를 `컨텍스트 21% · 42k/200k`로 바꾸고 얇은 `ProgressView(value:)`를 붙인다. 색은 60% 미만 기본(`.tint`), 60% 이상 `.yellow`, 85% 이상 `.red`. `usage.context`가 `null`이면 부제는 기존 상태 텍스트. 탭하면 세션 정보 시트.
- **세션 정보 시트** 확장: 섹션 "사용량"(입력·출력·캐시 읽기·캐시 쓰기 토큰, 비용, 턴 수, 마지막 갱신), 섹션 "모델"(`GET /models`로 채운 `Picker`, 변경 즉시 `PATCH`), 섹션 "사고 수준"(선택 모델의 `efforts`가 비어 있지 않을 때만, `PATCH`), 섹션 "구독 한도"(요약 두 줄 + "설정에서 자세히").
- **설정 > 구독 사용 한도**: 에이전트별 카드. 요금제 이름, 창마다 `ProgressView`와 `42% · 3시간 후 초기화`. Claude는 `live: false`라 "마지막 관측 HH:mm" 캡션, Codex는 새로고침 버튼으로 즉시 재조회. `warning`은 노랑, `exceeded`는 빨강 + "한도 도달". 화면 등장 시 1회 조회, 이후 60초마다.
- 숫자 표기: 토큰은 `Formatters.tokens`(1.2k, 3.4M), 비용은 `$0.42`, 초기화 시각은 상대 시간.

## 10. 범위 밖 (Phase 1)

- 파일 편집·업로드, 터미널, 푸시 알림(APNs, Phase 3), 여러 서버 동시 관리(서버 1개만 저장), 세션 검색, 위젯·Live Activity, iPad 멀티윈도우.
