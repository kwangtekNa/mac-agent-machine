import Foundation
import Observation
import os

/// WebSocket 전송 추상화. 실제 구현은 `URLSessionWebSocketTransport`, 테스트는 가짜 transport 를 주입한다.
/// 서버가 close 프레임으로 끊었으면 `receiveText()` 가 `SocketError.closed(code:reason:)` 를 던져야 한다.
protocol WebSocketTransport: Sendable {
    func connect(_ request: URLRequest) async throws
    func receiveText() async throws -> String
    func send(text: String) async throws
    func close()
}

enum SocketError: Error, Equatable, Sendable {
    /// `state != .open` 인데 보내려 했다.
    case notOpen
    /// 상대가 close 프레임을 보냈거나 연결이 닫혔다.
    case closed(code: Int?, reason: String?)
    case invalidURL
    case unexpectedFrame
}

/// `URLSessionWebSocketTask` 래퍼. 연결 1회용이며 `connect` 는 핸드셰이크 완료(101)까지 기다린다.
final class URLSessionWebSocketTransport: NSObject, WebSocketTransport, URLSessionWebSocketDelegate, @unchecked Sendable {
    private let configuration: URLSessionConfiguration
    private let lock = NSLock()
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var openContinuation: CheckedContinuation<Void, any Error>?
    private var closeCode: Int?
    private var closeReason: String?

    init(configuration: URLSessionConfiguration = .default) {
        self.configuration = configuration
        super.init()
    }

    func connect(_ request: URLRequest) async throws {
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        let task = session.webSocketTask(with: request)
        lock.withLock {
            self.session = session
            self.task = task
        }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            lock.withLock { openContinuation = continuation }
            task.resume()
        }
    }

    func receiveText() async throws -> String {
        guard let task = lock.withLock({ task }) else { throw SocketError.notOpen }
        let message: URLSessionWebSocketTask.Message
        do {
            message = try await task.receive()
        } catch {
            throw closedError(task) ?? error
        }
        switch message {
        case .string(let text): return text
        case .data(let data): return String(decoding: data, as: UTF8.self)
        @unknown default: throw SocketError.unexpectedFrame
        }
    }

    func send(text: String) async throws {
        guard let task = lock.withLock({ task }) else { throw SocketError.notOpen }
        try await task.send(.string(text))
    }

    func close() {
        let (task, session) = lock.withLock {
            let pair = (self.task, self.session)
            self.task = nil
            self.session = nil
            return pair
        }
        task?.cancel(with: .normalClosure, reason: nil)
        session?.finishTasksAndInvalidate()
        resumeOpen(.failure(SocketError.closed(code: nil, reason: "closed by client")))
    }

    private func closedError(_ task: URLSessionWebSocketTask) -> SocketError? {
        let (code, reason) = lock.withLock { (closeCode, closeReason) }
        if let code { return .closed(code: code, reason: reason) }
        let raw = task.closeCode.rawValue
        if raw != 0 {
            return .closed(code: raw, reason: task.closeReason.map { String(decoding: $0, as: UTF8.self) })
        }
        return nil
    }

    private func resumeOpen(_ result: Result<Void, any Error>) {
        let continuation = lock.withLock {
            let c = openContinuation
            openContinuation = nil
            return c
        }
        continuation?.resume(with: result)
    }

    // MARK: URLSessionWebSocketDelegate

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        resumeOpen(.success(()))
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        let reasonText = reason.map { String(decoding: $0, as: UTF8.self) }
        lock.withLock {
            self.closeCode = closeCode.rawValue
            self.closeReason = reasonText
        }
        resumeOpen(.failure(SocketError.closed(code: closeCode.rawValue, reason: reasonText)))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        let (code, reason) = lock.withLock { (closeCode, closeReason) }
        resumeOpen(.failure(error ?? SocketError.closed(code: code, reason: reason)))
    }
}

/// 세션 WS(IOS.md 6절). 이벤트를 `events` 스트림으로 흘리고, 끊기면 `since=lastSeq` 로 백오프 재접속한다.
/// 백그라운드 전환 처리는 호출자 책임이다(`disconnect()` / `connect()`).
@MainActor @Observable
final class SessionSocket {
    enum State: Equatable, Sendable {
        case idle
        case connecting
        case open
        case reconnecting(attempt: Int)
        case closed(reason: String?)
    }

