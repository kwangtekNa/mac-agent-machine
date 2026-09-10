import Foundation
import XCTest
@testable import MacAgent

/// `events` 스트림을 소비해 배열에 모은다.
@MainActor
final class EventCollector {
    private(set) var events: [ServerEvent] = []
    private var task: Task<Void, Never>?

    init(_ socket: SessionSocket) {
        let stream = socket.events
        task = Task { [weak self] in
            for await event in stream { self?.events.append(event) }
        }
    }

    func stop() { task?.cancel() }
}

@MainActor
final class SessionSocketTests: XCTestCase {
    private let baseURL = URL(string: "http://127.0.0.1:7777")!
    private let sessionId = "ses_01J8ZQ4K5N7P9R3S6T8V0W2XAB"
    private let networkError = URLError(.networkConnectionLost)

    private func fixture(_ path: String) throws -> String {
        String(decoding: try FixtureLoader.data(path), as: UTF8.self)
    }

    private func makeSocket(_ factory: FakeTransportFactory, _ sleeper: SleepRecorder, since: Int = 0) -> SessionSocket {
        SessionSocket(
            baseURL: baseURL, sessionId: sessionId, since: since,
            transportFactory: { factory.make() },
            sleep: { try await sleeper.sleep($0) }
        )
    }

    private func waitUntil(
        _ timeout: Duration = .seconds(3), file: StaticString = #filePath, line: UInt = #line,
        _ condition: @MainActor () -> Bool
    ) async {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            if condition() { return }
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(condition(), "조건이 \(timeout) 안에 충족되지 않음", file: file, line: line)
    }

