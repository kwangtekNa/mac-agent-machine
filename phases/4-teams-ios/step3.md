# Step 3: approval-banner-generalization

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/IOS.md` 5.3 레이아웃(승인 배너 규칙), 5.2 카드 표
- `/ios/MacAgent/Features/Approvals/ApprovalBanner.swift` (`ApprovalBannerState.make(pending:)`, `ApprovalBanner(model: TimelineModel)` 가 쓰는 것: `pendingApprovals`, `approvalSubmit`, `respond(to:optionId:inputs:message:)`), `ApprovalSheet.swift`, `PendingApprovalsSheet.swift`
- `/ios/MacAgent/Features/Timeline/TimelineModel.swift` (`ApprovalSubmitState`, `respond`), `/ios/MacAgent/Features/Timeline/Cards/ItemCard.swift`, `Cards/ApprovalCard.swift`
- `/ios/MacAgent/Features/Rooms/RoomModel.swift` (step 2: `pendingApprovals: [RoomApproval]`, `respond(to: RoomApproval, …)`)
- `/ios/MacAgentTests/Features/Approvals/*.swift` (`ApprovalBannerLogicTests` 등), `/ios/MacAgentUITests/ApprovalFlowUITests.swift` (배너 식별자·라벨을 바꾸면 안 되는 이유)

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

승인 배너·시트를 `TimelineModel` 에서 떼어 **방(`RoomModel`)에서도 같은 UI 로 승인** 할 수 있게 하고, 카드 컨테이너가 `TimelineItem` 없이도 쓰이게 한다. 배너의 모양·문구·식별자는 바꾸지 않는다.

### 확정된 결정

- 승인은 방에서 바로 처리한다(기존 배너·시트 재사용). 방에서는 배너 제목 위에 작성자 캡션(`🧑‍💻 지연 · 개발자`)을 한 줄 보여준다. 타임라인에서는 캡션이 없다(기존과 동일).

### 1. `Features/Approvals/ApprovalResponding.swift`

```swift
@MainActor protocol ApprovalResponding: AnyObject, Observable {
    var pendingApprovals: [Approval] { get }
    var approvalSubmit: ApprovalSubmitState { get }
    func respond(to approval: Approval, optionId: String, inputs: [String: String]?, message: String?) async
    /// 방에서 작성자 표시(예: "🧑‍💻 지연 · 개발자"). 타임라인은 nil.
    func authorLabel(for approval: Approval) -> String?
}
extension ApprovalResponding { func authorLabel(for approval: Approval) -> String? { nil } }
```

- `TimelineModel: ApprovalResponding` — 이미 같은 시그니처를 가졌으므로 conformance 만.
- `RoomModel: ApprovalResponding` — `pendingApprovals` 는 `[RoomApproval].map(\.approval)`(requestedAt 순), `respond(to: Approval, …)` 는 `approvalId` 로 `RoomApproval` 을 찾아 step 2 의 `respond(to: RoomApproval, …)` 로, `authorLabel` 은 팀원의 `emoji + name + " · " + roleLabel`.
- `ApprovalBanner`, `ApprovalSheet`, `PendingApprovalsSheet`(및 그 안의 폼 뷰)의 `model` 타입을 `any ApprovalResponding` 으로 바꾼다. 배너는 `authorLabel` 이 있으면 제목 위에 `.caption .secondary` 한 줄을 그린다. 그 외 레이아웃·색·문구·`accessibilityIdentifier` 는 그대로.

### 2. `ItemCard` 의 `CardChrome`

```swift
struct CardChrome: Equatable { var status: ItemStatus; var createdAt: Date; var summary: String? }
extension ItemCard { init(chrome: CardChrome, style: ItemStyle, title: String? = nil, titleMonospaced: Bool = false, badge: String? = nil, background: Color = …, @ViewBuilder content: …) }
```

기존 `init(item:style:…)` 은 `CardChrome(status: item.status, createdAt: item.createdAt, summary: ItemAccessibility.summary(for: item, title: title))` 을 만들어 새 init 으로 위임한다. 기존 카드 파일은 바뀌지 않는다.

### 3. `ApprovalCardBody`

`ApprovalCard` 의 본문(제목·prompt·detail 접힘·diff·resolution 표시)을 `ApprovalCardBody(approval:resolution:onShowDetail:)` 로 뽑아 `ApprovalCard` 가 그것을 쓰게 한다(step 6 의 `RoomApprovalCard` 가 재사용). 시각 결과는 동일해야 한다.

### 4. 테스트 (먼저 쓴다)

- 기존 `ApprovalBannerLogicTests`·승인 관련 테스트는 **무변경** 으로 통과.
- `Features/Approvals/ApprovalRespondingTests.swift`: `RoomModel` 이 `ApprovalResponding` 으로서 `pendingApprovals` 를 요청 시각 순으로 돌려주고, `respond` 가 `POST /sessions/<sessionId>/approvals/<approvalId>` 를 호출하며(`StubURLProtocol`), `authorLabel` 이 "🧑‍💻 지연 · 개발자" 형식인지; `TimelineModel.authorLabel` 은 nil.
- `ItemCard` 의 `CardChrome` init 이 기존 init 과 같은 접근성 요약을 만드는지(`ItemAccessibility.summary` 값 비교).

## Acceptance Criteria

```bash
cd ios && xcodegen generate --quiet && xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet test && cd ..
test -f ios/MacAgent/Features/Approvals/ApprovalResponding.swift
grep -q "any ApprovalResponding" ios/MacAgent/Features/Approvals/ApprovalBanner.swift
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 배너의 배경색·아이콘·버튼 스타일·식별자(`ApprovalFlowUITests` 가 쓰는 라벨)가 그대로인가(IOS.md 5.3)?
   - `TimelineModel` 에 방 관련 코드가 들어가지 않았는가?
   - `xcodegen generate` 를 실행했는가(CRITICAL 8)?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- 배너·시트의 모양·문구·접근성 식별자를 바꾸지 마라. 이유: `ApprovalFlowUITests` 와 IOS.md 5.3 의 기준이다.
- `ApprovalBannerState` 의 규칙(옵션 2개 + 더 보기 등)을 바꾸지 마라.
- 방 화면·카드를 만들지 마라(step 5·6).
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
