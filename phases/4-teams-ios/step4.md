# Step 4: teams-store-and-team-ui

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/IOS.md` 4절 내비게이션, 5절 디자인 시스템(5.4 시스템 색만, 5.5 문구), 6절 상태 흐름
- `/docs/PROTOCOL.md` 6.1 모델(`RolePreset`, `MemberInput` 규칙: `custom` 은 `roleLabel` 필수, 이름·핸들 중복 409), 6.2 REST(`PATCH members` 의 `prompt`·`model` 은 다음 세션부터, `DELETE` 의 409 와 `keepWorktrees`)
- `/ios/MacAgent/App/AppState.swift` (`timelineModel(for:)`, `fileBrowserModel(for:)`, LRU `maxTimelineModels`, `clearModels`), `App/RootView.swift`(`ConnectedRootView` 가 `SessionsStore` 를 환경에 넣는 곳), `App/SplitRootView.swift`
- `/ios/MacAgent/Features/Sessions/SessionsStore.swift`, `SessionsHomeView.swift`(섹션 구조, `+` 버튼, 승인 대기 요약 행, `refreshPeriodically`), `SessionRowView.swift`, `NewSessionSheet.swift`(`NewSessionFormState`, 디렉토리 선택 3가지 진입점, `availability(of:)`, `selectableModes`), `ProjectSessionsView.swift`
- `/ios/MacAgent/Features/Files/DirectoryPickerView.swift`
- `/ios/MacAgent/Features/Rooms/RoomModel.swift` (step 2), `/ios/MacAgent/Networking/APIClient.swift` (팀 메서드), `/ios/MacAgent/Models/Protocol/Team.swift`
- `/ios/MacAgent/Shared/ErrorMessages.swift`
- `/ios/MacAgentTests/Features/Sessions/SessionsStoreTests.swift`, `NewSessionSheetLogicTests.swift`, `App/AppStateTests.swift`(있으면)

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

팀 목록·생성·편집·삭제 UI 와 그 상태를 만든다. 방 화면은 만들지 않는다(step 5).

### 확정된 결정

- 팀은 세션 홈의 **"팀" 섹션** 에 산다(프로젝트 섹션 위). `+` 버튼은 `Menu`("새 세션", "새 팀")가 된다. 같은 `NavigationStack` 에서 `Team → TeamRoomsView(step 5)` 로 push.
- 팀원 세션은 "지금 진행 중"·"최근 세션" 목록에 **보이되 팀 배지** 를 붙인다(`🧑‍💻 지연 · backend`). 탭하면 그 팀원의 타임라인. 승인 대기 요약 행은 지금처럼 세션 전체를 센다.
- 팀원 편집기의 모드는 `ask / auto-edit / plan` 만(**full-auto 제외**), 기본 `auto-edit`.
- 역할: 서버 프리셋 4종 + 커스텀. 커스텀 역할은 **"프리셋으로 저장"** 으로 앱에 로컬 저장(`UserDefaults`, 서버와 동기화하지 않음)해 다음 팀 만들 때 "내 프리셋" 으로 고를 수 있다.
- 팀 삭제: 확인 다이얼로그 → `deleteTeam`; 409(더러운 worktree) 이면 "커밋되지 않은 변경이 남아 있습니다. worktree 를 남기고 팀만 지울까요?" 를 물어 `keepWorktrees: true` 로 재시도.

### 1. `Features/Teams/TeamsStore.swift`

```swift
@MainActor @Observable final class TeamsStore {
    private(set) var teams: [Team]; private(set) var templates: [TeamTemplate]; private(set) var presets: [RolePreset]
    private(set) var hasLoaded: Bool; private(set) var errorMessage: String?
    init(client: APIClient)
    func refresh() async                       // teams + templates + presets 병렬, 부분 실패는 이전 값 유지 + errorMessage(SessionsStore 의 capture 패턴)
    func create(_ req: CreateTeamRequest) async throws -> Team
    func patch(id:_:) / delete(id:keepWorktrees:) / addMember / patchMember / removeMember / resetMember / stop
    func saveTemplate(_ req: CreateTeamTemplateRequest) async throws -> TeamTemplate; func deleteTemplate(id:)
    func team(id: String) -> Team?
    func team(forSession session: Session) -> (team: Team, member: TeamMember)?   // session.team 으로 조인
    static func badge(for session: Session, teams: [Team]) -> String?              // "🧑‍💻 지연 · backend"
}
```

`ConnectedRootView` 가 `SessionsStore` 옆에 환경으로 넣고, `SessionsHomeView.refreshPeriodically()` 가 함께 새로고침한다.

### 2. `Features/Teams/RolePresetStore.swift`

로컬 커스텀 프리셋: `struct LocalRolePreset: Codable, Identifiable { id: UUID, label, emoji, prompt, mode: SessionMode }`, `@Observable final class RolePresetStore { presets: [LocalRolePreset]; func save(_:); func remove(id:) }` — `UserDefaults` JSON. 서버 프리셋과 합쳐 피커에 "기본 프리셋"·"내 프리셋" 두 섹션.

### 3. 폼 상태 (순수 구조체, 테스트 대상)

- `NewTeamFormState`: `name`, 디렉토리(`NewSessionFormState` 재사용 — 선택·찾아보기·직접 입력), `members: [MemberDraft]`, `templateId?`, `settings`(고급: maxHops·maxConcurrent, 기본값), `canSubmit`(이름 1~60, 디렉토리, 팀원 1명 이상, 팀장 정확히 1명, 이름 중복 없음), `request() -> CreateTeamRequest`, `apply(template:)`.
- `MemberDraft`: `name, emoji, role: RoleId, roleLabel, agent, mode(.autoEdit 기본), prompt, isLead, handle?`, 검증 `validate(existing:) -> [MemberDraftError]`(빈 이름·40자 초과·`@`/공백 포함·중복 이름·커스텀인데 roleLabel 빔·이모지 한 글자 아님·에이전트 사용 불가), `static func from(preset:)`, `from(localPreset:)`.

### 4. 뷰 (`Features/Teams/`)

- `TeamRow`: 겹친 이모지 아바타(최대 3) + 이름 + 프로젝트 이름(`Formatters.abbreviatedPath(cwd)`) + 배지 "실행 N · 승인 M"(팀원 상태·`SessionsStore` 조인). 식별자 `teams.row.<teamId>`.
- `SessionsHomeView`: `Section("팀")` 추가, `+` → `Menu { "새 세션" / "새 팀" }`(식별자 `home.newSession`, `home.newTeam`; 기존 "새 세션" 라벨은 `ApprovalFlowUITests` 가 쓰므로 `accessibilityLabel("새 세션")` 을 유지), 빈 팀 섹션 문구 "아직 팀이 없습니다. + 에서 새 팀을 만드세요.".
- `SessionRowView`: `TeamsStore.badge(for:teams:)` 가 있으면 캡션에 표시.
- `NewTeamSheet`: 템플릿 선택(있을 때) → 이름 → 디렉토리(기존 컴포넌트 재사용) → 팀원 목록(추가·편집·삭제·팀장 지정) → 고급 설정 → "팀 만들기". 오류는 `ErrorMessages.message(for:)` 에 팀 전용 문구 추가(400 팀장, 409 이름 중복, git 아님).
- `MemberEditorView`: 프리셋 피커(`RolePresetPicker`: 서버 프리셋 + 내 프리셋), 이름, 이모지(텍스트 필드 1글자), 에이전트(Claude/Codex, `NewSessionSheet.availability(of:)` 재사용), 모드(3종), 프롬프트 `TextEditor`, 팀장 토글, "프리셋으로 저장" 버튼(커스텀일 때). 기존 팀원 편집이면 `prompt`/`model` 변경 시 캡션 "다음 세션부터 적용됩니다(기억 초기화로 바로 적용)".
- `TeamSettingsView`: 이름·설정 편집, 팀원 목록(편집·"기억 초기화"·제거), 베이스 브랜치·cwd 읽기 전용, "작업 전부 중단"(`stop`), "팀 삭제"(위 결정).

### 5. `AppState`

`RoomModel` 도 세션 모델과 같은 LRU 로 관리한다: `enum ModelKey: Hashable { case session(String), room(teamId: String, roomId: String) }`, `roomModel(for teamId:roomId:client:) -> RoomModel`, `maxTimelineModels` 를 8 로, 축출·`clearModels` 시 `stop()`. `selectedRoom: (teamId: String, roomId: String)?` (iPad, step 5 가 씀).

### 6. 테스트 (먼저 쓴다)

- `Features/Teams/TeamsStoreTests.swift`: refresh 부분 실패 시 이전 값 유지 + 메시지, create 가 목록에 삽입, delete 409 → `keepWorktrees` 재시도 경로는 호출자 몫이므로 `APIError` 그대로 던짐, `team(forSession:)`/`badge` 조인.
- `NewTeamFormStateTests`, `MemberDraftValidationTests`(위 규칙 전부, 프리셋 적용, 템플릿 적용).
- `RolePresetStoreTests`(UserDefaults suite 주입, 저장·삭제·왕복).
- `App/AppStateTests.swift`: 세션·방 키가 섞인 LRU 에서 오래된 것부터 축출되고 `stop()` 이 불리는지, `clearModels` 가 방도 지우는지.
- 뷰는 `UIHostingController` 로 렌더만 확인(`TeamRow` 가 이름·배지 텍스트를 담는지). 버튼 로직은 전부 상태 구조체에 두어 테스트한다.

## Acceptance Criteria

```bash
cd ios && xcodegen generate --quiet && xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet test && cd ..
test -f ios/MacAgent/Features/Teams/TeamsStore.swift
test -f ios/MacAgent/Features/Teams/NewTeamSheet.swift
test -f ios/MacAgent/Features/Teams/MemberEditorView.swift
grep -q "새 팀" ios/MacAgent/Features/Sessions/SessionsHomeView.swift
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 시스템 색·SF Symbol·Dynamic Type 만 썼는가(IOS.md 5.4)? 문구가 한국어 문장형인가(5.5)?
   - 디렉토리 선택을 `NewSessionFormState`/`DirectoryPickerView` 재사용으로 했는가?
   - `ApprovalFlowUITests`·`UsageAndFilesUITests` 가 쓰는 "새 세션" 진입이 그대로 동작하는가(라벨 유지)?
   - `xcodegen generate` 를 실행했는가(CRITICAL 8)?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- 방 목록·방 화면을 만들지 마라(step 5). `TeamRow` 탭의 목적지는 step 5 가 채우므로 임시로 `TeamSettingsView` 로 연결해 둔다.
- 팀원 편집기에 `full-auto` 를 넣지 마라. 이유: 자율 팀원에게 무승인 명령 실행은 위험하다(확정).
- 커스텀 프리셋을 서버에 저장하려 하지 마라. 이유: 서버 API 가 없고 앱 로컬 저장으로 확정됐다.
- 새 SwiftPM 패키지·커스텀 색을 쓰지 마라(ADR-012, IOS.md 5.4).
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
