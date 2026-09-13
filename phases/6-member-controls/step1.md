# Step 1: ios-member-controls

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md` (CRITICAL 8)
- `/docs/IOS.md` 5절, 9.3(모델·사고 수준 피커 규칙), 10.1(팀원 편집기), 10.2(방·팀원 시트)
- `/docs/PROTOCOL.md` 6.1 `TeamMember.mode/model/effort`, 6.2 `MemberInput`·`PATCH members`(`prompt`·`model` 은 다음 세션부터, `mode`·`effort` 즉시), `GET /models?agent=`
- `/ios/MacAgent/Features/Teams/MemberDraft.swift` (`selectableModes`, `model`/`effort` 필드가 이미 있으나 UI 없음), `MemberEditorView.swift`, `TeamSettingsView.swift`(`editorContext`, `patchMember`), `TeamsStore.swift`, `NewTeamFormState.swift`
- `/ios/MacAgent/Features/Timeline/ModeMenu.swift` (full-auto 확인 다이얼로그 문구), `SessionInfoSheet.swift` (`SessionInfoState`, 모델·사고 수준 피커 구현 — 재사용 대상), `TimelineModel.swift`(`loadModels` 5분 캐시)
- `/ios/MacAgent/Features/Rooms/RoomView.swift` (`showsMembers` 팀원 시트, `openPendingMember`), `RoomModel.swift` (`members`, `member(id:)`), `/ios/MacAgent/Features/Teams/TeamRoomsView.swift`
- `/ios/MacAgent/Networking/APIClient.swift` (`models(agent:)`, `patchMember`)
- `/ios/MacAgentTests/Features/Teams/MemberDraftValidationTests.swift`, `TeamsStoreTests.swift`, `/ios/MacAgentTests/Features/Timeline/SessionInfoStateTests.swift`

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

팀원을 만들 때와 그 뒤 언제든 **권한(모드)·모델·사고 수준(effort)** 을 바꿀 수 있게 한다. 진입점은 팀원 편집기(생성·팀 설정)와 방의 팀원 시트.

### 확정된 결정

- 편집기의 모드 피커에 `full-auto` 를 **포함** 한다. full-auto 를 고르면 `ModeMenu` 와 같은 확인 다이얼로그("에이전트가 확인 없이 명령을 실행하고 파일을 수정합니다")를 거친 뒤에만 적용된다(생성 시에도, 변경 시에도).
- 모델·effort 피커는 `SessionInfoSheet` 의 규칙(`SessionInfoState`)을 그대로 쓴다: 목록은 `GET /models?agent=`, 목록에 없는 현재 값은 "현재: <id>", effort 는 선택 모델의 `efforts` 가 있을 때만, "기본" 은 nil.
- 변경 즉시 `PATCH /teams/:id/members/:memberId` 를 보낸다(낙관적 갱신 없음, 응답 `Team` 으로 교체). `model`·`prompt` 는 캡션 "다음 세션부터 적용됩니다(기억 초기화로 바로 적용)", `mode`·`effort` 는 즉시.

### 1. `TeamsStore`

- `modelsByAgent: [AgentKind: [ModelOption]]`, `func models(for agent: AgentKind) async -> [ModelOption]`(5분 캐시, 실패는 빈 배열 + `errorMessage` 없이 조용히), 편집기가 에이전트를 바꾸면 다시 부른다.
- `patchMember` 는 이미 있다. 응답 `Team` 으로 `teams` 갱신.

### 2. 편집기 `MemberEditorView` / `MemberDraft`

- `MemberDraft.selectableModes = [.ask, .autoEdit, .plan, .fullAuto]`. 모드 피커에서 `.fullAuto` 선택 시 `confirmationDialog` → 취소하면 이전 값으로 되돌린다. 순수 헬퍼 `MemberDraft.modeChangeNeedsConfirmation(from:to:) -> Bool`.
- "모델" 피커(`TeamsStore.models(for: draft.agent)`, `SessionInfoState` 로 선택·"현재:" 처리, 기본 nil), "사고 수준" 피커(선택 모델의 efforts, 기본 nil). 에이전트를 바꾸면 모델·effort 를 nil 로 되돌린다. 식별자 `memberEditor.model`, `memberEditor.effort`.
- 기존 팀원 편집(`TeamSettingsView` → `.edit`)에서는 mode/model/effort 변경이 `PatchMemberRequest` 에 실린다(이미 포함되는지 확인). 모델 변경 행 아래 캡션(위 문구).

### 3. 방의 팀원 시트 (`RoomView` `showsMembers`)

- 팀원 행을 탭하면 `MemberControlSheet(teamId:member:)` 를 연다(기존 "팀원 타임라인 열기" 는 행의 버튼/스와이프 또는 시트 안 링크로 유지).
- `MemberControlSheet`: 헤더 `MemberChip` + 상태 점, 섹션 "권한"(`Picker` 4종 + full-auto 확인 다이얼로그), "모델"(피커 + 캡션), "사고 수준"(피커), "브랜치"(읽기 전용), 버튼 "타임라인 열기", "기억 초기화"(confirmation). 변경은 `teamsStore.patchMember` → 성공 시 `roomModel.reloadMembers()`(`GET /teams/:id` 로 `members` 갱신; `RoomModel` 에 이 메서드를 추가한다) → 실패는 시트 안 `.red` 캡션(`ErrorMessages.teamMessage(for:)` 재사용).
- 식별자 `room.member.<memberId>`, `memberControl.mode`, `memberControl.model`, `memberControl.effort`.

### 4. 상태 구조체 (테스트 대상)

```swift
struct MemberControlState: Equatable {
    let info: SessionInfoState                 // 모델·effort 선택 상태
    let mode: SessionMode
    let modelCaption: String?                  // 모델을 바꾼 직후 "다음 세션부터 적용됩니다 …"
    static func make(member: TeamMember, models: [ModelOption]) -> MemberControlState
    func patch(mode: SessionMode?) -> PatchMemberRequest / patch(model:) / patch(effort:)   // 바뀐 필드만
}
```

### 5. 테스트 (먼저 쓴다)

- `MemberDraftValidationTests` 확장: `selectableModes` 에 full-auto, `modeChangeNeedsConfirmation`(→fullAuto 만 true), 에이전트 변경 시 model/effort 초기화, `request()` 에 model/effort 포함.
- `MemberControlStateTests`: `make` 가 `SessionInfoState` 규칙(목록에 없는 현재 모델, efforts 없음)을 따르는지, `patch(...)` 가 바뀐 필드만 담는지.
- `TeamsStoreTests` 확장: `models(for:)` 캐시(5분 안 재요청 없음, 에이전트별 분리), 실패 시 빈 배열.
- `RoomModelTests` 확장: `reloadMembers()` 가 `GET /teams/:id` 로 `members` 를 교체.
- 렌더 테스트: `MemberControlSheet` 가 `UIHostingController` 에서 "권한"·"모델" 텍스트를 담는지(버튼은 못 누르므로 렌더만).

## Acceptance Criteria

```bash
cd ios && xcodegen generate --quiet && xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet test && cd ..
test -f ios/MacAgent/Features/Teams/MemberControlSheet.swift
grep -q "fullAuto" ios/MacAgent/Features/Teams/MemberDraft.swift
grep -q "memberEditor.effort" ios/MacAgent/Features/Teams/MemberEditorView.swift
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - full-auto 가 확인 다이얼로그 없이 적용되는 경로가 없는가(생성·편집·시트 전부)?
   - 낙관적 갱신 없이 서버 응답으로만 바뀌는가? 피커 규칙이 9.3 과 같은가?
   - 시스템 색·문구 규칙(5.4, 5.5)? `xcodegen generate` 실행(CRITICAL 8)?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- full-auto 를 확인 없이 적용하지 마라. 이유: ADR-015.
- 모델·effort 피커 규칙을 `SessionInfoState` 와 다르게 만들지 마라. 이유: 세션 정보 시트와 같은 동작이어야 한다.
- 서버·프로토콜을 수정하지 마라. 불일치는 `needs_input`.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
