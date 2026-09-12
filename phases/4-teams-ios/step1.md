# Step 1: event-socket-generalization

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/IOS.md` 6절(`SessionSocket` 재접속 규칙: 1→30초 백오프, `since=lastSeq`, 20초 ping, 백그라운드 종료)
- `/docs/PROTOCOL.md` 2절 세션 WS, 6.3 방 WS(경로 `/api/v1/teams/:teamId/rooms/:roomId/ws?since=`, 방 없음 close **4004**, `pong` 은 `seq 0`)
- `/ios/MacAgent/Networking/SessionSocket.swift` 전체 (`WebSocketTransport` 프로토콜, `State`, 정적 상수 `pingInterval`/`maxBackoffSeconds`/`jitterMilliseconds`/`closeCodeSessionNotFound`/`sessionNotFoundReason`/`pingText`, `backoffDelay(attempt:jitterMs:)`, `connect/send/disconnect`, `makeRequest(since:)`)
- `/ios/MacAgent/Models/Protocol/ServerEvent.swift`, `ClientMessage.swift`, `RoomEvent.swift`, `RoomClientMessage.swift` (step 0)
- `/ios/MacAgent/Features/Timeline/TimelineModel.swift` (`SocketFactory`, `socket.events`, `socket.state`)
- `/ios/MacAgentTests/Networking/SessionSocketTests.swift`, `FakeWebSocketTransport.swift` (`FakeTransportFactory`, `SleepRecorder` 가 `SessionSocket.pingInterval` 을 참조)

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

`SessionSocket` 을 이벤트·메시지 타입과 경로에 대해 일반화해 방 소켓을 **복제 없이** 얻는다. 기존 `SessionSocket` 의 공개 API·동작·테스트는 **바뀌지 않아야** 한다.

### 1. `Networking/EventSocket.swift`

```swift
protocol SocketEvent: Decodable, Sendable { var seq: Int { get }; var isPong: Bool { get } }
protocol SocketMessage: Encodable, Sendable { static var ping: Self { get } }
struct SocketEndpoint: Sendable { let path: String /* baseURL 기준, /api/v1 포함 */; let notFoundCloseCode: Int; let notFoundReason: String }
enum SocketPolicy {   // 정적 저장 프로퍼티는 제네릭 클래스에 둘 수 없으므로 여기로
    static let pingInterval: Duration = .seconds(20); static let maxBackoffSeconds = 30; static let jitterMilliseconds = 300
    static func backoffDelay(attempt: Int, jitterMs: Int) -> Duration
}
@MainActor @Observable final class EventSocket<Event: SocketEvent, Message: SocketMessage> {
    enum State: Equatable { case idle, connecting, open, reconnecting(attempt: Int), closed(reason: String) }
    init(baseURL: URL, endpoint: SocketEndpoint, since: Int, transportFactory: …, sleep: …)
    var state: State; var events: AsyncStream<Event>; var lastSeq: Int
    func connect(); func send(_ message: Message) async throws; func disconnect()
}
```

- `ServerEvent: SocketEvent`(`isPong` = `.pong` 케이스), `ClientMessage: SocketMessage`(`.ping`); `RoomEvent`/`RoomClientMessage` 도 같은 방식으로 확장한다.
- `typealias SessionSocket = EventSocket<ServerEvent, ClientMessage>` + `extension EventSocket where Event == ServerEvent, Message == ClientMessage { convenience init(baseURL:sessionId:since:transportFactory:sleep:) }` 와 기존 정적 이름(`SessionSocket.pingInterval`, `closeCodeSessionNotFound`, `sessionNotFoundReason`, `pingText`)을 **계산 프로퍼티** 로 유지해 `TimelineModel`, `SessionSocketTests`, `SleepRecorder` 가 무변경으로 컴파일·통과한다.
- `typealias RoomSocket = EventSocket<RoomEvent, RoomClientMessage>` + `convenience init(baseURL:teamId:roomId:since:…)`: 경로 `/api/v1/teams/<teamId>/rooms/<roomId>/ws`, `notFoundCloseCode 4004`, 사유 "방이 없습니다".
- 재접속은 항상 `since=lastSeq` 로 다시 요청하고, `lastSeq` 는 수신 이벤트의 `seq > 0` 일 때만 갱신(스냅샷·pong 은 0).
- `@Observable` 제네릭 클래스가 매크로·Swift 6 격리 문제로 불가능하면 **복제로 후퇴** 한다: `RoomSocket.swift` 를 `SessionSocket` 과 같은 구조로 따로 만들고 공통 로직(`backoffDelay`, 상태 머신)만 `SocketPolicy` 로 뽑는다. 어느 쪽을 택했는지와 이유를 summary 에 적는다.

### 2. 테스트 (먼저 쓴다)

- `SessionSocketTests` 는 **한 줄도 바꾸지 않고** 통과해야 한다.
- `Networking/RoomSocketTests.swift`: 요청 URL 이 `/api/v1/teams/<t>/rooms/<r>/ws?since=<n>` 인지; `room.snapshot`(seq 0) 뒤 `room.message`(seq 3) 를 받으면 `lastSeq == 3`; 연결이 끊기면 백오프 후 `since=3` 으로 재접속; close 4004 → `closed(reason:)` 이고 재접속하지 않음; `send(.send(text:…))` 가 `room-client/room.send.json` 과 같은 JSON; 20초마다 `ping`(`SleepRecorder` 재사용); `disconnect()` 후 이벤트 스트림 종료.

## Acceptance Criteria

```bash
cd ios && xcodegen generate --quiet && xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet test && cd ..
git diff --quiet -- ios/MacAgentTests/Networking/SessionSocketTests.swift
grep -q "RoomSocket" ios/MacAgent/Networking/EventSocket.swift || test -f ios/MacAgent/Networking/RoomSocket.swift
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 백오프·ping·4004 규칙이 세션 소켓과 방 소켓에서 동일한가(IOS.md 6절)?
   - `TimelineModel` 이 무변경인가? Swift 6 strict concurrency 경고가 없는가?
   - Swift 파일을 추가했으므로 `xcodegen generate` 를 실행했는가(CRITICAL 8)?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약, 일반화/복제 선택 포함)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- `SessionSocketTests.swift` 를 수정하지 마라. 이유: 세션 소켓의 동작이 바뀌지 않았음을 증명하는 기준선이다.
- 백오프·ping·close code 규칙을 바꾸지 마라. 이유: IOS.md 6절과 서버 규칙에 묶여 있다.
- URLSession 외의 네트워킹이나 새 SwiftPM 패키지를 쓰지 마라(ADR-012).
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