    private func json(_ text: String) throws -> NSDictionary {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(text.utf8)) as? NSDictionary)
    }

    // MARK: - 프레임 → 스트림

    func testFramesFlowToStreamAndPongIsConsumed() async throws {
        let transport = FakeWebSocketTransport(steps: [
            .frame(try fixture("ws/session.snapshot.json")),
            .frame(try fixture("ws/item.started.tool_call.json")),
            .frame(try fixture("ws/pong.json")),
        ])
        let factory = FakeTransportFactory([transport])
        let sleeper = SleepRecorder()
        let socket = makeSocket(factory, sleeper)
        let collector = EventCollector(socket)
        defer { collector.stop(); socket.disconnect() }

        XCTAssertEqual(socket.state, .idle)
        socket.connect()
        await waitUntil { collector.events.count == 2 }
        XCTAssertEqual(socket.state, .open)
        XCTAssertEqual(collector.events.map(\.type), [.sessionSnapshot, .itemStarted])
        XCTAssertEqual(socket.lastSeq, 37, "seq 0 인 스냅샷·pong 은 lastSeq 를 바꾸지 않는다")

        // pong 뒤에 push 한 프레임이 바로 다음 이벤트다 → pong 은 스트림에 흐르지 않았다.
        transport.push(.frame(try fixture("ws/item.completed.tool_call.json")))
        await waitUntil { collector.events.count == 3 }
        XCTAssertEqual(collector.events.last?.type, .itemCompleted)
        XCTAssertFalse(collector.events.contains { $0.type == .pong })

        let request = try XCTUnwrap(transport.connectRequests.first)
        XCTAssertEqual(transport.connectRequests.count, 1)
        XCTAssertEqual(request.url?.absoluteString, "ws://127.0.0.1:7777/api/v1/sessions/\(sessionId)/ws?since=0")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-MAM-Protocol"), "1")
        XCTAssertNil(request.value(forHTTPHeaderField: "X-MAM-User"))
        XCTAssertTrue(sleeper.backoffs.isEmpty)
    }

    func testUndecodableFramesAreIgnored() async throws {
        let transport = FakeWebSocketTransport(steps: [
            .frame("not json"),
            .frame(#"{"type":"nope","seq":1}"#),
            .frame(try fixture("ws/item.started.tool_call.json")),
        ])
        let factory = FakeTransportFactory([transport])
        let socket = makeSocket(factory, SleepRecorder())
        let collector = EventCollector(socket)
        defer { collector.stop(); socket.disconnect() }

        socket.connect()
        await waitUntil { collector.events.count == 1 }
        XCTAssertEqual(collector.events.first?.type, .itemStarted)
        XCTAssertEqual(socket.state, .open)
        XCTAssertEqual(factory.transports.count, 1)
    }

    // MARK: - 재접속

    func testReconnectsWithSinceAndBackoff() async throws {
        let first = FakeWebSocketTransport(steps: [
            .frame(try fixture("ws/session.snapshot.json")),
            .frame(try fixture("ws/item.started.tool_call.json")),
            .fail(networkError),
        ])
        let second = FakeWebSocketTransport(steps: [.fail(networkError)])
        let third = FakeWebSocketTransport(steps: [.fail(networkError)])
        let fourth = FakeWebSocketTransport()
        let factory = FakeTransportFactory([first, second, third, fourth])
        let sleeper = SleepRecorder()
        let socket = makeSocket(factory, sleeper)
        let collector = EventCollector(socket)
        defer { collector.stop(); socket.disconnect() }

        socket.connect()
        await waitUntil { factory.transports.count == 4 && socket.state == .open }

        XCTAssertEqual(sleeper.backoffs.map { $0.components.seconds }, [1, 2, 4])
        for delay in sleeper.backoffs {
            XCTAssertLessThanOrEqual(delay.components.attoseconds, 300_000_000_000_000_000, "지터는 0~300ms")
        }
        XCTAssertEqual(first.connectRequests.first?.url?.query(), "since=0")
        for transport in [second, third, fourth] {
            XCTAssertEqual(transport.connectRequests.first?.url?.query(), "since=37")
        }
        XCTAssertEqual(first.closeCount, 1)
        XCTAssertEqual(collector.events.count, 2)
        XCTAssertEqual(socket.lastSeq, 37)
    }

    func testBackoffDelayTable() {
        let seconds = (1...8).map { SessionSocket.backoffDelay(attempt: $0, jitterMs: 0).components.seconds }
        XCTAssertEqual(seconds, [1, 2, 4, 8, 16, 30, 30, 30])
        XCTAssertEqual(SessionSocket.backoffDelay(attempt: 1, jitterMs: 250), .seconds(1) + .milliseconds(250))
    }

    func testDisconnectStopsReconnecting() async throws {
        let transport = FakeWebSocketTransport(steps: [.frame(try fixture("ws/session.snapshot.json"))])
        let factory = FakeTransportFactory([transport])
        let sleeper = SleepRecorder()
        let socket = makeSocket(factory, sleeper)
        let collector = EventCollector(socket)
        defer { collector.stop() }

        do {
            try await socket.send(.ping)
            XCTFail("연결 전 send 는 notOpen")
        } catch {
            XCTAssertEqual(error as? SocketError, .notOpen)
        }

        socket.connect()
        await waitUntil { socket.state == .open && collector.events.count == 1 }
        socket.disconnect()
        XCTAssertEqual(socket.state, .closed(reason: nil))
        XCTAssertGreaterThanOrEqual(transport.closeCount, 1)

        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(factory.transports.count, 1, "disconnect 후 재접속하지 않는다")
        XCTAssertTrue(sleeper.backoffs.isEmpty)
        XCTAssertEqual(socket.state, .closed(reason: nil))
        do {
            try await socket.send(.ping)
            XCTFail("disconnect 후 send 는 notOpen")
        } catch {
            XCTAssertEqual(error as? SocketError, .notOpen)
        }
    }

    func testSessionNotFoundCloseCodeStopsReconnecting() async throws {
        let transport = FakeWebSocketTransport(steps: [
            .fail(SocketError.closed(code: 4004, reason: "session not found")),
        ])
        let factory = FakeTransportFactory([transport])
        let sleeper = SleepRecorder()
        let socket = makeSocket(factory, sleeper)
        defer { socket.disconnect() }

        socket.connect()
        await waitUntil { socket.state == .closed(reason: "세션이 없습니다") }
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(factory.transports.count, 1)
        XCTAssertTrue(sleeper.backoffs.isEmpty)
        XCTAssertEqual(transport.closeCount, 1)
    }

    // MARK: - 전송

    func testSendEncodesClientMessageLikeFixture() async throws {
        let transport = FakeWebSocketTransport()
        let factory = FakeTransportFactory([transport])
        let socket = makeSocket(factory, SleepRecorder())
        defer { socket.disconnect() }

        socket.connect()
        await waitUntil { socket.state == .open }
        try await socket.send(.approvalRespond(
            approvalId: "apr_01J8ZQ4K5N7P9R3S6T8V0W2XE1", optionId: "deny",
            message: "테스트는 CI에서 돌립니다. 로컬에서 실행하지 마세요."
        ))
        try await socket.send(.sessionSetMode(mode: .autoEdit))

        XCTAssertEqual(transport.sent.count, 2)
        XCTAssertEqual(try json(transport.sent[0]), try json(fixture("client/approval.respond.json")))
        XCTAssertEqual(try json(transport.sent[1]), try json(fixture("client/session.setMode.json")))
    }

    func testPingIsSentAfterInterval() async throws {
        let transport = FakeWebSocketTransport()
        let factory = FakeTransportFactory([transport])
        let sleeper = SleepRecorder(pingBudget: 1)
        let socket = makeSocket(factory, sleeper)
        defer { socket.disconnect() }

        socket.connect()
        await waitUntil { transport.sent.count == 1 }
        XCTAssertEqual(try json(transport.sent[0]), try json(fixture("client/ping.json")))
        XCTAssertEqual(sleeper.pingSleeps, 2, "ping 을 보낸 뒤 다음 간격을 기다린다")
        XCTAssertTrue(sleeper.backoffs.isEmpty)
    }
}
