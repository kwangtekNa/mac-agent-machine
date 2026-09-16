# Step 1: ios-team-files

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md` (CRITICAL 8)
- `/docs/IOS.md` 5절 디자인 규칙, 8절 파일 브라우저, 10.2(방 목록·방 화면), 10.3, 10.8(팀원 시트), 10.9(미리보기), 식별자 표
- `/docs/PROTOCOL.md` 3절 `GET /fs/list`·`/fs/read`·`/fs/download`·`/fs/render`(모두 `path` 질의 하나로 동작한다), 6.1 `Team`(`cwd`)·`TeamMember`(`worktreePath`, `branch`)
- `/ios/MacAgent/Features/Files/FileBrowserView.swift`, `FileBrowserModel.swift`, `FileViewerView.swift` — 지금 어떤 입력을 받아 어떤 화면을 그리는지
- `/ios/MacAgent/Features/Rooms/RoomView.swift` — 툴바(`room.preview`, `room.members`, `room.settings`)와 팀원 시트를 여는 방식
- `/ios/MacAgent/Features/Rooms/RoomModel.swift` — `team`, `members`, `room` 접근 경로
- `/ios/MacAgent/Models/Protocol/Team.swift` — `Team.cwd`, `TeamMember.worktreePath`
- `/ios/MacAgentTests/Features/Files/*.swift`, `/ios/MacAgentTests/Features/Rooms/*.swift`

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 배경

팀으로 일할 때 **파일을 볼 방법이 없다**. 방 화면 툴바에는 미리보기·팀원·팀 설정 셋뿐이고 파일로 가는 길이 없다. 지금은 작업 요약 카드를 눌러 그 팀원의 세션 타임라인으로 들어가야만 파일 탭을 볼 수 있고, 그 탭은 그 팀원의 worktree 를 보여준다.

사용자는 이걸 "팀을 만들어서 작업하면 현재 작업 디렉토리 파일을 볼 수가 없다" 로 겪었다.

사실 확인: 팀원 worktree 에는 프로젝트 파일이 다 들어 있다(실측 원본 37개 항목 / worktree 30개, 차이는 `.env` 같은 git 이 추적하지 않는 파일). 없는 것은 **파일에 닿는 입구**다.

## 확정된 결정 (사용자 승인, 바꾸지 마라)

1. **입구는 방 화면 툴바**에 둔다. 미리보기·팀원·팀 설정 옆에 파일 버튼을 더한다.
2. **기본은 프로젝트 원본 디렉토리**(`team.cwd`). 머지된 결과가 거기 있다.
3. **팀원을 골라 그 worktree 로 바꿔 볼 수 있다**. 아직 머지되지 않은 작업을 보는 길이다.
4. 파일을 읽는 화면은 **기존 것을 그대로 쓴다**. 뷰어·하이라이트·문서 렌더를 새로 만들지 마라.

## 작업

### 1. 범위 선택 모델 `Features/Rooms/TeamFilesScope.swift` (순수, 테스트 대상)

```swift
/// 팀 파일 화면이 무엇을 보고 있는지. 프로젝트 원본이거나 팀원 한 명의 worktree 다.
enum TeamFilesScope: Hashable, Identifiable {
    case project
    case member(String)          // TeamMember.id
    var id: String
}

struct TeamFilesScopeState: Equatable {
    let scopes: [TeamFilesScope]     // .project 가 항상 첫 번째
    let title: String                // 선택된 범위의 이름: 프로젝트면 cwd 의 마지막 조각, 팀원이면 이름
    let subtitle: String?            // 프로젝트면 전체 경로, 팀원이면 "브랜치 <branch>"
    let path: String                 // /fs/list 에 넘길 경로
    static func make(team: Team, members: [TeamMember], selected: TeamFilesScope) -> TeamFilesScopeState
}
```

- 팀원 목록 순서는 방 화면과 같게(팀장 먼저, 그다음 생성 순) 유지한다.
- `worktreePath` 가 비어 있는 팀원은 목록에서 뺀다(아직 준비되지 않은 팀원).
- 모르는 `memberId` 가 선택돼 있으면 `.project` 로 되돌린다(팀원이 지워졌을 때).

### 2. 화면 `Features/Rooms/TeamFilesView.swift`

- `NavigationStack` 을 새로 만들지 마라. 방 화면에서 **시트**로 띄운다(미리보기·팀원 시트와 같은 감각).
- 시트 상단에 범위 선택(`Menu` 또는 `Picker`): "프로젝트 · affirm" / 팀원 이름들. 선택은 `@State` 로 시트가 들고 있는다.
- 본문은 기존 파일 브라우저를 그대로 쓴다. 지금 브라우저가 세션을 전제로 만들어져 있으면 **경로만 받는 형태로 일반화**하고, 기존 세션 화면은 같은 동작을 유지하도록 얇은 어댑터를 둔다. 새 브라우저를 복제하지 마라.
- 식별자: 시트 `room.files`, 범위 선택 `room.files.scope`, 범위 항목 `room.files.scope.<scopeId>`.
- 빈 폴더·오류 문구는 기존 브라우저 규칙을 따른다.

### 3. `RoomView` 연결

- 툴바 `topBarTrailing` 에 파일 버튼을 더한다. SF Symbol 은 `folder`, 접근성 라벨 "파일", 식별자 `room.files.button`. 위치는 미리보기 왼쪽(왼→오른쪽: 파일, 미리보기, 팀원, 설정).
- 곁방·DM 에서도 같은 버튼을 보인다. 팀이 하나이므로 범위는 방 종류와 무관하다.

### 4. 문서

`docs/IOS.md` 10절에 `10.13 팀 파일`: 입구(방 툴바), 기본 범위(프로젝트 원본), 팀원 worktree 로 전환, 식별자 표(`room.files.button`, `room.files`, `room.files.scope`). 8절 파일 브라우저 문단에 "세션뿐 아니라 팀 화면에서도 같은 브라우저를 경로로 연다" 한 줄.

### 5. 테스트 (먼저 쓴다)

- `TeamFilesScopeStateTests`: 기본이 `.project` 이고 경로가 `team.cwd` 다 / 팀원 선택 시 경로가 그 `worktreePath` 이고 부제가 브랜치다 / `worktreePath` 없는 팀원은 목록에서 빠진다 / 모르는 memberId 는 `.project` 로 떨어진다 / 팀장이 목록 첫 팀원이다.
- 기존 파일 브라우저 테스트는 **무변경 통과**해야 한다(일반화가 기존 동작을 바꾸지 않았다는 증거).
- 렌더 확인(`UIHostingController`): 시트를 호스팅하면 범위 선택 컨트롤이 계층에 있다.

## Acceptance Criteria

```bash
cd ios && xcodegen generate --quiet && xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet test -only-testing:MacAgentTests && cd ..
test -f ios/MacAgent/Features/Rooms/TeamFilesScope.swift
test -f ios/MacAgent/Features/Rooms/TeamFilesView.swift
grep -q "room.files.button" ios/MacAgent/Features/Rooms/RoomView.swift
grep -q "10.13" docs/IOS.md
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 파일 브라우저가 한 벌인가(복제하지 않았는가)?
   - `RoomView` 안에 `NavigationStack` 중첩이 없는가?
   - 시스템 색·SF Symbol·한국어 문구(5.4, 5.5)? 새 Swift 파일 뒤 `xcodegen generate`(CRITICAL 8)?
   - 서버·프로토콜을 고치지 않았는가?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`
   - 실패 → `error` / 개입 필요 → `blocked` / 설계 분기 → `needs_input`

## 금지사항

- 파일 브라우저를 복제하지 마라. 이유: 뷰어·하이라이트·문서 렌더가 두 벌이 되면 한쪽만 고쳐진다.
- 파일 편집·업로드를 만들지 마라. 범위 밖이다(IOS.md 가 명시적으로 뺀 기능).
- 서버·프로토콜을 수정하지 마라. `/fs/*` 는 경로 하나만 받으면 충분하다. 불일치는 `needs_input`.
- 방 화면의 기존 툴바 동작(미리보기·팀원·설정)을 바꾸지 마라.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
