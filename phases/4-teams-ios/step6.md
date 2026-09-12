# Step 6: work-summary-approval-merge-cards

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/IOS.md` 5.2 카드 표, 5.3 레이아웃(승인 배너), 5.4, 5.5
- `/docs/PROTOCOL.md` 6.1 `WorkSummary`·`ChangeSet`(status 6종)·`RoomMessage.approval`, 6.2 `merge`/`dismiss` 의 409 규칙, 6.5
- `/ios/MacAgent/Features/Rooms/RoomView.swift`(step 5 의 placeholder 자리), `RoomModel.swift`(`requestMerge`, `dismiss`, `mergeSubmit`, `respond`), `RoomEntry.swift`, `Cards/MessageCard.swift`
- `/ios/MacAgent/Features/Approvals/ApprovalResponding.swift`, `ApprovalBanner.swift`, `ApprovalSheet.swift`, `/ios/MacAgent/Features/Timeline/Cards/ApprovalCard.swift`(step 3 의 `ApprovalCardBody`), `Cards/ItemCard.swift`(`CardChrome`), `Cards/FileChangeCard.swift`(파일 목록 행 스타일), `Cards/TurnSummaryRow.swift`
- `/ios/MacAgent/Shared/Formatters.swift`(`duration(ms:)`, `tokens`, `usd`), `ItemStyle.swift`, `MemberAvatar.swift`(step 5)
- `/ios/MacAgent/App/AppState.swift`(`selectedMemberSessionId`, step 5), `/ios/MacAgent/Features/Timeline/TimelineView.swift`

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

방의 세 카드를 만들어 step 5 의 placeholder 를 대체한다: **작업 요약**(에이전트 답변 아래 접힌 한 줄), **승인**(팀원 이름 + 기존 승인 본문, 방 배너로 응답), **변경 준비됨**(diff 요약 + 머지/거절). 버튼 로직은 전부 순수 상태 구조체에 두어 테스트한다.

### 확정된 결정

- 작업 요약 카드는 접힌 한 줄 `도구 7회 · 파일 3개 변경 · 12초`(비용이 있으면 `· $0.04 추정`). 탭하면 그 팀원의 타임라인(compact: push `TimelineView(sessionId:)`, regular: detail 열).
- 승인 카드는 옵션 버튼을 카드 안에 두지 않는다(`ApprovalCard` 와 같은 규칙). 응답은 방 배너·시트에서. 해결되면 "허용됨 · 12:03" 캡션.
- 머지 버튼 문구는 **"<baseBranch>에 병합"**(예: "main에 병합"). 누르면 `confirmationDialog`("main에 병합합니다. 프로젝트의 작업 트리가 깨끗해야 합니다.") 후 `requestMerge`. 거절은 "거절"(`dismiss`, `.bordered`).
- 충돌 상태는 빨간 아이콘 + 충돌 파일 목록 + 캡션 "충돌이 났습니다. <이름>이(가) worktree 에서 해결하면 새 카드가 올라옵니다". 충돌 해결 UI 는 만들지 않는다.

### 1. `Features/Rooms/Cards/WorkSummaryCard.swift`

```swift
enum WorkSummaryLabel { static func line(_ work: WorkSummary) -> String }   // "도구 7회 · 파일 3개 변경 · 12초" (+ " · $0.04 추정"), 파일 0개면 "파일 변경 없음"
struct WorkSummaryCard: View { let member: TeamMember?; let work: WorkSummary; let onOpen: (String /*sessionId*/) -> Void }
```

에이전트 `MessageCard` 아래(같은 카드 안 하단 또는 바로 아래 12pt 간격)에 `hammer` `.secondary` 아이콘 + 한 줄 + `chevron.right`. 전체가 `Button`, 식별자 `room.workSummary.<messageId>`, 접근성 라벨 "작업 요약, 도구 7회, 파일 3개 변경, 12초".

### 2. `Features/Rooms/Cards/RoomApprovalCard.swift`

```swift
struct RoomApprovalCardState: Equatable { let title: String; let subtitle: String?; let resolutionLine: String?; let isPending: Bool
    static func make(message: RoomMessage, member: TeamMember?) -> RoomApprovalCardState }
