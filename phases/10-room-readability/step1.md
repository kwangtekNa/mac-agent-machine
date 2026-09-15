# Step 1: ios-work-group-cell

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md` (CRITICAL 8)
- `/docs/IOS.md` 5.2 카드 표, 5.3 레이아웃(자동 스크롤 규칙), 5.4·5.5, 10.2·10.3·10.11
- `/docs/PROTOCOL.md` 6.1 `RoomMessage`(kind text/approval/changes/system, `approval.resolution`, `sideRoom`)
- `/ios/MacAgent/Features/Rooms/RoomView.swift` 전체 — 특히 `RoomEntryRow`, `ScrollViewReader`·`bottomId`·`isAtBottom`·`showsNewMessages`·`onChange(of: model.lastSeq)`
- `/ios/MacAgent/Features/Rooms/RoomEntry.swift`, `RoomModel.swift`
- `/ios/MacAgent/Features/Rooms/Cards/MessageCard.swift`, `WorkSummaryCard.swift`, `RoomApprovalCard.swift`, `ChangesReadyCard.swift`, `SideRoomCard.swift`
- `/ios/MacAgent/Features/Timeline/Cards/ToolCallCard.swift`(접기/펼치기 토글과 `ToolOutputBox` 의 인라인 펼침 방식 — 같은 감각으로 만든다), `ItemCard.swift`(`CardChrome`)
- `/ios/MacAgent/Features/Timeline/TimelineView.swift`(세션 타임라인도 같은 스크롤 문제가 있다)
- `/ios/MacAgentTests/Features/Rooms/*.swift`

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 배경: 실제 방의 구성

사용자의 실제 팀(6명) 그룹방을 재보면 최근 42건이 대화 15 / 변경 카드 11 / 시스템 공지 11 / 승인 5 다. 대화보다 작업 카드가 많아 읽기 어렵고, 같은 팀원이 턴마다 "변경 준비됨: 20개 파일, 커밋 7개 → 8개 → 9개"를 새 카드로 쌓는다. 또 방에 들어가면 **가장 오래된 메시지부터** 보여 한참 내려야 최근 대화가 나온다.

## 확정된 결정 (설계 인터뷰 결과, 바꾸지 마라)

1. **묶기 대상**: 승인(해결된 것)·변경·시스템 카드. 연속되면 **무조건** 한 셀로 접는다(1건이어도).
2. **대기 중 승인은 묶지 않는다.** 사람이 눌러야 에이전트가 진행하므로 항상 펼쳐 둔다.
3. **펼치기는 그 자리에서**(인라인 토글). 별도 화면으로 보내지 않는다.
4. **서버 동작은 그대로.** 변경 카드가 턴마다 쌓이는 것은 유지한다(기록·신호 보존). 화면에서만 접는다.
5. 셀 머리에 **머지 대기 건수**를 표시해 놓치지 않게 한다.
6. 방에 들어가면 **최근 메시지가 먼저 보여야 한다.**

## 작업

### 1. 묶기 로직 `Features/Rooms/RoomEntryGroup.swift` (순수, 테스트 대상)

```swift
enum RoomEntryGroup: Identifiable {
    case single(RoomEntry)
    case work(id: String, entries: [RoomEntry], summary: WorkGroupSummary)
    var id: String
}
struct WorkGroupSummary: Equatable {
    let approvals: Int; let changes: Int; let systems: Int
    let mergeReady: Int          // status == .ready 인 변경 카드 수
    let memberNames: [String]    // 등장 순서, 중복 제거
    var title: String            // "작업 5건" (한 종류면 "명령 3건" / "변경 2건" / "공지 4건")
    var detail: String           // "명령 2 · 변경 2 · 공지 1", 한 종류면 빈 문자열
    var badge: String?           // mergeReady > 0 이면 "머지 대기 N건"
}
enum RoomEntryGrouping {
    /// 연속된 묶기 대상만 묶는다. 대기 중 승인·대화·곁방 연결 카드는 `single`.
    static func group(_ entries: [RoomEntry], members: [TeamMember]) -> [RoomEntryGroup]
    static func isGroupable(_ entry: RoomEntry) -> Bool
}
```

`isGroupable` 규칙:

- `.approval` → `message.approval?.resolution != nil` 일 때만 true(대기 중은 false).
- `.changes` → true.
- `.system` → `message.sideRoom == nil` 일 때만 true. **곁방 연결 카드는 묶지 않는다**(그 방으로 가는 유일한 입구라 묻히면 안 된다).
- `.message`(대화) → false.

그룹 id 는 첫 항목의 id(펼침 상태를 `@State` 로 들고 있어야 하므로 안정적이어야 한다).

### 2. 셀 뷰 `Features/Rooms/Cards/WorkGroupCell.swift`

- 접힌 모습: `ItemCard(chrome:)` 한 줄 — `hammer` 또는 `tray.full` `.secondary` 아이콘 + `summary.title` + `summary.detail` `.caption .secondary` + `summary.badge` 가 있으면 캡슐(노랑 계열, 아이콘 동반) + 오른쪽 `chevron.down`. 팀원이 한 명이면 이름을 앞에 붙인다("올트먼 명령 3건").
- 펼친 모습: 같은 카드 아래에 개별 카드(`RoomApprovalCard`/`ChangesReadyCard`/시스템 행)를 **기존 뷰 그대로** 세로로 그린다. `chevron.up`.
- 토글은 `@State private var expanded: Set<String>` 을 `RoomView` 가 그룹 id 로 들고 있게 한다(셀은 `isExpanded` + `onToggle` 만 받는 무상태 뷰). 접근성: 셀은 `.accessibilityElement(children: .contain)`(안에 버튼이 있다), 라벨 "작업 5건, 명령 2 변경 2 공지 1, 머지 대기 1건", 힌트 "두 번 탭하면 펼칩니다".
- 식별자 `room.workGroup.<id>`.

### 3. `RoomView` 연결

- `RoomEntryRow` 를 `ForEach(RoomEntryGrouping.group(model.entries, members: model.members))` 로 바꾸고 `.single` 은 지금 그대로, `.work` 는 `WorkGroupCell`.
- 펼침 상태는 그룹 id 기준 `Set<String>`. 새 메시지가 와서 그룹이 재구성돼도 첫 항목 id 가 같으면 펼침이 유지된다.

### 4. 최근 메시지부터 보이기

- `RoomView` 의 `ScrollView` 에 **`.defaultScrollAnchor(.bottom)`**(iOS 17+)을 붙인다. 기존 `bottomId`·`isAtBottom`·"새 메시지" 칩·`onChange(of: model.lastSeq)` 의 따라가기 동작은 **그대로 둔다**.
- **세션 타임라인(`TimelineView`)도 같은 문제가 있다.** 같은 방식으로 `.defaultScrollAnchor(.bottom)` 을 붙인다. 다른 동작은 바꾸지 않는다.
- `IOS.md` 5.3 자동 스크롤 문단에 "방·타임라인은 열릴 때 최신 메시지가 보이도록 `.defaultScrollAnchor(.bottom)` 을 쓴다" 한 줄 추가.

### 5. 문서

`docs/IOS.md` 10절에 `10.12 작업 카드 묶기`: 묶는 대상·제외(대기 중 승인, 곁방 연결 카드, 대화)·인라인 펼침·머지 대기 배지·식별자 표(`room.workGroup.<id>`).

### 6. 테스트 (먼저 쓴다)

- `RoomEntryGroupingTests`: 대화 사이에 낀 작업 카드 3건이 한 그룹; 대기 중 승인은 그룹을 끊고 `single`; 해결된 승인은 묶임; 곁방 연결 카드는 `single`; 연속 1건도 `work` 그룹(무조건 묶음); 요약 수치(approvals/changes/systems/mergeReady); `title`/`detail` 문구(한 종류일 때와 섞였을 때); 팀원 1명일 때 이름 접두; 그룹 id 안정성(뒤에 메시지가 붙어도 앞 그룹 id 불변).
- `WorkGroupCell` 렌더 테스트(`UIHostingController`): 접힌 상태에 제목 텍스트가 있고, 펼친 상태에 개별 카드 텍스트가 있다(버튼은 누를 수 없으므로 `isExpanded` 를 바꿔 두 번 호스팅한다).
- 기존 `RoomModelTests`·카드 테스트는 무변경 통과.

## Acceptance Criteria

```bash
cd ios && xcodegen generate --quiet && xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet test && cd ..
test -f ios/MacAgent/Features/Rooms/RoomEntryGroup.swift
test -f ios/MacAgent/Features/Rooms/Cards/WorkGroupCell.swift
grep -q "defaultScrollAnchor" ios/MacAgent/Features/Rooms/RoomView.swift
grep -q "defaultScrollAnchor" ios/MacAgent/Features/Timeline/TimelineView.swift
grep -q "10.12" docs/IOS.md
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 대기 중 승인과 곁방 연결 카드가 접히지 않는가?
   - 묶기가 화면 전용인가(모델·서버·프로토콜 무변경)?
   - 시스템 색·SF Symbol·한국어 문구(5.4, 5.5)? `xcodegen generate` 실행(CRITICAL 8)?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`
   - 실패 → `error` / 개입 필요 → `blocked` / 설계 분기 → `needs_input`

## 금지사항

- 대기 중 승인을 접지 마라. 이유: 사람이 누를 때까지 에이전트가 멈춰 있다.
- 곁방 연결 카드를 접지 마라. 이유: 그 방으로 들어가는 입구다.
- 서버·프로토콜·`RoomModel` 의 상태 규칙을 바꾸지 마라. 묶기는 뷰 계층에서만.
- 기존 자동 스크롤·"새 메시지" 칩 동작을 바꾸지 마라. `.defaultScrollAnchor` 만 더한다.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
