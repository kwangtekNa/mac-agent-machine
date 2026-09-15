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
│   │   ├── Files/                   # 파일 브라우저, 파일 뷰어, diff 뷰
│   │   ├── Teams/                   # 팀 목록 행, 새 팀 시트, 팀원 편집기, 팀 설정, 방 목록, TeamsStore (10절)
│   │   ├── Rooms/                   # 방 화면, 컴포저, RoomModel, 멘션 파서, 방 카드(Cards/) (10절)
│   │   └── Preview/                 # localhost 링크 변환, 앱 안 브라우저, 포트 시트 (12절)
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
                               ├─ [+] 메뉴: 새 세션 시트 (에이전트 · 디렉토리 · 모드) · 새 팀 시트 (10.1)
                               ├─ 팀 (섹션) ─▶ TeamRoomsView (#전체 · DM 목록, 툴바: 중단 · 팀 설정)
                               │                └─ 방 ─▶ RoomView
                               │                          ├─ 승인 배너 · 상태 줄("중단") · 컴포저(멘션 제안)
                               │                          └─ 작업 요약 카드 ─▶ 팀원 TimelineView
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
- 자동 스크롤: 사용자가 바닥에 있을 때만 새 이벤트를 따라간다. 위로 올라가 있으면 "새 이벤트 ↓" 작은 칩을 하단에 띄운다. 방·타임라인은 열릴 때 최신 메시지가 보이도록 `.defaultScrollAnchor(.bottom)`(iOS 17+)을 쓴다.
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

## 10. 3차 추가분 (2026-09-12, Phase `4-teams-ios`)

서버 Phase 3 의 에이전트 팀(`docs/PROTOCOL.md` 6절, ADR-017)을 폰에서 쓰기 위한 화면. 팀을 꾸리고, 방에서 `@멘션`으로 지시하고, 승인과 머지를 방 안에서 끝낸다. 팀원은 보통 세션이므로 팀원 타임라인은 기존 `TimelineView` 를 그대로 쓴다. 프로토콜은 바꾸지 않았다(방 이벤트는 세션 WS 와 별도 스트림).

### 10.1 세션 홈의 팀

- **"팀" 섹션**(진행 중 아래, 프로젝트 위): `TeamRow`(이름 · cwd · 팀원 이모지 · 활동 상태). 팀이 없으면 "아직 팀이 없습니다. + 에서 새 팀을 만드세요." 세션 목록과 함께 15초마다 새로고침.
- **`+` 는 메뉴**: "새 세션"(기존 시트) / "새 팀". 라벨과 식별자(`home.add`, `home.newSession`)는 유지한다(UI 테스트가 누른다).
- **팀원 세션의 팀 배지**: 세션 행 캡션과 타임라인 부제 앞에 `🧑‍💻 지연 · backend`(`TeamsStore.badge`, `Session.team` 조인).
- **새 팀 시트**(`NewTeamSheet`): 템플릿(있을 때) → 이름 → 디렉토리(새 세션과 같은 `DirectoryFormSection`, git 저장소여야 한다) → 팀원 → 고급 설정(연쇄 상한 · 동시 실행) → "팀 만들기". 첫 팀원은 자동으로 팀장, 행을 밀어 팀장 변경·삭제. 제출 규칙은 `NewTeamFormState`(이름 1~60, 디렉토리, 팀원 1명 이상, 팀장 정확히 1명, 팀원 검증 통과) 이고 막히는 이유를 버튼 아래 캡션으로 보여준다. 만든 뒤 방 목록으로 push(iPad 는 사이드바 선택).
- **팀원 편집기**(`MemberEditorView`): 역할 피커 = 서버 프리셋("기본 프리셋", `GET /team-roles`) + 앱 로컬 프리셋("내 프리셋", `RolePresetStore` UserDefaults). 이름(`@멘션`에 쓰인다. `@`·공백 금지, 팀 안에서 유일) · 이모지 한 글자 · 에이전트(Claude/Codex, `/me` 로 사용 가능 여부) · 모드 `ask / auto-edit / plan / full-auto`(`full-auto` 는 7절과 같은 확인 다이얼로그 뒤에만, 10.8) · 모델 · 사고 수준(10.8) · 지시문 · 팀장 토글. 커스텀 역할은 "프리셋으로 저장". 기존 팀원 편집은 `PATCH` 가 받는 필드만(역할·에이전트·팀장 고정), 지시문·모델을 바꾸면 "다음 세션부터 적용됩니다(기억 초기화로 바로 적용)" 캡션.
- **팀 설정**(`TeamSettingsView`): 이름·설정 저장, 팀원 편집·기억 초기화·제거·추가, 작업 전부 중단, 팀 삭제. 삭제·제거가 409(커밋되지 않은 worktree 변경)면 "worktree 남기고 삭제" 알림으로 `keepWorktrees=true`(팀원은 `keepWorktree=true`) 재시도.

### 10.2 방 목록과 방 화면

- **방 목록**(`TeamRoomsView`): `#전체` 먼저(마지막 메시지 상대 시간), DM 은 팀원 순서(`MemberChip` + 상태 점 + 팀장 캡션). 상태는 세션 목록의 팀원 세션 status 매핑(`MemberStatus`), 없으면 서버 `member.state`. 툴바: 작업 전부 중단(확인 대화상자), 팀 설정(compact 는 push, iPad 는 시트).
- **방 화면**(`RoomView` → `RoomScreen`): 타임라인과 같은 골격(바닥 앵커, 위로 올라가 있으면 "새 메시지" 칩, `safeAreaInset` 에 승인 배너 + 상태 줄 + 컴포저, 백그라운드에서 소켓 닫고 복귀 시 `since` 재접속). 제목은 `#전체` 또는 팀원 칩 + 팀 이름. 툴바 팀원 시트(상태·브랜치, 탭하면 `MemberControlSheet`(10.8), 행을 밀면 그 세션의 타임라인).
- **작업 중 말풍선**: 목록 끝에 "지연이 작업 중…"(`ProgressView`) / "민수가 대기 중…"(시계). 답변이 오고 `room.status` 로 상태가 바뀌면 사라진다. **상태 줄**: 컴포저 위 "지연 작업 중 · 민수 대기 중" + **"중단"**(팀 전체 `room.interrupt`). 아무도 일하지 않으면 없다.
- **컴포저**: 그룹방에서 텍스트 끝의 `@토큰` 에 이름·핸들이 맞는 팀원을 제안 칩으로(탭 → `@이름 `), 멘션이 없으면 **팀장 캡션** "팀장 민수에게 전달됩니다", 모르는 `@토큰` 은 "모르는 팀원 @xxx 는 무시됩니다"(우선, 입력 중인 끝 토큰은 제외). DM 은 캡션도 제안도 없다(서버가 멘션을 무시한다). 정지 버튼은 없고, 소켓이 닫혀 있어도 REST 로 보낸다.
- **길게 눌러 답장**: 에이전트 메시지 컨텍스트 메뉴 "@이름에게 답장"(컴포저 끝에 `@이름 ` 삽입) · 복사.
- **답변은 턴 종료 후 한 번에**(스트리밍 없음). 사용자 메시지도 낙관적으로 넣지 않고 서버의 `room.message` 를 기다린다.
- **승인은 방 배너에서**: 미러링된 승인 카드에는 버튼이 없다. 배너(제목 위 **작성자 캡션** `🧑‍💻 지연 · 개발자`)·시트가 카드의 `sessionId` 로 기존 `POST /sessions/:id/approvals/:approvalId` 를 부르고, 확정은 `room.message.updated` 다. 409/404 는 "이미 처리됨" 을 잠깐 보여주고 방을 다시 읽는다. 세션 화면과 같은 배너를 쓴다(`ApprovalResponding`).

### 10.3 카드

- **작업 요약**(`WorkSummaryCard`): 에이전트 답변 바로 아래 한 줄 `도구 7회 · 파일 3개 변경 · 12초`(+ ` · $0.04 추정`, 파일 0개면 "파일 변경 없음"). 전체가 버튼이며 탭하면 그 팀원의 타임라인(`work.sessionId`, compact push / iPad 디테일 열).
- **승인**(`RoomApprovalCard`): 대기 중은 노란 배경 + `hand.raised.fill` + 팀원 칩 + 타임라인 `ApprovalCard` 와 같은 본문("자세히 보기" → 시트), 해결되면 "허용됨 · 12:03" 한 줄.
- **변경 준비됨**(`ChangesReadyCard`, `.contain` 접근성): 팀원 칩, `mam/backend/jiyeon → main`, 파일 행(최대 5개 + "외 N개"). `ready` → **"<base>에 병합"**(확인 대화상자 "main에 병합합니다. 프로젝트의 작업 트리가 깨끗해야 합니다." 후 `POST .../merge`) + **"거절"**. `merging`/전송 중 → 진행 표시와 버튼 비활성. `merged` → 초록 체크 "병합됨 · a1b2c3d". `conflict` → 빨간 삼각형 + **충돌 파일** + "충돌이 났습니다. 지연이 worktree 에서 해결하면 새 카드가 올라옵니다"(해결 UI 는 없다. 해결은 팀원 턴이 한다). `dismissed` → "거절됨", `stale` → "새 변경으로 대체됨". 상태 확정은 서버 값(응답 ChangeSet 또는 `room.message.updated`)이며 낙관적 갱신은 없다. 서버 409 문구(더러운 작업 트리·다른 브랜치)는 카드 아래 빨간 캡션.

### 10.4 iPad

사이드바에 "팀" 섹션(세션 선택과 배타적). content 열 = 방 목록 → 방 화면(`AppState.selectedRoom` 으로 스택 경로), detail 열 = 팀원 목록(상태·브랜치) → 팀원 타임라인(`AppState.selectedMemberSessionId`). 작업 요약 카드 탭도 detail 열을 바꾼다. 팀 설정은 시트.

### 10.5 상태 흐름

- `TeamsStore`(앱 전역): `/teams` · `/team-templates` · `/team-roles` 를 병렬로 읽고 실패한 쪽은 이전 값을 유지한다. 생성·수정·삭제·팀원 편집은 응답 `Team` 으로 목록을 교체한다(낙관적 갱신 없음). `team(forSession:)` 으로 세션 ↔ 팀원을 조인한다.
- `RoomModel`(방당 1개): `apply(_ event: RoomEvent)` 가 **유일한 변경 경로**. `room.snapshot` → 메시지 upsert · pending · 팀원 상태 · `isReplaying`, `room.message` → id 로 upsert(승인이면 pending 추가 + 햅틱, 재생 중은 제외), `room.message.updated` → id 교체 + pending·mergeSubmit 정리, `room.status` → 팀원 상태·디스패치, `room.error` → recoverable 이면 컴포저 위 3초 캡션, 아니면 상단 배너. `seq ≤ lastSeq` 는 무시(snapshot/pong 은 seq 0). `start()` = `GET /teams/:id`(팀원·방) → `GET /teams/:id/rooms/:roomId` → `since=lastSeq` 로 소켓.
- `AppState` LRU(8): 세션(타임라인 + 파일 브라우저)과 방(`RoomModel`)이 같은 목록에서 오래된 순으로 밀려나며 밀려나면 `stop()`.
- `RoomSocket` = `EventSocket<RoomEvent, RoomClientMessage>`(세션 소켓과 같은 제네릭·정책): 끊기면 1s→2s→…30s 백오프로 `since=lastSeq` 재접속, 20초 `ping`, close 4004(방 없음)는 재접속하지 않고 "방이 없습니다". 세션 이벤트 프레임은 무시한다.

### 10.6 접근성 식별자

UI 테스트 `MacAgentUITests/TeamRoomUITests.swift` 가 누르는 순서대로. `MAM_UI_TEST_SERVER` 와 `MAM_UI_TEST_REPO`(`bash scripts/dev-smoke.sh --keep` 이 출력하는 git 저장소) 가 없으면 `XCTSkip`. 흐름은 새 팀 → `#전체` → 팀원 시트(모델 → 사고 수준 `low` → 권한 `full-auto` 확인, 10.8) → `@지` 제안 칩 → `write file ui.txt` → (full-auto 라 승인 카드 없음, 뜨면 허용) → 작업 요약 → 팀원 타임라인 → "main에 병합" → "병합됨" 이고, 끝에 REST 로 팀을 지운다(`keepWorktrees=true`).

| 식별자 | 위치 |
|---|---|
| `home.newTeam` | 세션 홈 `+` 메뉴의 "새 팀" |
| `teams.row.<teamId>` | 세션 홈 "팀" 섹션의 팀 행 |
| `newTeam.name` · `newTeam.addMember` · `newTeam.submit` | 새 팀 시트의 이름 · "팀원 추가" · "팀 만들기" (디렉토리는 `newTeam.customToggle` 등 `newTeam.*`) |
| `memberEditor.name` · `memberEditor.save` | 팀원 편집기의 이름 · "완료" (역할 `memberEditor.role`, 팀장 `memberEditor.lead`) |
| `rooms.group` · `rooms.dm.<memberId>` | 방 목록의 `#전체` · DM 행 |
| `room.composer.input` · `room.composer.send` | 방 컴포저의 입력 · 보내기 |
| `room.mention.<memberId>` | 컴포저 위 멘션 제안 칩 |
| `room.workSummary.<messageId>` | 에이전트 답변 아래 작업 요약(탭 → 팀원 타임라인) |
| `room.merge.<changeId>` · `room.dismiss.<changeId>` | 변경 준비됨 카드의 "<base>에 병합" · "거절" |
| `newTeam.gitInit` · `newTeam.gitReady` | 새 팀 시트 디렉토리 아래의 "저장소 초기화" · 초기화 뒤 "git 저장소 (main)" 행 (10.7) |
| `directoryPicker.gitInit` | 디렉토리 피커 툴바의 "저장소 초기화"(현재 폴더가 저장소가 아닐 때만) (10.7) |
| `room.members` · `room.member.<memberId>` | 방 툴바의 팀원 시트 · 그 안의 팀원 행(탭 → `MemberControlSheet`) (10.8) |
| `memberControl.mode` · `memberControl.model` · `memberControl.effort` | 팀원 시트의 권한 · 모델 · 사고 수준 피커 (10.8) |
| `memberControl.openTimeline` · `memberControl.reset` | 팀원 시트의 "타임라인 열기" · "기억 초기화" (10.8) |
| `memberEditor.model` · `memberEditor.effort` | 팀원 편집기의 모델 · 사고 수준 피커 (10.8) |

### 10.7 저장소 초기화 (2026-09-13, Phase `5-git-init`)

새 팀은 git 저장소가 필요하다(`POST /teams` 가 400). 고른 디렉토리가 저장소가 아니면 폰에서 그 자리에서 초기화한다(`POST /git/init`, PROTOCOL.md 1절: 기본 `.gitignore` → `git init -b main` → 기존 파일 전부를 첫 커밋에). 모델은 `Features/Files/GitInitFlow.swift`(`GitInitFlow.Phase` `idle → checking → notRepo → previewing → confirming → initializing → done | failed` + `GitInitModel`) 하나이고 두 진입점이 각자 인스턴스를 갖는다. 프로토콜 변경은 `POST /git/init` 추가뿐이다.

- **진입점 1 — 새 팀 시트**: 디렉토리를 고르거나 직접 입력이 멈추면(600ms 디바운스) `GET /git/status` 로 확인한다. 저장소가 아니면 디렉토리 섹션 아래에 주황 "git 저장소가 아닙니다" 행 + **"저장소 초기화"**(`newTeam.gitInit`) 가 나오고 "팀 만들기" 는 막힌다(캡션 "git 저장소가 아닙니다. 먼저 저장소를 초기화하세요."). 초기화가 끝나면 같은 자리가 초록 "git 저장소 (main)" + "git 저장소를 만들었습니다 (main, 파일 N개)"(`newTeam.gitReady`) 로 바뀌고 제출할 수 있다. 이미 저장소인 경로(피커에서 초기화하고 고른 폴더 포함)는 아무 행도 보이지 않는다. 서버가 `POST /teams` 에 400 "git 저장소가 아닙니다" 를 주면 다시 확인해 같은 행을 띄운다.
- **진입점 2 — 디렉토리 피커**: 현재 폴더의 `isGitRepo == false` 일 때만 툴바에 `arrow.triangle.branch` **"저장소 초기화"**(`directoryPicker.gitInit`). 서버의 `isGitRepo` 는 상위 저장소 안의 하위 폴더도 true 라 중첩 저장소는 만들 수 없다. 끝나면 목록을 다시 읽어 버튼이 사라지고 목록 위에 초록 체크 "git 저장소를 만들었습니다 (main, 파일 N개)" 안내가 남는다. 그대로 "이 폴더 선택" 을 누르면 새 팀 시트가 보통 저장소로 받아들인다.
- **확인 문구 규칙**: 초기화는 항상 `dryRun` 미리보기 → `confirmationDialog`("git 저장소를 만들까요?") → 실제 초기화 순서다(기존 파일 전부가 첫 커밋에 담기는 되돌리기 어려운 동작이라 확인 없이 초기화하지 않는다). 본문은 `GitInitFlow.confirmMessage`: 파일이 있으면 "파일 12개 · 47 KB를 첫 커밋에 담습니다.", 없으면 "빈 저장소를 만듭니다.", 기본 `.gitignore` 를 만들 때만 "기본 .gitignore 를 만듭니다." 를 덧붙인다. 버튼은 "초기화" / "취소". 취소는 "저장소 아님" 상태로 돌아간다.
- **오류**: 409(이미 저장소·상위가 저장소)는 "이미 git 저장소입니다." 를 보인 뒤 다시 확인해 저장소면 조용히 통과, 400 은 서버 문구 그대로, 403 은 홈 밖 경로 문구, 그 외는 공통 매핑. 경로가 바뀐 뒤 늦게 온 응답은 버린다.
- **UI 테스트** `MacAgentUITests/GitInitUITests.swift`(`MAM_UI_TEST_SERVER` 없으면 `XCTSkip`): (1) 새 팀 → 찾아보기 → 새 폴더 `ui-git-<ts>` → 피커 초기화 → 확인("빈 저장소") → 안내 → 이 폴더 선택 → 팀장 1명 → 팀 만들기 → `rooms.group`. 정리는 REST 팀 삭제(409 면 `keepWorktrees=true`) + 폴더 삭제. (2) 직접 입력에 새 빈 폴더(`MAM_UI_TEST_REPO` 의 부모에 만든다) → `newTeam.gitInit` → 초기화 → "git 저장소 (main)" 로 바뀌고 버튼이 사라진다.

### 10.8 팀원 권한·모델·사고 수준 (2026-09-13, Phase `6-member-controls`)

팀원을 만들 때와 그 뒤 언제든 권한(모드)·모델·사고 수준을 바꾼다. 진입점은 팀원 편집기(생성·팀 설정)와 방의 팀원 시트. 프로토콜 변경 없음(`PATCH /teams/:id/members/:memberId`, `GET /models?agent=`).

- **모드**: `MemberDraft.selectableModes = ask / auto-edit / plan / full-auto`. `full-auto` 를 고르면 어디서든(생성·편집·시트) `ModeMenu` 와 같은 `confirmationDialog`("에이전트가 확인 없이 명령을 실행하고 파일을 수정합니다") 뒤에만 적용되고, 취소하면 이전 값이 남는다(`MemberDraft.modeChangeNeedsConfirmation(from:to:)`, ADR-015).
- **모델·사고 수준 피커**: 9.3 의 `SessionInfoState` 규칙 그대로(`ModelPickerRow`·`EffortPickerRow`): 목록은 `TeamsStore.models(for:)`(`GET /models?agent=`, 에이전트별 5분 캐시, 실패는 조용히 빈 배열), 목록에 없는 현재 값은 "현재: <id>", 사고 수준은 선택 모델의 `efforts` 가 있을 때만, "기본" 은 nil. 편집기에서 에이전트를 바꾸면 모델·사고 수준을 비운다.
- **적용 시점 캡션**: `model`·`prompt` 는 "다음 세션부터 적용됩니다(기억 초기화로 바로 적용)"(`MemberControlState.nextSessionCaption`), `mode`·`effort` 는 즉시.
- **팀원 시트**(`MemberControlSheet(teamId:member:)`): 헤더 `MemberChip` + 상태 점, 섹션 권한 · 모델 · 사고 수준 · 브랜치(읽기 전용), 버튼 "타임라인 열기" · "기억 초기화"(확인). 변경은 즉시 `TeamsStore.patchMember`(낙관적 갱신 없음, 응답 `Team` 으로 교체) → 성공 시 `RoomModel.reloadMembers()`(`GET /teams/:id`), 실패는 시트 안 빨간 캡션(`ErrorMessages.teamMessage`). 상태는 `MemberControlState`(순수).
- 식별자: `room.member.<memberId>`(팀원 시트 행), `memberControl.mode` · `memberControl.model` · `memberControl.effort`, `memberEditor.model` · `memberEditor.effort`.

### 10.9 미리보기(localhost 링크·열린 포트) (2026-09-14, Phase `7-preview-and-remote`)

12절의 미리보기를 폰에서 실제로 눌러 보는 UI 테스트 `MacAgentUITests/PreviewUITests.swift`(`MAM_UI_TEST_SERVER` 가 없으면 `XCTSkip`). 새 세션(Claude, `~/.mam`) → 컴포저에 `serve 3456`(Fake 어댑터가 답변 마지막 줄에 `[http://localhost:3456/](http://localhost:3456/)` 를 넣는다. 서버는 띄우지 않는다) → 승인 배너 "허용" → **답변 카드의 링크 탭** → 앱 안 브라우저(`SFSafariViewController`) → "닫기" → 툴바 **`timeline.preview`** → 시트의 **"열린 포트"** 섹션 → "완료".

- 카드는 접근성상 한 요소로 합쳐지지만(`ItemCard` 의 `.combine`) 마크다운 링크는 `Link` 요소로 남아 `app.links["http://localhost:3456/"]` 로 누를 수 있다.
- 앱 안 브라우저가 떴는지는 `SFSafariViewController` 만 갖는 `OpenInSafariButton` 과 닫기 버튼("닫기"/"완료")으로 확인한다. 링크가 실제로 열리는지(3456 에 서버가 있는지)는 보지 않는다.
- "열린 포트" 섹션은 서버 사용자가 띄운 포트가 있으면 행(`preview.port.<port>`), 없으면 빈 문구(`preview.empty`)다. 둘 중 하나면 통과한다(`bash scripts/dev-smoke.sh --keep` 는 23단계의 임시 리스너를 닫고 유지되므로 목록은 머신마다 다르다).
- 시트의 "직접 입력"·"최근" 은 포트 목록이 길면 화면 밖이라(List 지연 생성) UI 테스트가 아니라 `PreviewPortsSheetStateTests` 가 규칙을 검증한다.

| 식별자 | 위치 |
|---|---|
| `timeline.preview` · `room.preview` | 세션 타임라인 · 방 툴바의 "미리보기"(`safari` 아이콘) |
| `preview.port.<port>` · `preview.empty` | 미리보기 시트 "열린 포트" 의 행 · 빈 문구 |
| `preview.custom` · `preview.open` | 시트 "직접 입력" 의 포트 필드 · "열기" |
| `preview.recent.<port>` | 시트 "최근" 의 행 |

### 10.10 문서 뷰어(PDF·Office QuickLook, 한글 HTML) (2026-09-14, Phase `8-document-viewer`)

파일 탭·브라우저에서 문서를 바로 연다. 진입점은 지금까지와 같은 `FileViewerView` 이고, 파일 이름의 확장자로 `FileViewerLogic.documentKind` 가 세 갈래를 고른다(nil 이면 기존 `/fs/read` 텍스트·이미지 흐름 그대로). 프로토콜은 `GET /fs/download`·`GET /fs/render` 두 개만 늘었다(`docs/PROTOCOL.md` 1절).

- **`quickLook`**(`pdf` `doc(x)` `xls(x)` `ppt(x)` `rtf(d)` `pages` `numbers` `key` `epub`): `APIClient.downloadFile` 로 원본을 `Caches/mam-docs/<경로 sha256 앞 16자>/<파일 이름>` 에 내려받아 `QuickLookView`(`QLPreviewController`)에 넘긴다. 받는 동안은 진행률 막대(`documentViewer.progress`)와 "취소", 뷰어를 닫으면 내려받기를 멈추고 캐시 폴더를 지운다. 이름을 그대로 쓰는 이유는 QuickLook 이 확장자로 형식을 정하기 때문이다.
- **`hwp` · `hwpx`**: iOS 가 못 여는 한글 문서는 `GET /fs/render` 가 준 자체 완결 HTML 을 `HTMLDocumentView`(`WKWebView`)로 그린다. 스크립트는 꺼져 있고 링크 탭·폼 전송은 막으며(`loadHTMLString` 의 `.other` 만 허용), 다크 모드는 CSS `color-scheme` 로 따라간다. `warnings` 가 있으면 위에 회색 배너(`documentViewer.warnings`), 툴바의 "원본 공유"(`documentViewer.share`)는 누를 때 원본을 내려받아 공유 시트로 넘긴다.
- **크기·오류**: `FsEntry.size` 를 알면 100 MiB 초과를 서버 호출 전에 막고(서버 415 와 같은 문구), 모르면 서버 415 문구를 그대로 쓴다. 501 `agent_unavailable` 은 "한글 변환기가 없습니다" 화면 + 서버 안내 문구(백틱 명령을 줄로 빼서 보여준다) + "다시 시도"이고, 나머지는 기존 파일 오류 문구를 쓴다(`docs/RUNBOOK.md` 9절에 설치 방법).
- **UI 테스트** `MacAgentUITests/DocumentViewerUITests.swift`(`MAM_UI_TEST_SERVER`·`MAM_UI_TEST_REPO` 가 없으면 `XCTSkip`): 새 세션(cwd = 저장소) → "파일" 탭 → `sample.pdf` → QuickLook(`QLPreviewControllerView` 와 페이지 본문 "MacAgent PDF") → "닫기" → `sample.hwpx` → 웹 뷰의 "안녕하세요"(`app.webViews.staticTexts`) → "닫기". 두 샘플은 `bash scripts/dev-smoke.sh` 24단계가 저장소 안에 만들어 커밋한다(비추적 파일이 있으면 팀 머지가 409 라서 커밋한다).

| 식별자 | 위치 |
|---|---|
| `documentViewer.progress` | 원본을 내려받는 중의 진행률 막대 |
| `documentViewer.share` | 한글 문서 뷰어 툴바의 "원본 공유" |
| `documentViewer.warnings` | 한글 문서 뷰어 위의 변환 경고 배너 |

### 10.11 곁방(에이전트 간 대화) (2026-09-14, Phase `9-side-rooms`)

에이전트끼리의 대화는 서버가 곁방으로 떼어낸다(`docs/PROTOCOL.md` 6.6). 앱은 새 화면·새 모델·새 소켓을 만들지 않는다 — 곁방도 `RoomView`/`RoomModel`/`RoomSocket` 을 그대로 쓴다. 프로토콜 추가분은 `Room.kind = "side"` · `Room.participants` · `RoomMessage.sideRoom` 뿐이다.

- **방 목록**(`TeamRoomsLogic.sections`): `#전체` / `DM` / **"에이전트 간"** 세 섹션이고 행이 없는 섹션은 만들지 않는다(곁방이 없으면 섹션 자체가 없다). 곁방 행은 최근 메시지 순(없으면 이름 순)이며 참가자 아바타를 겹쳐 그린다. 섹션 푸터는 "에이전트끼리 나눈 대화입니다. 들어가서 직접 끼어들 수 있습니다." 곁방은 팀을 만든 뒤 서버가 만들기 때문에(6.6) `TeamRoomsView` 는 보이는 동안 5초마다 `TeamsStore.reloadTeam(id:)`(`GET /teams/:id` 하나만)으로 그 팀을 다시 읽는다 — 세션 홈의 15초 폴링은 이 화면을 push 하면 멈춘다. 실패는 조용히 지나가고 다음 주기가 다시 시도한다.
- **연결 카드**(`SideRoomCard` + 순수 `SideRoomCardState`): 그룹방에 남는 `sideRoom` 시스템 메시지. `opened` 는 "민수 ↔ 지연 곁방을 열었습니다", `closed` 는 "민수 ↔ 지연 곁방 대화 7건" + 결론 한 줄(본문의 `결론: ` 뒤). 참가자 이름은 메시지 본문이 아니라 **현재 팀원 목록**에서 만들고, 모르는 `kind` 는 서버 문구를 그대로 보여준다. 카드 전체가 버튼이라 탭하면 곁방으로 들어간다(compact 는 같은 스택에 push, iPad 는 `AppState.selectedRoom`). 아이콘·색은 `ItemStyle.roomStyle(for: .sideRoom)`(`bubble.left.and.bubble.right` · `.secondary`).
- **곁방 화면**: 제목은 서버가 만든 방 이름(`민수 ↔ 지연`), 부제는 "에이전트 간 · 참가자 N명". 컴포저는 멘션이 없으면 그룹방의 팀장 캡션 대신 **"참가자 전원에게 전달됩니다"**(PROTOCOL 6.4), 멘션 제안은 그 방 참가자만 올린다(모르는 `@토큰` 판정은 팀 전체 기준 — 참가자가 아닌 팀원을 멘션하면 서버가 그 조합의 새 곁방을 만든다). 승인 배너·작업 요약·상태 줄은 그룹방과 같다. 변경 카드는 곁방에서 한 작업이라도 그룹방에 올라온다(6.5).
- **UI 테스트** `MacAgentUITests/SideRoomUITests.swift`(`MAM_UI_TEST_SERVER`·`MAM_UI_TEST_REPO` 가 없으면 `XCTSkip`): REST 로 팀을 만들고(팀장 민수 + 개발자 지연, 둘 다 `full-auto` 라 승인 배너가 없다) 홈의 팀 행 → `#전체` → 팀장이 개발자를 부르게 하는 메시지 전송 → `room.sideRoom.*` 연결 카드 탭 → 곁방(제목 `↔`, 부제 "에이전트 간") → 메시지 확인 → 뒤로 → 방 목록의 "에이전트 간" 섹션과 `rooms.side.*` 행 → 곁방에서 직접 한 줄 보내기(캡션 "참가자 전원에게 전달됩니다"). 정리는 REST 팀 삭제.

| 식별자 | 위치 |
|---|---|
| `rooms.side.<roomId>` | 방 목록 "에이전트 간" 섹션의 곁방 행 |
| `room.sideRoom.<roomId>` | 그룹방의 곁방 연결 카드(탭 → 그 곁방) |
| `room.composer.caption` | 컴포저 위 캡션(곁방은 "참가자 전원에게 전달됩니다") |

### 10.12 작업 카드 묶기 (2026-09-15, Phase `10-room-readability`)

실제 팀(6명) 그룹방의 최근 42건은 대화 15 · 변경 카드 11 · 시스템 공지 11 · 승인 5 였다. 대화보다 작업 카드가 많아 읽기 어렵고, 같은 팀원이 턴마다 "변경 준비됨" 을 새 카드로 쌓는다. **서버 동작은 그대로 두고 화면에서만 접는다** — 카드는 방 로그·기록에 그대로 남고 프로토콜·`RoomModel` 은 바뀌지 않는다(묶기는 뷰 계층 순수 함수 `RoomEntryGrouping.group(_:members:)`).

- **묶는 것**: 연속된 **해결된 승인 · 변경 · 시스템 공지**. 연속이면 **1건이어도** 무조건 한 셀(`WorkGroupCell`)로 접는다. 그룹 id 는 첫 항목의 메시지 id 라 뒤에 메시지가 붙어도 바뀌지 않는다(펼침 상태가 유지된다).
- **묶지 않는 것**: **대기 중 승인**(사람이 눌러야 에이전트가 진행하므로 항상 펼쳐 둔다), **곁방 연결 카드**(그 방으로 가는 유일한 입구, 10.11), **대화**(`kind: text`). 이 셋은 그룹을 끊고 지금처럼 그려진다.
- **접힌 모습**: `ItemCard` 한 줄 — `hammer`(머지 대기가 있으면 `tray.full`) `.secondary` 아이콘 + 제목 `작업 5건`(한 종류면 `명령 3건` · `변경 2건` · `공지 4건`, 팀원이 한 명이면 `지연 명령 3건`) + 수치 `명령 2 · 변경 2 · 공지 1`(한 종류면 없다) + **머지 대기 캡슐** `머지 대기 N건`(`arrow.triangle.merge` + `.yellow.opacity(0.18)`, `status == ready` 인 변경 카드 수) + `chevron.down`. 문구는 순수 `WorkGroupSummary` 가 만든다.
- **펼치기는 그 자리에서**(인라인 토글, 별도 화면으로 보내지 않는다): 같은 셀 아래에 개별 카드(`RoomApprovalCard`·`ChangesReadyCard`·시스템 행)를 `RoomEntryRow` 로 **기존 뷰 그대로** 세로로 그린다(머지·거절 버튼도 그대로 동작한다). `chevron.up`. 펼침 상태는 `RoomView` 가 그룹 id 의 `Set<String>` 으로 들고 있고 셀은 `isExpanded` + `onToggle` 만 받는 무상태 뷰다.
- **접근성**: 셀은 `.accessibilityElement(children: .contain)`(안에 버튼이 있다), 머리 줄 라벨 `작업 5건, 명령 2 변경 2 공지 1, 머지 대기 1건`, 힌트 "두 번 탭하면 펼칩니다".
- 방에 들어가면 최신 메시지가 먼저 보인다(5.3 의 `.defaultScrollAnchor(.bottom)`). 세션 타임라인도 같다.
- **UI 테스트** `MacAgentUITests/WorkGroupUITests.swift`(`MAM_UI_TEST_SERVER`·`MAM_UI_TEST_REPO` 가 없으면 `XCTSkip`): REST 로 팀(팀장 민수·지연 `full-auto` + 현우 `auto-edit`)을 만들고 그룹방 3턴 + 지연 DM 2턴을 시드해 그룹방 끝에 변경 카드 3장을 쌓는다 → 홈의 팀 행 → `#전체` → 나갔다 다시 들어가면 **맨 아래 작업 셀이 스크롤 없이 화면 안**이고 첫 사용자 메시지는 위로 밀려나 있다 → 셀 라벨 `변경 3건` + `머지 대기 2건`(같은 팀원의 이전 `ready` 는 `stale` 이라 3장 중 2장) → 탭하면 그 자리에서 변경 카드 3장 + `room.merge.*` 가 펼쳐지고 다시 탭하면 접힌다 → `@hyunwoo` 로 만든 **대기 중 승인은 접히지 않고** 그대로 보이며, 배너로 허용하면 그 카드도 작업 셀(`room.workGroup.<승인 메시지 id>`)로 접힌다. 정리는 REST 팀 삭제.
- 머지 흐름을 누르는 `TeamRoomUITests` 는 변경 카드가 접혀 있으므로 작업 셀을 먼저 펼친 뒤 "main에 병합" 을 누른다(`expandWorkGroups`).

| 식별자 | 위치 |
|---|---|
| `room.workGroup.<id>` | 접힌 작업 셀의 머리 줄(탭 → 그 자리에서 펼침/접힘). `<id>` 는 그룹 첫 항목의 메시지 id |

## 11. 범위 밖 (Phase 1)

- 파일 편집·업로드, 터미널, 푸시 알림(APNs, Phase 3), 여러 서버 동시 관리(서버 1개만 저장), 세션 검색, 위젯·Live Activity, iPad 멀티윈도우.

## 12. 미리보기 (2026-09-14, Phase `7-preview-and-remote`)

폰에서 Mac 의 개발 서버를 열어 본다. 앱 안 브라우저는 `SFSafariViewController`(`SafariServices`)이며 새 패키지는 없다(ADR-012). 서버는 프록시하지 않고 앱이 Mac 주소로 직접 연다.

- **주소 변환**(`Features/Preview/PreviewLink.swift`, 순수): 스킴이 `http`/`https` 이고 호스트가 `localhost` · `127.0.0.1` · `0.0.0.0` · `::1` 이면 **호스트만** 저장된 서버 URL 의 호스트로 바꾼다(포트·경로·쿼리·스킴은 원본 그대로, 포트가 없으면 붙이지 않는다). 그 외 링크는 nil 이고 기존대로 시스템이 연다. 기준 주소는 환경값 `previewServerURL`(앱 루트 `ConnectedRootView` 가 `client.baseURL` 을 넣는다)이며, 없으면 아무것도 바꾸지 않는다.
- **링크 가로채기**: 에이전트 메시지(`MessageCard`) · 타임라인 답변(`AssistantMessageCard`)의 `Markdown` 에 `.environment(\.openURL, OpenURLAction { … })`(`View.previewLinks(serverURL:into:)`). 변환되면 `SafariLink` 를 담아 `.handled`, 아니면 `.systemAction`. 도구 출력·파일 뷰어의 평문은 변환하지 않는다.
- **미리보기 시트**(`PreviewPortsSheet(client:serverURL:)`, 툴바 `safari` 아이콘): 섹션 "열린 포트"(`GET /net/ports`, 당겨서 새로고침. 빈 목록은 "열린 포트가 없습니다. 에이전트에게 개발 서버를 띄워 달라고 하세요.") · "직접 입력"(숫자 필드 1~65535) · "최근"(`RecentPortsStore`, UserDefaults, 최근 순 5개). 행은 `3000 · node` 이고 `address` 가 `127.0.0.1`/`::1` 이면 회색 캡션 "Mac 안에서만 열림 — 폰에서 안 열릴 수 있습니다"(`PreviewLink.isMacOnly`). 탭하면 `http://<서버 호스트>:<port>/` 를 앱 안 브라우저로 연다. 표시 규칙은 `PreviewPortsState`(순수).
- 식별자: `room.preview` · `timeline.preview`(툴바), `preview.port.<port>` · `preview.custom` · `preview.open` · `preview.recent.<port>`(시트).