struct RoomApprovalCard: View { let message: RoomMessage; let member: TeamMember?; let onShowDetail: () -> Void }
```

`ItemCard(chrome:…)` + 헤더 `MemberChip` + `ApprovalCardBody(approval:resolution:onShowDetail:)`. 대기 중은 `.yellow` 아이콘(`hand.raised.fill`), 해결되면 `ApprovalCard` 와 같은 "허용됨 · 12:03"(`resolution.optionId` → 라벨은 `ApprovalCard.resolutionLabel` 재사용). `onShowDetail` 은 `ApprovalSheet(model: roomModel, approvalId:)`.

### 3. `Features/Rooms/Cards/ChangesReadyCard.swift`

```swift
struct ChangesCardState: Equatable {
    enum Action: Equatable { case merge(label: String), merging, none }
    let title: String            // "변경 준비됨 · 파일 2개 · 커밋 1개" (message.text)
    let branchLine: String       // "mam/backend/jiyeon → main"
    let files: [FileChangeEntry] // 최대 5개 + "외 N개"
    let action: Action
    let canDismiss: Bool         // ready | conflict
    let statusLine: String?      // merged: "병합됨 · a1b2c3d", dismissed: "거절됨", stale: "새 변경으로 대체됨", conflict: 캡션(위 문구)
    let conflictFiles: [String]
    let tint: Color              // ready/merging accent, merged .green, conflict .red, dismissed/stale .secondary
    let errorLine: String?       // mergeSubmit.failed(changeId, message) 일 때
    static func make(message: RoomMessage, member: TeamMember?, submit: MergeSubmitState) -> ChangesCardState
}
struct ChangesReadyCard: View { let message: RoomMessage; let member: TeamMember?; let submit: MergeSubmitState; let onMerge: () -> Void; let onDismiss: () -> Void }
```

- 파일 행은 `FileChangeCard` 의 행 스타일(kind 아이콘 + 경로 monospaced + `+N −M`).
- `ready`: "<base>에 병합" `.borderedProminent` + "거절" `.bordered` → 병합은 `confirmationDialog` 를 거친다. `merging` 또는 `submit == .submitting(changeId)`: `ProgressView` + 버튼 비활성. 카드는 `.accessibilityElement(children: .contain)`(버튼이 있으므로 combine 금지). 식별자 `room.merge.<changeId>`, `room.dismiss.<changeId>`.
- 409 등 실패는 `errorLine`(`ErrorMessages.message(for:)` 문구: 더러운 작업 트리·다른 브랜치는 서버 메시지 그대로)을 카드 하단 `.red` 캡션으로.

### 4. `RoomView` 연결

`RoomEntryRow`: `.approval` → `RoomApprovalCard`, `.changes` → `ChangesReadyCard`, 에이전트 `.message` 의 `work != nil` → `MessageCard` 아래 `WorkSummaryCard`. `onOpen(sessionId)`: compact 는 `NavigationLink(value: MemberSessionRef(sessionId))` → `TimelineView(sessionId:)`, regular 는 `appState.selectedMemberSessionId = sessionId`. 팀원 타임라인 상단에는 기존 툴바 그대로(팀 배지는 step 4 의 세션 행 규칙과 동일하게 제목 부제에 팀 이름).

### 5. 테스트 (먼저 쓴다)

- `WorkSummaryLabelTests`: 7회/3개/12초, 비용 유무(`추정` 표기), 파일 0개, 1분 30초.
- `ChangesCardStateTests`: 6개 status 각각의 action/statusLine/tint/canDismiss, `submitting` 이면 merging, 실패 문구, 파일 5개 초과 "외 N개", 브랜치 줄.
- `RoomApprovalCardStateTests`: 대기/해결 상태, 팀원 없음(nil) 처리.
- `UIHostingController` 렌더: `ChangesReadyCard(ready)` 가 "main에 병합" 텍스트를, `WorkSummaryCard` 가 한 줄 텍스트를 담는지(버튼은 누르지 못하므로 렌더만).
- `RoomModelTests` 확장: `room.message.updated`(changes `merged`) 로 `mergeSubmit` 이 idle 로 돌아오는지.

## Acceptance Criteria

```bash
cd ios && xcodegen generate --quiet && xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet test && cd ..
test -f ios/MacAgent/Features/Rooms/Cards/WorkSummaryCard.swift
test -f ios/MacAgent/Features/Rooms/Cards/RoomApprovalCard.swift
test -f ios/MacAgent/Features/Rooms/Cards/ChangesReadyCard.swift
grep -q "에 병합" ios/MacAgent/Features/Rooms/Cards/ChangesReadyCard.swift
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 버튼 로직이 상태 구조체에 있고 뷰는 그리기만 하는가? 낙관적 갱신 없이 `room.message.updated` 로 확정하는가?
   - 승인 옵션 버튼이 카드 안에 없는가(배너·시트만)?
   - 시스템 색 + 아이콘 동반(5.4), 문구가 단정적 비용 표현을 피하는가("추정")?
   - `xcodegen generate` 를 실행했는가(CRITICAL 8)?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- 승인 옵션 버튼을 카드 안에 넣지 마라. 이유: `ApprovalCard` 규칙과 배너 단일 응답 경로.
- 충돌 해결 UI(파일 편집·마커 정리)를 만들지 마라. 이유: 해결은 에이전트 턴이 한다.
- 팀원 타임라인을 특정 `turnId` 로 스크롤하는 기능은 범위 밖이다.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
