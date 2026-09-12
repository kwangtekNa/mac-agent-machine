# Step 2: room-model

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/IOS.md` 6절(`TimelineModel.apply` 단일 변경 경로, seq 가드, REST → `since` 소켓), 7절 오류·엣지
- `/docs/PROTOCOL.md` 6.3 방 WS(스냅샷·`room.message.updated` 는 `message.id` 로 교체·`room.status`), 6.4 디스패치 규칙(멘션 문법·DM 규칙·팀원 state)
- `/ios/MacAgent/Features/Timeline/TimelineModel.swift` 전체 (`apply`, `applySnapshot`, `start`, `stop`, `resume`, `showTransient`, `ApprovalSubmitState`, `respond`, `isReplaying`, 햅틱)
- `/ios/MacAgent/Networking/EventSocket.swift` 또는 `RoomSocket.swift` (step 1), `APIClient.swift` (step 0 의 팀 메서드)
- `/ios/MacAgent/Models/Protocol/Room.swift`, `RoomEvent.swift`, `RoomClientMessage.swift`, `Team.swift`
- `/ios/MacAgent/Shared/ErrorMessages.swift`, `Haptics.swift`
- `/ios/MacAgentTests/Features/Timeline/TimelineModelTests.swift`, `TimelineModelUsageTests.swift` (fixture 이벤트를 seq 바꿔 넣는 헬퍼, `StubURLProtocol`, `FakeTransportFactory`)

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

방 화면의 상태 모델을 만든다. 뷰는 만들지 않는다(step 5·6). `TimelineModel` 을 거울처럼 따르되 방 이벤트에 맞춘다.

### 확정된 결정

- 사용자 메시지는 **낙관적으로 넣지 않는다**. 서버가 `room.message` 로 에코한다(IOS.md 6절과 같은 규칙).
- 승인 응답은 기존 `client.respondApproval(sessionId:approvalId:)`(카드의 `approval.sessionId`). 방 소켓으로 보내지 않는다.
- 머지·거절은 REST(`mergeChange`/`dismissChange`)로 보내고, 상태 확정은 `room.message.updated` 로 받는다(낙관적 갱신 없음, `mergeSubmit` 상태만 둔다).
- 그룹방에서 멘션 없는 메시지는 팀장에게 간다 → 컴포저 캡션용 `leadName` 을 노출한다.
- 작업 중 표시: `room.status` 의 `members[].state` 와 `dispatch` 로 "작업 중/대기 중" 팀원 목록을 계산한다(뷰가 말풍선·상태 줄로 그린다).

### 1. `Features/Rooms/RoomEntry.swift`

```swift
enum RoomEntry: Identifiable, Hashable {
    case message(RoomMessage)              // kind text (user/agent/system 작성자)
    case approval(RoomMessage)             // kind approval (message.approval 필수)
    case changes(RoomMessage)              // kind changes (message.changes 필수)
    case system(RoomMessage)               // kind system
    var id: String; var seq: Int; var createdAt: Date; var message: RoomMessage
    static func make(_ message: RoomMessage) -> RoomEntry   // kind·필드 조합으로 분류, 모르는 kind 는 .system 으로 강등
}
```

### 2. `Features/Rooms/MentionParser.swift` (순수)

```swift
struct MentionParser {
    /// 본문에서 @이름/@핸들을 팀원 id 로 해석(NFC·소문자 비교, 끝 문장부호 무시, `@all` → 전원). 서버 규칙(PROTOCOL 6.4)과 같다.
    static func mentions(in text: String, members: [TeamMember]) -> (memberIds: [String], all: Bool)
    /// 컴포저 자동완성: 텍스트 끝의 `@토큰`(공백 없음)이 있으면 그 접두어와 일치하는 팀원(이름·핸들 앞부분, 대소문자 무시)
    static func suggestions(for text: String, members: [TeamMember]) -> (token: Range<String.Index>, members: [TeamMember])?
    /// 제안 적용: 토큰을 `@이름 ` 으로 바꾼 텍스트
    static func apply(_ member: TeamMember, to text: String, token: Range<String.Index>) -> String
}
```

### 3. `Features/Rooms/RoomModel.swift`

```swift
@MainActor @Observable final class RoomModel {
    typealias SocketFactory = @MainActor (_ teamId: String, _ roomId: String, _ since: Int) -> RoomSocket
    let teamId: String; let roomId: String
    private(set) var room: Room?; private(set) var members: [TeamMember]      // start() 가 GET /teams/:id 로 채움
    private(set) var entries: [RoomEntry]                                       // seq 오름차순, id 로 교체
    private(set) var pendingApprovals: [RoomApproval]                           // requestedAt 오름차순
    private(set) var memberStates: [String: TeamMemberState]; private(set) var dispatch: DispatchState?
    private(set) var lastSeq: Int; private(set) var hasOlderHistory: Bool
    private(set) var transientError: String?; private(set) var fatalError: String?
    private(set) var isSending: Bool; private(set) var isReplaying: Bool
    private(set) var approvalSubmit: ApprovalSubmitState                       // TimelineModel 의 것을 재사용
    private(set) var mergeSubmit: MergeSubmitState                             // idle | submitting(changeId) | failed(changeId, message)
    private(set) var socket: RoomSocket?; var socketState: RoomSocket.State
    var isGroup: Bool; var dmMember: TeamMember?; var lead: TeamMember?
    var workingMembers: [TeamMember]   // state running 또는 waiting_approval
    var queuedMembers: [TeamMember]    // state queued
    init(teamId:roomId:client:transientErrorDuration:approvalFailureDuration:haptics:socketFactory:)
    func start() async      // GET /teams/:id(팀원·방) → GET /teams/:id/rooms/:roomId(최근 200) → 소켓 since=lastSeq
    func stop(); func resume()
    func apply(_ event: RoomEvent)   // 유일한 변경 경로
    func send(text: String, attachments: [Attachment]? = nil) async   // 소켓 open 이면 room.send, 아니면 REST postRoomMessage. 빈 텍스트 무시
    func respond(to approval: RoomApproval, optionId: String, inputs: [String: String]? = nil, message: String? = nil) async   // client.respondApproval
    func requestMerge(_ change: ChangeSet) async; func dismiss(_ change: ChangeSet) async
    func interrupt(memberId: String?) async     // room.interrupt
    func member(id: String) -> TeamMember?
}
```

`apply` 규칙:

- `seq > 0` 이면 `seq <= lastSeq` 는 무시하고 `lastSeq` 갱신; `seq == 0`(snapshot, pong) 은 예외.
- `roomSnapshot`: `room`·`members`(스냅샷의 `members[].state` 로 `memberStates`)·`dispatch` 교체, `messages` 를 upsert, `pendingApprovals` 교체, `lastSeq = max(lastSeq, room.lastSeq, messages.seq)`, `hasOlderHistory = truncated`, `isReplaying = true`.
- `roomMessage`: upsert(같은 id 는 교체, 아니면 seq 순 삽입). `kind: approval` 이고 `resolution == nil` 이면 `pendingApprovals` 에 추가 + `isReplaying` 이 아니면 `haptics.warning()`.
- `roomMessageUpdated`: id 로 교체(`message.seq` 는 원래 값이므로 정렬 유지). approval 의 `resolution` 이 채워지면 `pendingApprovals` 에서 제거; `approvalSubmit`/`mergeSubmit` 을 해당 id 기준으로 idle 로.
- `roomStatus`: `dispatch`, `memberStates` 갱신, 첫 라이브 이벤트에서 `isReplaying = false`.
- `roomError`: recoverable → `showTransient`, 아니면 `fatalError`.
- `pong`: 무시.

`send` 실패는 `ErrorMessages.sendFailed`. `respond` 는 `TimelineModel.respond` 와 같은 실패 정책(409/404 → "이미 처리된 요청입니다"). `requestMerge` 는 `mergeSubmit = .submitting`, REST 실패는 `.failed(changeId, ErrorMessages.message(for:))` 를 `approvalFailureDuration` 뒤 idle 로; 성공 응답의 `MergeResult.change` 로 해당 메시지의 `changes` 를 즉시 교체해도 된다(서버 확정값이므로).

### 4. `Features/Teams/MemberStatus.swift` (순수)

`static func status(member: TeamMember, roomState: TeamMemberState?, sessions: [Session]) -> TeamMemberState` — 방 이벤트 상태가 있으면 그것, 없으면 `sessions` 에서 `member.sessionId` 의 `status` 를 매핑(`running → running`, `waiting_approval → waitingApproval`, `error → error`, 그 외 `idle`). 세션 없음 → `idle`.

### 5. 테스트 (먼저 쓴다)

- `Features/Rooms/RoomModelTests.swift`: fixture `room-ws/room.snapshot.json` 적용 후 `entries` 4개·`pendingApprovals` 1개·`memberStates`·`lastSeq 4`; 중복·오래된 seq 무시; `room.message.agent`(seq 3 을 5 로 바꿔) 추가; `room.message.updated`(승인 resolution) 로 pending 에서 제거되고 정렬 유지; `room.status` 로 `workingMembers`; `room.error` recoverable/fatal; `start()` 가 REST 두 번 호출 후 `since = lastSeq` 로 소켓을 여는지(`StubURLProtocol` + `FakeTransportFactory`); `send` 가 소켓 open 이면 `room.send` JSON, 아니면 REST POST; `respond` 가 `POST /sessions/<sessionId>/approvals/<approvalId>` 를 부르는지; `requestMerge` 가 `POST /teams/<t>/changes/<c>/merge` 이고 실패 시 `mergeSubmit.failed`; 재생 중 햅틱 억제.
- `Features/Rooms/MentionParserTests.swift`: `@민수`, `@minsu`, `@민수,`, `@all`, 모르는 토큰, 자동완성(끝 `@지` → 지연, 중간 `@` 는 무시), `apply`.
- `Features/Teams/MemberStatusTests.swift`.

## Acceptance Criteria

```bash
cd ios && xcodegen generate --quiet && xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet test && cd ..
test -f ios/MacAgent/Features/Rooms/RoomModel.swift
test -f ios/MacAgent/Features/Rooms/MentionParser.swift
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - `apply(_:)` 가 유일한 변경 경로이고 뷰 코드가 없는가(IOS.md 6절)?
   - 승인·머지가 낙관적 갱신 없이 서버 확정값으로만 바뀌는가?
   - Swift 6 strict concurrency 경고가 없는가? `xcodegen generate` 를 실행했는가?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- 뷰(SwiftUI View)를 만들지 마라. 이유: step 5·6.
- 사용자 메시지를 낙관적으로 목록에 넣지 마라. 이유: 서버 에코가 단일 진실이며 seq 정렬이 깨진다.
- 방 소켓으로 승인 응답을 보내지 마라. 이유: 서버는 받지 않는다(PROTOCOL 6.3).
- `TimelineModel` 에 방 관련 코드를 넣지 마라.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
