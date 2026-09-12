import Foundation
import Observation
import os

// 세션 WS(PROTOCOL.md 2절)와 방 WS(6.3)는 경로·이벤트 타입만 다르고 규칙(IOS.md 6절)은 같다:
// 접속 직후 스냅샷(seq 0) → `since` 이후 재생 → 라이브, 끊기면 1→30초 백오프로 `since=lastSeq` 재접속,
// 20초마다 `ping`, 대상 없음 close code 4004 면 재접속하지 않는다. `EventSocket` 이 이 규칙을 한 번만 구현하고
// `SessionSocket`/`RoomSocket` 은 타입 인자만 다른 별칭이다.

/// 서버 → 클라이언트 이벤트 union 이 갖춰야 할 것. `seq` 는 스냅샷·pong 이면 0.
protocol SocketEvent: Decodable, Sendable {
    var seq: Int { get }
    /// `pong` 이면 true. 소켓이 내부에서 소비하고 스트림에 흘리지 않는다.
    var isPong: Bool { get }
}

/// 클라이언트 → 서버 메시지 union 이 갖춰야 할 것.
protocol SocketMessage: Encodable, Sendable {
    static var ping: Self { get }
}

/// WS 엔드포인트. `path` 는 baseURL 기준이며 `/api/v1` 을 포함한다.
struct SocketEndpoint: Sendable, Equatable {
    let path: String
    /// 대상(세션·방)이 없을 때 서버가 보내는 close code. 받으면 재접속하지 않는다.
    let notFoundCloseCode: Int
    /// 그때 `State.closed(reason:)` 에 넣는 문구.
    let notFoundReason: String

    /// agent-host/ws.ts `WS_CLOSE_SESSION_NOT_FOUND`.
    static let sessionNotFoundCloseCode = 4004
    static let sessionNotFoundReason = "세션이 없습니다"
    /// PROTOCOL.md 6.3: 방이 없으면 close code 4004.
    static let roomNotFoundCloseCode = 4004
    static let roomNotFoundReason = "방이 없습니다"

    /// `GET /api/v1/sessions/:id/ws`.
    static func session(id: String) -> SocketEndpoint {
        SocketEndpoint(
            path: "\(APIClient.apiPrefix)/sessions/\(id)/ws",
            notFoundCloseCode: sessionNotFoundCloseCode,
            notFoundReason: sessionNotFoundReason
        )
    }

    /// `GET /api/v1/teams/:teamId/rooms/:roomId/ws`.
    static func room(teamId: String, roomId: String) -> SocketEndpoint {
        SocketEndpoint(
            path: "\(APIClient.apiPrefix)/teams/\(teamId)/rooms/\(roomId)/ws",
            notFoundCloseCode: roomNotFoundCloseCode,
            notFoundReason: roomNotFoundReason
        )
    }
}

/// 재접속·ping 규칙(IOS.md 6절). 제네릭 클래스는 정적 저장 프로퍼티를 가질 수 없어 여기에 둔다.
enum SocketPolicy {
    static let pingInterval: Duration = .seconds(20)
    static let maxBackoffSeconds = 30
    static let jitterMilliseconds = 300

    /// 1, 2, 4, …, 30초 + 지터.
    static func backoffDelay(attempt: Int, jitterMs: Int) -> Duration {
        let exponent = max(0, min(attempt - 1, 5))
        let seconds = min(1 << exponent, maxBackoffSeconds)
        return .seconds(seconds) + .milliseconds(jitterMs)
    }
}

/// 이벤트 스트림 WS. 이벤트를 `events` 스트림으로 흘리고, 끊기면 `since=lastSeq` 로 백오프 재접속한다.
/// 백그라운드 전환 처리는 호출자 책임이다(`disconnect()` / `connect()`).
/// `disconnect()` 는 최종이다: 이벤트 스트림이 끝나므로 다시 붙으려면 새 인스턴스를 만든다.
@MainActor @Observable
final class EventSocket<Event: SocketEvent, Message: SocketMessage> {
    enum State: Equatable, Sendable {
        case idle
        case connecting
        case open
        case reconnecting(attempt: Int)
        case closed(reason: String?)
    }

