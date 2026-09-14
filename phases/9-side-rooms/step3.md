# Step 3: ios-side-rooms

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md` (CRITICAL 8)
- `/docs/IOS.md` 10.2(방 목록·방 화면), 10.3(카드), 10.4(iPad), 5절 디자인 규칙
- `/docs/PROTOCOL.md` 6.1·6.4·**6.6 곁방**(step 1)
- `/packages/protocol/fixtures/rest/team.json`, `room-ws/room.message.side-opened.json`, `room.message.side-closed.json`
- `/ios/MacAgent/Models/Protocol/Room.swift`(`RoomKind`, `Room`, `RoomMessage`), `Team.swift`
- `/ios/MacAgentTests/ProtocolFixturesTests.swift`(새 fixture 가 `JSONValue` 로 임시 등록돼 있다)
- `/ios/MacAgent/Features/Teams/TeamRoomsView.swift`(`RoomRef`, `TeamRoomsLogic` 의 행 정렬·상태 점), `/ios/MacAgent/Features/Rooms/RoomView.swift`, `RoomModel.swift`, `RoomEntry.swift`, `Cards/MessageCard.swift`, `/ios/MacAgent/Shared/MemberAvatar.swift`(`MemberChip`)
- `/ios/MacAgentTests/Features/Teams/*.swift`, `Features/Rooms/RoomModelTests.swift`

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 확정된 결정

- 방 목록에 **"에이전트 간" 섹션**으로 곁방을 보인다(`#전체` → DM → 곁방 순). 사람이 들어가 읽고 **직접 끼어들 수 있다**(컴포저 그대로).
- 그룹방의 연결 카드(`sideRoom`)는 한 줄 카드로 그리고, 탭하면 그 곁방으로 이동한다.

## 작업

### 1. 모델

- `RoomKind` 에 `side` 추가(lenient 유지: 모르는 값은 `.unknown`).
- `Room.participants: [String]?`.
- `RoomMessage.sideRoom: SideRoomRef?` — `SideRoomRef { roomId, participants, kind: SideRoomEventKind(lenient: opened/closed/unknown), messages }`.
- `TeamSettings.sideRoomMaxParticipants`.
- `ProtocolFixturesTests`: 임시 `JSONValue` 항목을 실제 타입으로 교체(파일 수는 그대로).

### 2. 방 목록 (`TeamRoomsView` / `TeamRoomsLogic`)

- 행 분류를 `group` / `dm` / `side` 세 섹션으로. 곁방 행: 참가자 `MemberAvatar` 를 겹쳐 보이고 이름은 `카파시 ↔ icml`, 부제는 마지막 메시지 시각(기존 규칙 재사용). 식별자 `rooms.side.<roomId>`.
- 곁방이 없으면 섹션 자체를 숨긴다.
- 정렬: 최근 메시지 순(없으면 이름 순).
- 순수 로직은 `TeamRoomsLogic` 에 두고 표 기반 테스트.

### 3. 연결 카드 (`Features/Rooms/Cards/SideRoomCard.swift`)

```swift
struct SideRoomCardState: Equatable {
    let title: String        // "카파시 ↔ icml 곁방을 열었습니다" / "… 곁방 대화 7건"
    let detail: String?      // closed 의 결론 한 줄(text 에서 "결론: " 뒤)
    let isClosed: Bool
    let roomId: String
    static func make(message: RoomMessage, members: [TeamMember]) -> SideRoomCardState?
}
struct SideRoomCard: View { let state: SideRoomCardState; let onOpen: (String) -> Void }
```

- `ItemCard(chrome:…)` 에 `bubble.left.and.bubble.right` `.secondary` 아이콘, 참가자 아바타, 전체가 버튼(→ 그 곁방으로 push). 식별자 `room.sideRoom.<roomId>`.
- `RoomEntry` 분류에서 `kind == .system && message.sideRoom != nil` → `.sideRoom(message)` 케이스를 추가하고 `RoomEntryRow` 가 이 카드를 그린다. `sideRoom` 이 없는 시스템 메시지는 기존처럼.

### 4. 방 화면 (`RoomView`)

- 곁방도 같은 화면을 쓴다. 툴바 principal 제목은 방 이름, 부제는 "에이전트 간 · 참가자 N명".
- 컴포저 캡션: 곁방이고 멘션이 없으면 "참가자 전원에게 전달됩니다"(그룹방의 "팀장에게 전달됩니다" 와 같은 자리·같은 규칙). 순수 함수 `RoomComposerState` 확장.
- 멘션 자동완성 후보는 **그 방 참가자** 로 제한한다(곁방일 때). 그룹방·DM 은 기존대로 전체 팀원.
- 내비게이션: 연결 카드 탭 → `RoomRef(teamId:roomId:)` push(compact) / `AppState.selectedRoom` 갱신(regular). 이미 있는 경로를 재사용한다.

### 5. `RoomModel`

- `room.kind == .side` 일 때 `members` 를 참가자로 좁힌 `participants: [TeamMember]` 계산 프로퍼티(자동완성·캡션·아바타가 쓴다).
- 나머지(`apply`, 승인, 머지, 소켓)는 그대로. 곁방도 같은 WS 경로다.

### 6. 테스트 (먼저 쓴다)

- `ProtocolFixturesTests`: 새 fixture 실제 타입 디코딩, `sideRoom.kind` lenient.
- `TeamRoomsLogicTests`: 세 섹션 분류·정렬·곁방 없을 때 섹션 숨김.
- `SideRoomCardStateTests`: opened/closed 문구, 결론 추출, 참가자 이름 매핑, `sideRoom` 없으면 nil.
- `RoomComposerStateTests` 확장: 곁방 캡션, 자동완성 후보가 참가자로 제한됨.
- `RoomModelTests` 확장: 곁방 스냅샷에서 `participants` 파생.
- 렌더 확인: `SideRoomCard` 가 호스팅에서 제목 텍스트를 담는지.

## Acceptance Criteria

```bash
cd ios && xcodegen generate --quiet && xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet test && cd ..
test -f ios/MacAgent/Features/Rooms/Cards/SideRoomCard.swift
grep -q "rooms.side" ios/MacAgent/Features/Teams/TeamRoomsView.swift
! grep -n "JSONValue.self" ios/MacAgentTests/ProtocolFixturesTests.swift
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 곁방이 기존 `RoomView`·`RoomModel`·방 WS 를 그대로 쓰는가(중복 구현 없음)?
   - 시스템 색·SF Symbol·한국어 문구 규칙(5.4, 5.5)? `RoomView` 안에 `NavigationStack` 중첩이 없는가?
   - `xcodegen generate` 를 실행했는가(CRITICAL 8)?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`
   - 실패 → `error` / 개입 필요 → `blocked` / 설계 분기 → `needs_input`

## 금지사항

- 곁방 전용 화면을 새로 만들지 마라. 이유: `RoomView` 재사용이 이 설계의 전제다.
- 사람이 곁방에 글 쓰는 것을 막지 마라(확정: 끼어들기 가능).
- 서버·프로토콜을 수정하지 마라. 불일치는 `needs_input`.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