    nonisolated static let pingInterval: Duration = .seconds(20)
    nonisolated static let maxBackoffSeconds = 30
    nonisolated static let jitterMilliseconds = 300
    /// agent-host/ws.ts `WS_CLOSE_SESSION_NOT_FOUND`.
    nonisolated static let closeCodeSessionNotFound = 4004
    nonisolated static let sessionNotFoundReason = "세션이 없습니다"
    static let pingText: String = {
        if let data = try? JSONCoding.encoder.encode(ClientMessage.ping) {
            return String(decoding: data, as: UTF8.self)
        }
        return "{\"type\":\"ping\"}"
    }()

    private(set) var state: State = .idle
    private(set) var lastSeq: Int
    let events: AsyncStream<ServerEvent>

    private let continuation: AsyncStream<ServerEvent>.Continuation
    private let baseURL: URL
    private let sessionId: String
    private let transportFactory: @Sendable () -> any WebSocketTransport
    private let sleep: @Sendable (Duration) async throws -> Void
    private let logger = Logger(subsystem: "dev.mam.MacAgent", category: "SessionSocket")
    @ObservationIgnored private var runTask: Task<Void, Never>?
    @ObservationIgnored private var pingTask: Task<Void, Never>?
    @ObservationIgnored private var transport: (any WebSocketTransport)?
    /// `disconnect()` 마다 증가. 이전 세대의 실행 루프는 공유 상태를 건드리지 않는다.
    @ObservationIgnored private var generation = 0

    init(
        baseURL: URL,
        sessionId: String,
        since: Int = 0,
        transportFactory: @escaping @Sendable () -> any WebSocketTransport = { URLSessionWebSocketTransport() },
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) {
        self.baseURL = baseURL
        self.sessionId = sessionId
        self.lastSeq = since
        self.transportFactory = transportFactory
        self.sleep = sleep
        let (stream, continuation) = AsyncStream.makeStream(of: ServerEvent.self)
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

    func send(_ message: ClientMessage) async throws {
        guard state == .open, let transport else { throw SocketError.notOpen }
        let data = try JSONCoding.encoder.encode(message)
        try await transport.send(text: String(decoding: data, as: UTF8.self))
    }

    func disconnect() {
        generation += 1
        runTask?.cancel()
        runTask = nil
        pingTask?.cancel()
        pingTask = nil
        transport?.close()
        transport = nil
        state = .closed(reason: nil)
    }

    /// 1, 2, 4, …, 30초 + 지터.
    nonisolated static func backoffDelay(attempt: Int, jitterMs: Int) -> Duration {
        let exponent = max(0, min(attempt - 1, 5))
        let seconds = min(1 << exponent, maxBackoffSeconds)
        return .seconds(seconds) + .milliseconds(jitterMs)
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
            if let failure, Self.isSessionNotFound(failure) {
                state = .closed(reason: Self.sessionNotFoundReason)
                return
            }
            attempt += 1
            state = .reconnecting(attempt: attempt)
            do {
                try await sleep(Self.backoffDelay(attempt: attempt, jitterMs: Int.random(in: 0...Self.jitterMilliseconds)))
            } catch {
                return
            }
        }
    }

    /// 프레임 1개 처리. 디코드에 성공하면 true. `pong` 은 내부에서 소비한다. 실패 프레임은 로그 후 무시(내용은 남기지 않는다).
    private func handle(_ text: String) -> Bool {
        do {
            let event = try JSONCoding.decoder.decode(ServerEvent.self, from: Data(text.utf8))
            if event.seq > 0 { lastSeq = max(lastSeq, event.seq) }
            if case .pong = event { return true }
            continuation.yield(event)
            return true
        } catch {
            logger.warning("프레임 디코드 실패(\(text.utf8.count) bytes): \(String(describing: error), privacy: .public)")
            return false
        }
    }

    private func makePingTask(_ transport: any WebSocketTransport) -> Task<Void, Never> {
        let sleep = self.sleep
        return Task {
            while !Task.isCancelled {
                do { try await sleep(Self.pingInterval) } catch { return }
                if Task.isCancelled { return }
                do { try await transport.send(text: Self.pingText) } catch { return }
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
        components.path = basePath + "\(APIClient.apiPrefix)/sessions/\(sessionId)/ws"
        components.queryItems = [URLQueryItem(name: "since", value: String(since))]
        guard let url = components.url else { throw SocketError.invalidURL }
        var request = URLRequest(url: url)
        request.setValue(APIClient.protocolVersion, forHTTPHeaderField: "X-MAM-Protocol")
        return request
    }

    nonisolated private static func isSessionNotFound(_ error: any Error) -> Bool {
        if let socketError = error as? SocketError, case .closed(let code, _) = socketError {
            return code == closeCodeSessionNotFound
        }
        return false
    }
}
