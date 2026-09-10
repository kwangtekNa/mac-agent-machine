# Step 2: api-client

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/PROTOCOL.md` (0절 헤더·오류, 1절 REST, 2절 WebSocket `since`·`ping`)
- `/docs/IOS.md` (2절, 6절 상태와 데이터 흐름의 SessionSocket 규칙)
- `/ios/MacAgent/Models/Protocol/*.swift` (step 1. 이 타입들만 쓴다)
- `/packages/server/src/agent-host/ws.ts`, `/packages/server/src/agent-host/app.ts` (서버가 실제로 어떻게 응답하는지: 426/403 조건, WS close code 4004, 서버 ping)
- `/scripts/dev-smoke.mjs` (Node 쪽 클라이언트 구현. 같은 순서를 Swift로 옮긴다)

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

REST 클라이언트, WebSocket 세션 소켓, 서버 설정 저장소를 만든다. UI는 없다. 개발 서버(`bash scripts/dev-smoke.sh --keep`, `http://127.0.0.1:7777`)에 대해 수동으로 한 번 붙어 보되, 자동 테스트는 서버 없이 도는 스텁 기반이어야 한다.

### 1. `ios/MacAgent/Networking/APIClient.swift`

```swift
struct APIClient: Sendable {
  init(baseURL: URL, session: URLSession = .shared)
  func health() async throws -> Bool
  func me() async throws -> MeResponse
  func projects() async throws -> ProjectsResponse
  func sessions(cwd: String? = nil, status: SessionStatus? = nil) async throws -> [Session]
  func createSession(_ req: CreateSessionRequest) async throws -> Session
  func session(id: String) async throws -> SessionDetailResponse
  func patchSession(id: String, _ req: PatchSessionRequest) async throws -> Session
  func closeSession(id: String) async throws -> Session
  func respondApproval(sessionId: String, approvalId: String, _ req: ApprovalRespondRequest) async throws
  func listDirectory(path: String) async throws -> FsListResponse
  func readFile(path: String) async throws -> FsReadResponse
  func gitStatus(cwd: String) async throws -> GitStatusResponse
  func gitDiff(cwd: String, path: String?, staged: Bool) async throws -> GitDiffResponse
  func startLogin(agent: AgentKind) async throws -> LoginStartResponse
  func submitLoginCode(agent: AgentKind, flowId: String, code: String) async throws
  func loginStatus(agent: AgentKind, flowId: String) async throws -> LoginStatusResponse
}
enum APIError: Error { case server(code: ErrorCode, message: String, status: Int), unsupportedProtocol, transport(Error), decoding(Error), invalidURL }
```

- 모든 요청에 `X-MAM-Protocol: 1`, `Accept: application/json`, 본문이 있으면 `Content-Type: application/json`. 기본 경로 `/api/v1`.
- 쿼리(`path`, `cwd`)는 `URLComponents.queryItems`로 넣는다(한글·공백·`~` 안전). 문자열 연결로 URL을 만들지 마라.
- 2xx가 아니면 본문을 `ErrorResponse`로 디코드해 `.server`, 426은 `.unsupportedProtocol`, 디코드 불가면 `.server(code: .internal, message: 상태코드)`.
- 타임아웃: 요청 30초. `readFile`은 60초.

### 2. `ios/MacAgent/Networking/SessionSocket.swift`

```swift
protocol WebSocketTransport: Sendable {
  func connect(_ request: URLRequest) async throws
  func receiveText() async throws -> String
  func send(text: String) async throws
  func close()
}
final class URLSessionWebSocketTransport: WebSocketTransport   // URLSessionWebSocketTask 래핑

@MainActor @Observable final class SessionSocket {
  enum State: Equatable { case idle, connecting, open, reconnecting(attempt: Int), closed(reason: String?) }
  private(set) var state: State
  private(set) var lastSeq: Int
  let events: AsyncStream<ServerEvent>
  init(baseURL: URL, sessionId: String, since: Int = 0, transportFactory: @escaping @Sendable () -> WebSocketTransport = { URLSessionWebSocketTransport() }, sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) })
  func connect()
  func send(_ message: ClientMessage) async throws
  func disconnect()
}
```

- URL: `ws(s)://<host>/api/v1/sessions/<id>/ws?since=<lastSeq>`. 핸드셰이크 요청에 `X-MAM-Protocol: 1`.
- 수신 프레임을 `ServerEvent`로 디코드해 스트림에 흘린다. `seq > 0`인 이벤트는 `lastSeq = max(lastSeq, seq)`. 디코드 실패 프레임은 로그 후 무시(연결 유지).
- 끊기면(수신 오류, close) `reconnecting(attempt)`로 바꾸고 1, 2, 4, …, 30초(+0~300ms 지터) 뒤 `since=lastSeq`로 다시 붙는다. `disconnect()` 후에는 재접속하지 않는다. close code 4004(세션 없음)면 재접속하지 않고 `.closed(reason: "세션이 없습니다")`.
- 20초마다 `ping`을 보낸다. `pong`은 스트림에 흘리지 않는다(내부 소비).
- `send`는 `state == .open`이 아니면 `SocketError.notOpen`을 던진다.
- 백그라운드 전환 처리(`scenePhase`)는 호출자(뷰모델) 책임. 여기서는 `disconnect()`/`connect()`만 제공.

### 3. `ios/MacAgent/Networking/ServerConfigStore.swift`

- `struct ServerConfig: Codable, Equatable { var baseURL: URL }`, `@Observable final class ServerConfigStore { var config: ServerConfig?; func save(_:); func clear() }`. 저장은 `UserDefaults.standard` 키 `mam.server.config`(JSON).
- `static func normalize(_ input: String) throws -> URL`: 스킴 없으면 `https://` 추가, 끝 `/` 제거, `http`는 호스트가 `127.0.0.1`·`localhost`·사설 IP·`*.local`일 때만 허용(그 외 http는 `ConfigError.insecureScheme`). 포트 허용.
- `func wsBaseURL(from httpURL: URL) -> URL` (`http`→`ws`, `https`→`wss`).

### 4. 테스트 (`ios/MacAgentTests/Networking/`)

- `StubURLProtocol.swift`: 요청을 가로채 등록된 핸들러로 응답. `URLSessionConfiguration.ephemeral`에 등록.
- `APIClientTests.swift`: 헤더 존재, `listDirectory(path: "/Users/alice/작업 폴더")`의 쿼리 인코딩, `me()` 디코드(fixture `rest/me.json` 재사용), 403 `ErrorResponse` → `.server(code: .forbidden)`, 426 → `.unsupportedProtocol`, 본문 없는 500 → `.server(code: .internal)`, `createSession` 요청 본문 JSON 검증.
- `FakeWebSocketTransport.swift` + `SessionSocketTests.swift`: 프레임 3개(fixture `ws/session.snapshot.json`, `ws/item.started.tool_call.json`, `ws/pong.json`) 전달 → 스트림에 2개(pong 제외), `lastSeq` 갱신; 전송 오류 후 재접속 시 `since=lastSeq` 쿼리와 백오프 순서(주입한 `sleep`이 기록한 Duration 배열 `[1, 2, 4]`초); `disconnect()` 후 재접속 없음; 4004 → `.closed`; `send`가 `ClientMessage`를 fixture와 같은 JSON으로 인코드.
- `ServerConfigStoreTests.swift`: normalize 케이스(스킴 없음, `http://127.0.0.1:7777` 허용, `http://example.com` 거부, 끝 슬래시), 저장/삭제 왕복.

### 5. 수동 확인 1회

`bash scripts/dev-smoke.sh --keep`으로 서버를 띄운 뒤 시뮬레이터가 아닌 **테스트 코드 안에서** 환경변수 `MAM_IT_SERVER`가 설정되어 있을 때만 도는 통합 테스트 1개(`APIClientIntegrationTests`, 기본은 `XCTSkip`)를 만들어 `/me`와 세션 생성 → WS 스냅샷 수신까지 확인하고 결과를 summary에 적어라. 끝나면 서버를 종료한다.

## Acceptance Criteria

```bash
cd ios && xcodegen generate --quiet && xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet test && cd ..
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - `docs/IOS.md` 6절의 SessionSocket 규칙(since 재접속, 백오프, ping, 4004)을 지키는가?
   - URLSession 외의 네트워킹 의존성이 없는가(ADR-012)?
   - 서버 응답을 임의 딕셔너리로 다루지 않고 step 1 모델만 쓰는가?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- 클라이언트가 `X-MAM-User`나 이메일 같은 신원 헤더를 보내지 마라. 이유: 신원은 gateway가 정한다(CRITICAL 1). 서버는 위조 헤더를 덮어쓰지만 앱이 보낼 이유가 없다.
- 서버 코드(`packages/server`)를 수정하지 마라. 계약 문제는 `needs_input`.
- 자동 테스트가 실제 서버에 의존하게 하지 마라(통합 테스트는 환경변수 게이트 + 기본 skip).
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
