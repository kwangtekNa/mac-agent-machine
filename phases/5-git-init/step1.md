# Step 1: ios-git-init-ui

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md` (CRITICAL 5, 8)
- `/docs/PROTOCOL.md` 1절 `POST /git/init (2026-09-13 추가)` (step 0), `GET /git/status`, `GET /fs/list` 의 `isGitRepo`
- `/docs/IOS.md` 5절(5.4 시스템 색, 5.5 문구), 9.2 디렉토리 피커, 10.1 새 팀 시트
- `/packages/protocol/fixtures/rest/git-init.json`, `git-init-dry-run.json`
- `/ios/MacAgent/Models/Protocol/REST.swift` (`GitStatusResponse`, `FsMkdirRequest/Response` 의 스타일), `/ios/MacAgent/Networking/APIClient.swift` (`makeDirectory`, `gitStatus`)
- `/ios/MacAgentTests/ProtocolFixturesTests.swift` (step 0 이 `JSONValue` 로 넣은 2개, 파일 수 71), `Networking/APIClientTests.swift`
- `/ios/MacAgent/Features/Teams/NewTeamFormState.swift` (`directory: NewSessionFormState`, `canSubmit`, `request()`), `NewTeamSheet.swift` (디렉토리 행, 오류 표시, `newTeam.*` 식별자, `isSubmitting`), `/ios/MacAgent/Features/Sessions/NewSessionSheet.swift` (`NewSessionFormState.selectedPath/customPath`)
- `/ios/MacAgent/Features/Files/DirectoryPickerView.swift` (툴바 "새 폴더" 알림 흐름, `directoryPicker.*` 식별자, `DirectoryListContent`, `model.createDirectory`), `FileBrowserModel.swift` (`FsListResponse.isGitRepo`, 새로고침)
- `/ios/MacAgent/Shared/ErrorMessages.swift` (`teamNotGitRepo`, `makeDirectoryMessage`), `/ios/MacAgent/Features/Files/FileBrowserModel.swift` 의 `FileFormat.size`
- `/ios/MacAgentTests/Features/Teams/NewTeamFormStateTests.swift`, `Features/Files/DirectoryNameValidationTests.swift`

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

폰에서 고른 디렉토리가 git 저장소가 아닐 때 그 자리에서 초기화할 수 있게 한다. 진입점은 **새 팀 시트** 와 **디렉토리 피커** 두 곳(파일 브라우저는 그대로).

### 확정된 결정

- 초기화 전에 `dryRun` 으로 받은 수치를 확인 다이얼로그에 보여준다: "파일 12개 · 47 KB를 첫 커밋에 담습니다. 기본 .gitignore 를 만듭니다." (`.gitignore` 가 이미 있으면 마지막 문장 생략, 파일 0개면 "빈 저장소를 만듭니다").
- 브랜치는 서버가 `main` 으로 만든다. 앱은 응답의 `branch` 를 표시만 한다.

### 1. 모델·클라이언트

- `REST.swift`: `GitInitRequest { cwd, dryRun? }`(nil 은 키 생략), `GitInitResponse { initialized, branch, commit?, files, bytes, createdGitignore }`.
- `APIClient.initRepository(cwd: String, dryRun: Bool = false) async throws -> GitInitResponse`(`POST /git/init`, 201/200 모두 성공).
- `ProtocolFixturesTests.swift`: 두 `JSONValue` 항목을 `decode(GitInitResponse.self)` 로 교체(개수 71 유지).

### 2. 순수 상태 `Features/Files/GitInitFlow.swift`

```swift
struct GitInitFlow: Equatable {
    enum Phase: Equatable { case idle, checking, notRepo, previewing, confirming(GitInitResponse), initializing, done(GitInitResponse), failed(String) }
    var phase: Phase
    static func confirmMessage(_ preview: GitInitResponse) -> String   // 위 문구 규칙, 크기는 FileFormat.size
    static func doneMessage(_ result: GitInitResponse) -> String       // "git 저장소를 만들었습니다 (main, 파일 12개)"
}
@MainActor @Observable final class GitInitModel {   // 시트·피커가 공유
    private(set) var flow: GitInitFlow
    init(client: APIClient)
    func check(cwd: String) async          // client.gitStatus(cwd:) → isRepo ? idle : notRepo (실패는 failed)
    func preview(cwd: String) async        // dryRun → confirming
    func confirm(cwd: String) async        // 실제 초기화 → done; 409 는 "이미 git 저장소입니다" 문구로 failed 후 check 재실행
    func reset()
}
```

### 3. 새 팀 시트

- 디렉토리를 고르거나 직접 입력이 확정될 때(`onChange` of `form.directory` 의 유효 경로) `gitInit.check(cwd:)` 를 부른다.
- `notRepo` 면 디렉토리 행 아래에 `Label("git 저장소가 아닙니다", systemImage: "exclamationmark.triangle")` `.foregroundStyle(.orange)` + 버튼 "저장소 초기화"(식별자 `newTeam.gitInit`). 탭 → `preview` → `confirmationDialog`(`GitInitFlow.confirmMessage`, 버튼 "초기화") → `confirm` → 행이 "git 저장소 (main)" 캡션으로 바뀌고 제출 가능.
- `POST /teams` 가 400 으로 `teamNotGitRepo` 를 돌려주면 같은 행·버튼을 보여준다(체크를 건너뛴 경우 대비).
- `canSubmit` 은 `notRepo` 상태에서 false.

### 4. 디렉토리 피커

- 현재 디렉토리의 `isGitRepo == false` 이면 툴바에 "저장소 초기화"(식별자 `directoryPicker.gitInit`, `arrow.triangle.branch` 아이콘). 흐름은 3 과 같고, 완료 후 목록을 새로고침해 git 배지가 보이게 한다. 이미 저장소인 디렉토리(또는 하위)에서는 버튼을 숨긴다(`isGitRepo` 는 상위 저장소도 true 로 오는지 `FileBrowserModel` 에서 확인하고, 아니면 409 문구로 안내).

### 5. 문구 (`ErrorMessages`)

`gitInitConflict = "이미 git 저장소입니다."`, 409 → 이 문구, 400/403 은 서버 메시지·`pathForbidden`, 그 외 `message(for:)`.

### 6. 테스트 (먼저 쓴다)

- `Features/Files/GitInitFlowTests.swift`: `confirmMessage` 3가지(일반·.gitignore 있음·파일 0개), `doneMessage`; `GitInitModel` 이 `StubURLProtocol` 로 `GET /git/status` → notRepo, `POST /git/init` dryRun 본문 `{"cwd":…,"dryRun":true}` → confirming, 실제 초기화 본문에 `dryRun` 키 없음 → done, 409 → failed 문구.
- `NewTeamFormStateTests` 확장: `notRepo` 면 `canSubmit false`.
- `APIClientTests` 확장: `initRepository` 경로·본문·201 처리.
- `ProtocolFixturesTests` 는 개수 71, 실제 타입.

## Acceptance Criteria

```bash
cd ios && xcodegen generate --quiet && xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet test && cd ..
test -f ios/MacAgent/Features/Files/GitInitFlow.swift
grep -q "newTeam.gitInit" ios/MacAgent/Features/Teams/NewTeamSheet.swift
grep -q "directoryPicker.gitInit" ios/MacAgent/Features/Files/DirectoryPickerView.swift
! grep -n "JSONValue.self" ios/MacAgentTests/ProtocolFixturesTests.swift
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 초기화가 항상 dryRun 미리보기 + 확인 다이얼로그를 거치는가?
   - 시스템 색·아이콘 동반(5.4), 한국어 문장형 문구(5.5)?
   - Swift 파일을 추가했으므로 `xcodegen generate` 를 실행했는가(CRITICAL 8)?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- 확인 없이 초기화하지 마라. 이유: 기존 파일 전부가 첫 커밋에 담기는 되돌리기 어려운 동작이다.
- 파일 브라우저(세션 화면의 파일 탭)에는 버튼을 넣지 마라. 이유: 확정된 진입점은 새 팀 시트와 디렉토리 피커뿐이다.
- `packages/protocol`·서버를 수정하지 마라. 불일치는 `needs_input`.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