    nonisolated static var pingInterval: Duration { SocketPolicy.pingInterval }
    nonisolated static var maxBackoffSeconds: Int { SocketPolicy.maxBackoffSeconds }
    nonisolated static var jitterMilliseconds: Int { SocketPolicy.jitterMilliseconds }
    /// `Message.ping` 을 인코딩한 프레임.
    nonisolated static var pingText: String {
        if let data = try? JSONCoding.encoder.encode(Message.ping) {
            return String(decoding: data, as: UTF8.self)
        }
        return "{\"type\":\"ping\"}"
    }

    private(set) var state: State = .idle
    /// 마지막으로 받은 `seq > 0` 이벤트의 seq. 재접속 `since` 로 쓴다. 스냅샷·pong(seq 0)은 갱신하지 않는다.
    private(set) var lastSeq: Int
    let events: AsyncStream<Event>
    let endpoint: SocketEndpoint

    private let continuation: AsyncStream<Event>.Continuation
    private let baseURL: URL
    private let transportFactory: @Sendable () -> any WebSocketTransport
    private let sleep: @Sendable (Duration) async throws -> Void
    private let logger = Logger(subsystem: "dev.mam.MacAgent", category: "EventSocket")
    @ObservationIgnored private var runTask: Task<Void, Never>?
    @ObservationIgnored private var pingTask: Task<Void, Never>?
    @ObservationIgnored private var transport: (any WebSocketTransport)?
    /// `disconnect()` 마다 증가. 이전 세대의 실행 루프는 공유 상태를 건드리지 않는다.
    @ObservationIgnored private var generation = 0

    init(
        baseURL: URL,
        endpoint: SocketEndpoint,
        since: Int = 0,
        transportFactory: @escaping @Sendable () -> any WebSocketTransport = { URLSessionWebSocketTransport() },
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) {
        self.baseURL = baseURL
        self.endpoint = endpoint
        self.lastSeq = since
        self.transportFactory = transportFactory
        self.sleep = sleep
        let (stream, continuation) = AsyncStream.makeStream(of: Event.self)
        self.events = stream
        self.continuation = continuation
    }

    deinit {
        continuation.finish()
    }

    func connect() {
        guard runTask == nil else { return }
        generation += 1
        let gen = generation
        runTask = Task { await self.run(generation: gen) }
    }

    func send(_ message: Message) async throws {
        guard state == .open, let transport else { throw SocketError.notOpen }
        let data = try JSONCoding.encoder.encode(message)
        try await transport.send(text: String(decoding: data, as: UTF8.self))
    }

    /// 소켓을 닫고 재접속을 멈춘다. 이벤트 스트림도 끝난다.
    func disconnect() {
        generation += 1
        runTask?.cancel()
        runTask = nil
        pingTask?.cancel()
        pingTask = nil
        transport?.close()
        transport = nil
        state = .closed(reason: nil)
        continuation.finish()
    }

    /// 1, 2, 4, …, 30초 + 지터. `SocketPolicy.backoffDelay` 와 같다.
    nonisolated static func backoffDelay(attempt: Int, jitterMs: Int) -> Duration {
        SocketPolicy.backoffDelay(attempt: attempt, jitterMs: jitterMs)
    }

    // MARK: - 실행 루프

    private func run(generation gen: Int) async {
        defer { if gen == generation { runTask = nil } }
        var attempt = 0
        while !Task.isCancelled, gen == generation {
            state = attempt == 0 ? .connecting : .reconnecting(attempt: attempt)
            let transport = transportFactory()
            var failure: (any Error)?
            do {
                let request = try makeRequest(since: lastSeq)
                try await transport.connect(request)
                guard !Task.isCancelled, gen == generation else {
                    transport.close()
                    return
                }
                self.transport = transport
                state = .open
                pingTask?.cancel()
                pingTask = makePingTask(transport)
                while true {
                    let text = try await transport.receiveText()
                    if handle(text) { attempt = 0 }
                }
            } catch {
                failure = error
            }
            transport.close()
            guard !Task.isCancelled, gen == generation else { return }
            pingTask?.cancel()
            pingTask = nil
            self.transport = nil
            if let failure, isNotFound(failure) {
                state = .closed(reason: endpoint.notFoundReason)
                return
            }
            attempt += 1
            state = .reconnecting(attempt: attempt)
            do {
                try await sleep(SocketPolicy.backoffDelay(
                    attempt: attempt, jitterMs: Int.random(in: 0...SocketPolicy.jitterMilliseconds)
                ))
            } catch {
                return
            }
        }
    }

