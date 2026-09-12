import Foundation
import os

// WebSocket 전송 계층. 재접속·ping·이벤트 스트림은 `EventSocket.swift`(`SessionSocket`/`RoomSocket` 별칭) 에 있다.

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

