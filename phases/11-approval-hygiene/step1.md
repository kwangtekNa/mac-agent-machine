# Step 1: ios-system-resolution-label

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md` (CRITICAL 8)
- `/docs/IOS.md` 5.4·5.5(색·SF Symbol·한국어 문구), 10.3(방 카드), 10.12(작업 카드 묶기)
- `/docs/PROTOCOL.md` 4절 `approval.resolved`(`by`: `client | timeout | system`), 6.4 "승인 미러링"(step 0 이 갱신했다)
- `/ios/MacAgent/Models/Protocol/Approval.swift` — `ApprovalResolution { optionId, by, at }`
- `/ios/MacAgent/Models/Protocol/Enums.swift` — `enum ApprovalResolvedBy: String, LenientRawEnum`
- `/ios/MacAgent/Features/Timeline/Cards/ApprovalCard.swift` — `ApprovalCard.resolutionLabel(_:)`, `ApprovalCardBody`(본문 + `static func resolutionLabel(_ optionId: String) -> String`)
- `/ios/MacAgent/Features/Rooms/Cards/RoomApprovalCard.swift` — `RoomApprovalCardState.make(message:member:)` 의 `resolutionLine`
- `/ios/MacAgentTests/Features/Rooms/RoomApprovalCardStateTests.swift`, `/ios/MacAgentTests/Features/Rooms/RoomCardsRenderTests.swift`, `/ios/MacAgentTests/Features/Approvals/*.swift`

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 배경

step 0 에서 서버가 유령 승인 카드(세션에 더는 없는 요청)를 `{ optionId: "abort", by: "system" }` 으로 정리하게 됐다. 지금 iOS 는 `optionId` 만 보고 문구를 고르므로 그 카드가 **"중단됨 · 12:03"** 으로 보인다. 사람이 중단 버튼을 누른 것과 구분되지 않는다. 사용자는 이 카드들을 "내가 답을 안 했더니 계속 떠 있던 메시지"로 겪었으므로, 누가 없앴는지가 화면에 드러나야 한다.

`by` 는 이미 프로토콜에도 iOS 모델에도 있다. 표시만 고치면 된다. **서버·프로토콜·fixture 는 건드리지 않는다.**

## 확정된 결정 (바꾸지 마라)

- `by == .system` → "시스템이 취소함". `by == .timeout` → "시간 초과". 그 밖에는 지금 문구 그대로(`allow` 허용됨 / `allow_session` 항상 허용됨 / `deny` 거절됨 / `abort` 중단됨 / 모르는 값은 `optionId` 원문).
- 이 규칙은 **타임라인 카드와 방 카드 양쪽**에 같이 적용한다. 두 곳이 같은 본문을 공유하는 현재 구조를 유지한다.
- 대기 중 카드의 모습(노란 배경, `hand.raised.fill`, "자세히 보기")은 그대로다.

## 작업

### 1. `Features/Timeline/Cards/ApprovalCard.swift`

`ApprovalCardBody` 에 결과 문구를 만드는 순수 함수를 더한다:

```swift
extension ApprovalCardBody {
    /// 해결 문구. 누가 처리했는지가 먼저다: 시스템 정리와 사람이 누른 결과를 구분한다.
    static func resolutionText(_ resolution: ApprovalResolution) -> String
}
```

- `resolution.by` 가 `.system` 이면 "시스템이 취소함", `.timeout` 이면 "시간 초과", 그 외(`.client` 와 lenient 미지값)는 기존 `resolutionLabel(resolution.optionId)`.
- 기존 `static func resolutionLabel(_ optionId: String) -> String` 은 **지우지 마라**. 기존 테스트가 쓰고 있고 optionId → 한국어 매핑은 그대로 필요하다.
- `ApprovalCardBody` 의 본문에서 `Text("\(Self.resolutionLabel(resolution.optionId)) · \(Formatters.clock(resolution.at))")` 를 `resolutionText(resolution)` 기반으로 바꾼다.
- `ApprovalCard.resolutionLabel(_:)` 위임 메서드는 그대로 둔다.

### 2. `Features/Rooms/Cards/RoomApprovalCard.swift`

`RoomApprovalCardState.make` 의 `resolutionLine` 을 `ApprovalCardBody.resolutionText($0)` 로 바꾼다. 나머지 필드(`title`, `subtitle`, `isPending`)의 규칙은 그대로다.

### 3. 문서

`docs/IOS.md` 10.3 승인 카드 설명에 한 줄: 해결된 승인은 "허용됨 · 12:03" 처럼 보이고, 서버가 정리한 것(`by: "system"`, 재시작·세션 종료)은 "시스템이 취소함 · 12:03" 으로 보인다.

### 4. 테스트 (먼저 쓴다)

- `RoomApprovalCardStateTests` 확장: `by: .system` 인 해결 카드의 `resolutionLine` 이 `"시스템이 취소함 · <시각>"` 이고 `isPending == false`. fixture 를 고치지 말고 디코드한 `RoomMessage` 의 `approval.resolution` 을 테스트 안에서 바꿔 만든다(`RoomMessage`·`RoomApproval` 은 값 타입이다).
- `ApprovalCardBody.resolutionText` 표 테스트: `.client`+`allow` → "허용됨", `.client`+`allow_session` → "항상 허용됨", `.client`+`deny` → "거절됨", `.client`+`abort` → "중단됨", `.system`+`abort` → "시스템이 취소함", `.timeout`+임의 → "시간 초과", `.client`+모르는 id → 그 id 원문.
- 렌더 확인(`UIHostingController`, `RoomCardsRenderTests` 방식): 시스템 정리된 방 승인 카드를 호스팅했을 때 "시스템이 취소함" 텍스트가 계층에 있고, 배경이 대기 중(노랑)이 아니다.
- 기존 승인 관련 테스트(`ApprovalBannerLogicTests`, `ApprovalRespondingTests`, `TimelineModelApprovalTests`, `RoomCardsRenderTests`)는 무변경 통과해야 한다.

## Acceptance Criteria

```bash
cd ios && xcodegen generate --quiet && xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet test -only-testing:MacAgentTests && cd ..
grep -q "resolutionText" ios/MacAgent/Features/Timeline/Cards/ApprovalCard.swift
grep -q "resolutionText" ios/MacAgent/Features/Rooms/Cards/RoomApprovalCard.swift
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 타임라인 카드와 방 카드가 같은 본문·같은 문구 규칙을 공유하는가(중복 구현 없음)?
   - 서버·프로토콜·fixture 를 하나도 고치지 않았는가?
   - 새 Swift 파일을 만들었다면 `xcodegen generate` 를 다시 실행했는가(CRITICAL 8)?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`
   - 실패 → `error` / 개입 필요 → `blocked` / 설계 분기 → `needs_input`

## 금지사항

- `resolutionLabel(_ optionId:)` 를 지우거나 시그니처를 바꾸지 마라. 이유: 기존 테스트와 타임라인 카드가 쓰고 있다.
- 대기 중 승인의 모습·동작을 바꾸지 마라. 이 step 은 **해결된** 카드의 문구만 다룬다.
- fixture 파일을 고치지 마라. 이유: 프로토콜 계약은 이번 phase 에서 바뀌지 않는다.
- 승인 응답 경로(`respondApproval`, 404/409 처리)를 바꾸지 마라. 이미 "이미 처리된 요청입니다" 로 처리된다.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