    /// 프레임 1개 처리. 디코드에 성공하면 true. `pong` 은 내부에서 소비한다. 실패 프레임은 로그 후 무시(내용은 남기지 않는다).
    private func handle(_ text: String) -> Bool {
        do {
            let event = try JSONCoding.decoder.decode(Event.self, from: Data(text.utf8))
            if event.seq > 0 { lastSeq = max(lastSeq, event.seq) }
            if event.isPong { return true }
            continuation.yield(event)
            return true
        } catch {
            logger.warning("프레임 디코드 실패(\(text.utf8.count) bytes): \(String(describing: error), privacy: .public)")
            return false
        }
    }

    private func makePingTask(_ transport: any WebSocketTransport) -> Task<Void, Never> {
        let sleep = self.sleep
        let pingText = Self.pingText
        return Task {
            while !Task.isCancelled {
                do { try await sleep(SocketPolicy.pingInterval) } catch { return }
                if Task.isCancelled { return }
                do { try await transport.send(text: pingText) } catch { return }
            }
        }
    }

    private func makeRequest(since: Int) throws -> URLRequest {
        let wsBase = ServerConfigStore.wsBaseURL(from: baseURL)
        guard var components = URLComponents(url: wsBase, resolvingAgainstBaseURL: false) else {
            throw SocketError.invalidURL
        }
        var basePath = components.path
        while basePath.hasSuffix("/") { basePath.removeLast() }
        components.path = basePath + endpoint.path
        components.queryItems = [URLQueryItem(name: "since", value: String(since))]
        guard let url = components.url else { throw SocketError.invalidURL }
        var request = URLRequest(url: url)
        request.setValue(APIClient.protocolVersion, forHTTPHeaderField: "X-MAM-Protocol")
        return request
    }

    private func isNotFound(_ error: any Error) -> Bool {
        if let socketError = error as? SocketError, case .closed(let code, _) = socketError {
            return code == endpoint.notFoundCloseCode
        }
        return false
    }
}

// MARK: - 세션 WS

/// 세션 WS(PROTOCOL.md 2절, IOS.md 6절).
typealias SessionSocket = EventSocket<ServerEvent, ClientMessage>

extension EventSocket where Event == ServerEvent, Message == ClientMessage {
    /// agent-host/ws.ts `WS_CLOSE_SESSION_NOT_FOUND`.
    nonisolated static var closeCodeSessionNotFound: Int { SocketEndpoint.sessionNotFoundCloseCode }
    nonisolated static var sessionNotFoundReason: String { SocketEndpoint.sessionNotFoundReason }

    convenience init(
        baseURL: URL,
        sessionId: String,
        since: Int = 0,
        transportFactory: @escaping @Sendable () -> any WebSocketTransport = { URLSessionWebSocketTransport() },
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) {
        self.init(
            baseURL: baseURL, endpoint: .session(id: sessionId), since: since,
            transportFactory: transportFactory, sleep: sleep
        )
    }
}

// MARK: - 방 WS

/// 방 WS(PROTOCOL.md 6.3). 방 seq 는 세션 seq 와 별개다(ADR-017).
typealias RoomSocket = EventSocket<RoomEvent, RoomClientMessage>

extension EventSocket where Event == RoomEvent, Message == RoomClientMessage {
    nonisolated static var closeCodeRoomNotFound: Int { SocketEndpoint.roomNotFoundCloseCode }
    nonisolated static var roomNotFoundReason: String { SocketEndpoint.roomNotFoundReason }

    convenience init(
        baseURL: URL,
        teamId: String,
        roomId: String,
        since: Int = 0,
        transportFactory: @escaping @Sendable () -> any WebSocketTransport = { URLSessionWebSocketTransport() },
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) {
        self.init(
            baseURL: baseURL, endpoint: .room(teamId: teamId, roomId: roomId), since: since,
            transportFactory: transportFactory, sleep: sleep
        )
    }
}

// MARK: - 프로토콜 타입 적합

extension ServerEvent: SocketEvent {
    var isPong: Bool {
        if case .pong = self { return true }
        return false
    }
}

extension ClientMessage: SocketMessage {}

extension RoomEvent: SocketEvent {
    var isPong: Bool {
        if case .pong = self { return true }
        return false
    }
}

extension RoomClientMessage: SocketMessage {}
