import Foundation
import XCTest
@testable import MacAgent

/// `RoomSocket.events` 스트림을 소비해 배열에 모은다. 스트림이 끝나면 `finished` 가 true.
@MainActor
final class RoomEventCollector {
    private(set) var events: [RoomEvent] = []
    private(set) var finished = false
    private var task: Task<Void, Never>?

    init(_ socket: RoomSocket) {
        let stream = socket.events
        task = Task { [weak self] in
            for await event in stream { self?.events.append(event) }
            self?.finished = true
        }
    }

    func stop() { task?.cancel() }
}

/// 방 WS(PROTOCOL.md 6.3). 세션 소켓과 같은 백오프·ping·close code 규칙을 `EventSocket` 이 공유하는지 검증한다.
@MainActor
final class RoomSocketTests: XCTestCase {
    private let baseURL = URL(string: "http://127.0.0.1:7777")!
    private let teamId = "team_01J8ZQ4K5N7P9R3S6T8V0W2XT1"
    private let roomId = "room_01J8ZQ4K5N7P9R3S6T8V0W2XR0"
    private let networkError = URLError(.networkConnectionLost)

    private func fixture(_ path: String) throws -> String {
        String(decoding: try FixtureLoader.data(path), as: UTF8.self)
    }

    private func makeSocket(_ factory: FakeTransportFactory, _ sleeper: SleepRecorder, since: Int = 0) -> RoomSocket {
        RoomSocket(
            baseURL: baseURL, teamId: teamId, roomId: roomId, since: since,
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

    // MARK: - 요청 URL

    func testRequestURLTargetsRoomEndpointWithSince() async throws {
        let transport = FakeWebSocketTransport()
        let factory = FakeTransportFactory([transport])
        let socket = makeSocket(factory, SleepRecorder(), since: 12)
        defer { socket.disconnect() }

        socket.connect()
        await waitUntil { socket.state == .open }

        let request = try XCTUnwrap(transport.connectRequests.first)
        XCTAssertEqual(transport.connectRequests.count, 1)
        XCTAssertEqual(
            request.url?.absoluteString,
            "ws://127.0.0.1:7777/api/v1/teams/\(teamId)/rooms/\(roomId)/ws?since=12"
        )
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-MAM-Protocol"), "1")
        XCTAssertNil(request.value(forHTTPHeaderField: "X-MAM-User"))
        XCTAssertEqual(socket.lastSeq, 12)
    }

    // MARK: - 프레임 → 스트림

    func testSnapshotThenMessageUpdatesLastSeqAndPongIsConsumed() async throws {
        let transport = FakeWebSocketTransport(steps: [
            .frame(try fixture("room-ws/room.snapshot.json")),
            .frame(try fixture("room-ws/room.message.agent.json")),
            .frame(try fixture("room-ws/pong.json")),
        ])
        let factory = FakeTransportFactory([transport])
        let sleeper = SleepRecorder()
        let socket = makeSocket(factory, sleeper)
        let collector = RoomEventCollector(socket)
        defer { collector.stop(); socket.disconnect() }

        XCTAssertEqual(socket.state, .idle)
        socket.connect()
        await waitUntil { collector.events.count == 2 }
        XCTAssertEqual(socket.state, .open)
        XCTAssertEqual(collector.events.map(\.type), [.roomSnapshot, .roomMessage])
        XCTAssertEqual(socket.lastSeq, 3, "seq 0 인 스냅샷·pong 은 lastSeq 를 바꾸지 않는다")
        XCTAssertEqual(transport.connectRequests.first?.url?.query(), "since=0")

        // pong 뒤에 push 한 프레임이 바로 다음 이벤트다 → pong 은 스트림에 흐르지 않았다.
        transport.push(.frame(try fixture("room-ws/room.status.json")))
        await waitUntil { collector.events.count == 3 }
        XCTAssertEqual(collector.events.last?.type, .roomStatus)
        XCTAssertFalse(collector.events.contains { $0.type == .pong })
        XCTAssertEqual(socket.lastSeq, 9)
        XCTAssertTrue(sleeper.backoffs.isEmpty)
    }

    func testSessionEventFramesAreIgnoredOnRoomSocket() async throws {
        let transport = FakeWebSocketTransport(steps: [
            .frame(try fixture("ws/session.snapshot.json")),
            .frame(try fixture("ws/item.started.tool_call.json")),
            .frame(try fixture("room-ws/room.message.user.json")),
        ])
        let factory = FakeTransportFactory([transport])
        let socket = makeSocket(factory, SleepRecorder())
        let collector = RoomEventCollector(socket)
        defer { collector.stop(); socket.disconnect() }

        socket.connect()
        await waitUntil { collector.events.count == 1 }
        XCTAssertEqual(collector.events.first?.type, .roomMessage)
        XCTAssertEqual(socket.lastSeq, 2, "디코드 실패 프레임은 lastSeq 를 바꾸지 않는다")
        XCTAssertEqual(socket.state, .open)
        XCTAssertEqual(factory.transports.count, 1)
    }

    // MARK: - 재접속

    func testReconnectsWithSinceAndBackoff() async throws {
        let first = FakeWebSocketTransport(steps: [
            .frame(try fixture("room-ws/room.snapshot.json")),
            .frame(try fixture("room-ws/room.message.agent.json")),
            .fail(networkError),
        ])
        let second = FakeWebSocketTransport(steps: [.fail(networkError)])
        let third = FakeWebSocketTransport(steps: [.fail(networkError)])
        let fourth = FakeWebSocketTransport()
        let factory = FakeTransportFactory([first, second, third, fourth])
        let sleeper = SleepRecorder()
        let socket = makeSocket(factory, sleeper)
        let collector = RoomEventCollector(socket)
        defer { collector.stop(); socket.disconnect() }

        socket.connect()
        await waitUntil { factory.transports.count == 4 && socket.state == .open }

        XCTAssertEqual(sleeper.backoffs.map { $0.components.seconds }, [1, 2, 4])
        for delay in sleeper.backoffs {
            XCTAssertLessThanOrEqual(delay.components.attoseconds, 300_000_000_000_000_000, "지터는 0~300ms")
        }
        XCTAssertEqual(first.connectRequests.first?.url?.query(), "since=0")
        for transport in [second, third, fourth] {
            XCTAssertEqual(transport.connectRequests.first?.url?.query(), "since=3")
        }
        XCTAssertEqual(first.closeCount, 1)
        XCTAssertEqual(collector.events.count, 2)
        XCTAssertEqual(socket.lastSeq, 3)
    }

    func testBackoffPolicyIsSharedWithSessionSocket() {
        let room = (1...8).map { RoomSocket.backoffDelay(attempt: $0, jitterMs: 0) }
        let session = (1...8).map { SessionSocket.backoffDelay(attempt: $0, jitterMs: 0) }
        XCTAssertEqual(room, session)
        XCTAssertEqual(room.map { $0.components.seconds }, [1, 2, 4, 8, 16, 30, 30, 30])
        XCTAssertEqual(SocketPolicy.backoffDelay(attempt: 1, jitterMs: 250), .seconds(1) + .milliseconds(250))
        XCTAssertEqual(RoomSocket.pingInterval, SessionSocket.pingInterval)
        XCTAssertEqual(SocketPolicy.pingInterval, .seconds(20))
        XCTAssertEqual(SocketPolicy.maxBackoffSeconds, 30)
        XCTAssertEqual(SocketPolicy.jitterMilliseconds, 300)
    }

    func testRoomNotFoundCloseCodeStopsReconnecting() async throws {
        let transport = FakeWebSocketTransport(steps: [
            .fail(SocketError.closed(code: 4004, reason: "room not found")),
        ])
        let factory = FakeTransportFactory([transport])
        let sleeper = SleepRecorder()
        let socket = makeSocket(factory, sleeper)
        defer { socket.disconnect() }

        socket.connect()
        await waitUntil { socket.state == .closed(reason: "방이 없습니다") }
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(factory.transports.count, 1)
        XCTAssertTrue(sleeper.backoffs.isEmpty)
        XCTAssertEqual(transport.closeCount, 1)
        XCTAssertEqual(RoomSocket.closeCodeRoomNotFound, 4004)
    }

    func testOtherCloseCodesStillReconnect() async throws {
        let first = FakeWebSocketTransport(steps: [
            .fail(SocketError.closed(code: 1011, reason: "server restart")),
        ])
        let second = FakeWebSocketTransport()
        let factory = FakeTransportFactory([first, second])
        let sleeper = SleepRecorder()
        let socket = makeSocket(factory, sleeper)
        defer { socket.disconnect() }

        socket.connect()
        await waitUntil { factory.transports.count == 2 && socket.state == .open }
        XCTAssertEqual(sleeper.backoffs.map { $0.components.seconds }, [1])
    }

    // MARK: - 전송

    func testSendEncodesRoomClientMessageLikeFixture() async throws {
        let transport = FakeWebSocketTransport()
        let factory = FakeTransportFactory([transport])
        let socket = makeSocket(factory, SleepRecorder())
        defer { socket.disconnect() }

        do {
            try await socket.send(.ping)
            XCTFail("연결 전 send 는 notOpen")
        } catch {
            XCTAssertEqual(error as? SocketError, .notOpen)
        }

        socket.connect()
        await waitUntil { socket.state == .open }
        try await socket.send(.send(text: "@지연 README 에 변경 내용도 적어줘"))
        try await socket.send(.interrupt(memberId: "agt_01J8ZQ4K5N7P9R3S6T8V0W2XA2"))

        XCTAssertEqual(transport.sent.count, 2)
        XCTAssertEqual(try json(transport.sent[0]), try json(fixture("room-client/room.send.json")))
        XCTAssertEqual(try json(transport.sent[1]), try json(fixture("room-client/room.interrupt.json")))
    }

    func testPingIsSentAfterInterval() async throws {
        let transport = FakeWebSocketTransport()
        let factory = FakeTransportFactory([transport])
        let sleeper = SleepRecorder(pingBudget: 1)
        let socket = makeSocket(factory, sleeper)
        defer { socket.disconnect() }

        socket.connect()
        await waitUntil { transport.sent.count == 1 }
        XCTAssertEqual(try json(transport.sent[0]), try json(fixture("room-client/ping.json")))
        XCTAssertEqual(try json(RoomSocket.pingText), try json(fixture("room-client/ping.json")))
        XCTAssertEqual(sleeper.pingSleeps, 2, "ping 을 보낸 뒤 다음 간격을 기다린다")
        XCTAssertTrue(sleeper.backoffs.isEmpty)
    }

    // MARK: - 종료

    func testDisconnectStopsReconnectingAndFinishesStream() async throws {
        let transport = FakeWebSocketTransport(steps: [.frame(try fixture("room-ws/room.snapshot.json"))])
        let factory = FakeTransportFactory([transport])
        let sleeper = SleepRecorder()
        let socket = makeSocket(factory, sleeper)
        let collector = RoomEventCollector(socket)
        defer { collector.stop() }

        socket.connect()
        await waitUntil { socket.state == .open && collector.events.count == 1 }
        XCTAssertFalse(collector.finished)
        socket.disconnect()
        XCTAssertEqual(socket.state, .closed(reason: nil))
        XCTAssertGreaterThanOrEqual(transport.closeCount, 1)

        await waitUntil { collector.finished }
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(factory.transports.count, 1, "disconnect 후 재접속하지 않는다")
        XCTAssertTrue(sleeper.backoffs.isEmpty)
        XCTAssertEqual(collector.events.count, 1)
        do {
            try await socket.send(.ping)
            XCTFail("disconnect 후 send 는 notOpen")
        } catch {
            XCTAssertEqual(error as? SocketError, .notOpen)
        }
    }
}
