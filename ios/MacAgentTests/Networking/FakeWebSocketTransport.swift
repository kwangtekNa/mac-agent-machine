import Foundation
@testable import MacAgent

/// 스크립트된 프레임/오류를 순서대로 돌려주는 가짜 transport. 스크립트가 바닥나면 `push` 나 `close` 까지 대기한다.
final class FakeWebSocketTransport: WebSocketTransport, @unchecked Sendable {
    enum Step: Sendable {
        case frame(String)
        case fail(any Error)
    }

    private let lock = NSLock()
    private var queue: [Step]
    private var waiter: CheckedContinuation<String, any Error>?
    private var closed = false
    private var connectResult: Result<Void, any Error>
    private var storedRequests: [URLRequest] = []
    private var storedSent: [String] = []
    private var storedCloseCount = 0

    init(steps: [Step] = [], connectResult: Result<Void, any Error> = .success(())) {
        queue = steps
        self.connectResult = connectResult
    }

    var connectRequests: [URLRequest] { lock.withLock { storedRequests } }
    var sent: [String] { lock.withLock { storedSent } }
    var closeCount: Int { lock.withLock { storedCloseCount } }

    func push(_ step: Step) {
        let waiter = lock.withLock {
            let w = self.waiter
            if w != nil { self.waiter = nil } else { queue.append(step) }
            return w
        }
        if let waiter { Self.resume(waiter, with: step) }
    }

    func connect(_ request: URLRequest) async throws {
        let result = lock.withLock {
            storedRequests.append(request)
            return connectResult
        }
        try result.get()
    }

    func receiveText() async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            let action: (() -> Void)? = lock.withLock {
                if !queue.isEmpty {
                    let step = queue.removeFirst()
                    return { Self.resume(continuation, with: step) }
                }
                if closed {
                    return { continuation.resume(throwing: SocketError.closed(code: 1000, reason: nil)) }
                }
                waiter = continuation
                return nil
            }
            action?()
        }
    }

    func send(text: String) async throws {
        lock.withLock { storedSent.append(text) }
    }

    func close() {
        let waiter = lock.withLock {
            closed = true
            storedCloseCount += 1
            let w = self.waiter
            self.waiter = nil
            return w
        }
        waiter?.resume(throwing: SocketError.closed(code: 1000, reason: nil))
    }

    private static func resume(_ continuation: CheckedContinuation<String, any Error>, with step: Step) {
        switch step {
        case .frame(let text): continuation.resume(returning: text)
        case .fail(let error): continuation.resume(throwing: error)
        }
    }
}

/// 준비된 transport 를 순서대로 내주고, 바닥나면 영원히 대기하는 빈 transport 를 만든다. 만든 것은 전부 기록한다.
final class FakeTransportFactory: @unchecked Sendable {
    private let lock = NSLock()
    private var pending: [FakeWebSocketTransport]
    private var created: [FakeWebSocketTransport] = []

    init(_ transports: [FakeWebSocketTransport]) { pending = transports }

    var transports: [FakeWebSocketTransport] { lock.withLock { created } }

    func make() -> any WebSocketTransport {
        lock.withLock {
            let transport = pending.isEmpty ? FakeWebSocketTransport() : pending.removeFirst()
            created.append(transport)
            return transport
        }
    }
}

/// 주입한 `sleep`. 백오프(20초 미만)는 기록만 하고 즉시 돌아온다.
/// ping 간격(20초 이상)은 `pingBudget` 만큼 즉시 돌아오고 그 뒤로는 취소될 때까지 잔다.
final class SleepRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var storedBackoffs: [Duration] = []
    private var storedPingSleeps = 0
    private var pingBudget: Int

    init(pingBudget: Int = 0) { self.pingBudget = pingBudget }

    var backoffs: [Duration] { lock.withLock { storedBackoffs } }
    var pingSleeps: Int { lock.withLock { storedPingSleeps } }

    func sleep(_ duration: Duration) async throws {
        let park: Bool = lock.withLock {
            if duration >= SessionSocket.pingInterval {
                storedPingSleeps += 1
                if pingBudget > 0 {
                    pingBudget -= 1
                    return false
                }
                return true
            }
            storedBackoffs.append(duration)
            return false
        }
        if park { try await Task.sleep(for: .seconds(3600)) }
    }
}
