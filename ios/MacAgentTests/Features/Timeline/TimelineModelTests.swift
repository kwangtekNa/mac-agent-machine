import Foundation
import XCTest
@testable import MacAgent

/// `TimelineModel.apply` 시나리오(IOS.md 6절 규칙). fixture 이벤트를 그대로 쓰되 seq 가 겹치는 fixture 는 seq 를 바꿔 넣는다.
@MainActor
final class TimelineModelTests: XCTestCase {
    private let baseURL = URL(string: "http://127.0.0.1:7777")!
    private let sessionId = "ses_01J8ZQ4K5N7P9R3S6T8V0W2XAB"
    private var factory: FakeTransportFactory!

    override func setUp() {
        super.setUp()
        factory = FakeTransportFactory([])
    }

    override func tearDown() {
        StubURLProtocol.handler = nil
        super.tearDown()
    }

    // MARK: - helpers

    private func makeModel(transientDuration: Duration = .milliseconds(30)) -> TimelineModel {
        let factory = self.factory!
        let client = APIClient(baseURL: baseURL, session: StubURLProtocol.makeSession())
        return TimelineModel(
            sessionId: sessionId, client: client, transientErrorDuration: transientDuration,
            socketFactory: { id, since in
                SessionSocket(baseURL: client.baseURL, sessionId: id, since: since, transportFactory: { factory.make() })
            }
        )
    }

    /// fixture 를 디코드한다. `seq` 를 주면 최상위 seq 를 바꿔 넣는다(fixture 끼리 seq 가 겹치므로).
    private func event(_ name: String, seq: Int? = nil) throws -> ServerEvent {
        var data = try FixtureLoader.data("ws/\(name).json")
        if let seq {
            var json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            json["seq"] = seq
            data = try JSONSerialization.data(withJSONObject: json)
        }
        return try JSONCoding.decoder.decode(ServerEvent.self, from: data)
    }

    private func text(of item: TimelineItem?) -> String? {
        switch item?.payload {
        case .assistantMessage(let p): return p.text
        case .reasoning(let p): return p.text
        default: return nil
        }
    }

    // MARK: - snapshot

    func testSnapshotReplacesItemsPendingAndStatus() throws {
        let model = makeModel()
        model.apply(try event("session.snapshot"))

        XCTAssertEqual(model.items.map(\.seq), [37, 38])
        XCTAssertEqual(model.pendingApprovals.map(\.approvalId), ["apr_01J8ZQ4K5N7P9R3S6T8V0W2XE1"])
        XCTAssertEqual(model.status, .waitingApproval)
        XCTAssertEqual(model.mode, .ask)
        XCTAssertEqual(model.session?.id, sessionId)
        XCTAssertFalse(model.hasOlderHistory)
        XCTAssertEqual(model.lastSeq, 38, "스냅샷 뒤의 lastSeq 는 세션의 lastSeq 다")
        XCTAssertNil(model.fatalError)
    }

    func testSnapshotMergesWithRestItemsReplacingSameIdAndKeepingOthers() throws {
        let model = makeModel()
        // REST 초기 items: system(33), user_message(34), tool_call running(37)
        model.apply(try event("item.started.system"))
        model.apply(try event("item.started.user_message"))
        model.apply(try event("item.started.tool_call"))
        XCTAssertEqual(model.items.map(\.seq), [33, 34, 37])

        model.apply(try event("session.snapshot"))

        XCTAssertEqual(model.items.map(\.seq), [33, 34, 37, 38], "replayFrom 이전 아이템은 유지, 같은 id 는 교체, 새 아이템 추가")
        XCTAssertEqual(model.items.map(\.id).count, Set(model.items.map(\.id)).count, "id 중복 없음")
    }

    func testSnapshotTruncatedSetsHasOlderHistory() throws {
        let model = makeModel()
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: FixtureLoader.data("ws/session.snapshot.json")) as? [String: Any])
        json["truncated"] = true
        let event = try JSONCoding.decoder.decode(ServerEvent.self, from: JSONSerialization.data(withJSONObject: json))
        model.apply(event)
        XCTAssertTrue(model.hasOlderHistory)
    }

    // MARK: - items

    func testItemStartedAppendsAndSameIdReplaces() throws {
        let model = makeModel()
        model.apply(try event("item.started.reasoning"))
        model.apply(try event("item.started.assistant_message"))
        XCTAssertEqual(model.items.map(\.kind), [.reasoning, .assistantMessage])

        // 같은 id 의 item.started 가 다시 오면(재전송) 교체된다. seq 는 새것으로.
        model.apply(try event("item.completed.tool_call", seq: 50))
        model.apply(try event("item.started.tool_call", seq: 51))
        XCTAssertEqual(model.items.count, 3)
        XCTAssertEqual(model.items.last?.status, .running, "같은 id 는 뒤에 온 것으로 교체된다")
        XCTAssertEqual(model.items.last?.seq, 37, "아이템 seq 는 payload 의 것")
    }

    func testDeltaAppendsToTextAndIgnoresUnknownTarget() throws {
        let model = makeModel()
        model.apply(try event("item.started.assistant_message"))
        model.apply(try event("item.delta", seq: 40))
        model.apply(try event("item.delta", seq: 41))
        XCTAssertEqual(text(of: model.items.first), "`src/login.ts`에 만료 검사를 `src/login.ts`에 만료 검사를 ")

        // 대상 아이템이 없는 델타는 무시된다.
        let before = model.items
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: FixtureLoader.data("ws/item.delta.json")) as? [String: Any])
        json["seq"] = 42
        json["itemId"] = "itm_missing"
        model.apply(try JSONCoding.decoder.decode(ServerEvent.self, from: JSONSerialization.data(withJSONObject: json)))
        XCTAssertEqual(model.items, before)
        XCTAssertEqual(model.lastSeq, 42)
    }

    func testDeltaAppendsToToolOutputAndPatch() throws {
        let model = makeModel()
        model.apply(try event("item.started.tool_call"))
        model.apply(try event("item.started.file_change"))
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: FixtureLoader.data("ws/item.delta.json")) as? [String: Any])
        json["seq"] = 40
        json["itemId"] = "itm_01J8ZQ4K5N7P9R3S6T8V0W2XD4"
        json["field"] = "output"
        json["delta"] = "hi\n"
        model.apply(try JSONCoding.decoder.decode(ServerEvent.self, from: JSONSerialization.data(withJSONObject: json)))
        json["seq"] = 41
        json["itemId"] = "itm_01J8ZQ4K5N7P9R3S6T8V0W2XD6"
        json["field"] = "patch"
        json["delta"] = "+// end\n"
        model.apply(try JSONCoding.decoder.decode(ServerEvent.self, from: JSONSerialization.data(withJSONObject: json)))

        guard case .toolCall(let tool) = model.items[0].payload else { return XCTFail("tool_call") }
        XCTAssertEqual(tool.output, "hi\n")
        guard case .fileChange(let change) = model.items[1].payload else { return XCTFail("file_change") }
        XCTAssertTrue(change.patch.hasSuffix("+// end\n"))
    }

    func testItemCompletedReplacesStreamedItem() throws {
        let model = makeModel()
        model.apply(try event("item.started.tool_call"))
        model.apply(try event("item.completed.tool_call", seq: 40))
        XCTAssertEqual(model.items.count, 1)
        XCTAssertEqual(model.items[0].status, .completed)
        guard case .toolCall(let tool) = model.items[0].payload else { return XCTFail("tool_call") }
        XCTAssertEqual(tool.exitCode, 0)
        XCTAssertTrue(tool.output.contains("3 passed"))
    }

    func testDuplicateSeqIsIgnored() throws {
        let model = makeModel()
        model.apply(try event("item.started.assistant_message"))          // seq 36
        model.apply(try event("item.delta"))                              // seq 36 → 중복, 무시
        XCTAssertEqual(text(of: model.items.first), "")
        model.apply(try event("item.started.reasoning"))                  // seq 35 → 과거, 무시
        XCTAssertEqual(model.items.count, 1)
        model.apply(try event("pong"))                                    // seq 0 → 예외, 무시되지만 오류 없음
        XCTAssertEqual(model.lastSeq, 36)
    }

    func testTurnCompletedCreatesNoItem() throws {
        let model = makeModel()
        model.apply(try event("item.started.turn_summary"))
        model.apply(try event("turn.completed", seq: 43))
        XCTAssertEqual(model.items.map(\.kind), [.turnSummary])
        XCTAssertEqual(model.lastSeq, 43)
    }

    // MARK: - approvals

    func testApprovalRequestedAddsPendingAndSetsWaiting() throws {
        let model = makeModel()
        model.apply(try event("item.started.approval"))
        model.apply(try event("approval.requested.command", seq: 39))
        model.apply(try event("approval.requested.file_change", seq: 40))
        XCTAssertEqual(model.pendingApprovals.map(\.approvalId), [
            "apr_01J8ZQ4K5N7P9R3S6T8V0W2XE1", "apr_01J8ZQ4K5N7P9R3S6T8V0W2XE2",
        ], "requestedAt 오름차순")
        XCTAssertEqual(model.status, .waitingApproval)
    }

    func testApprovalResolvedRemovesPendingAndMarksItem() throws {
        let model = makeModel()
        model.apply(try event("item.started.approval"))
        model.apply(try event("approval.requested.command", seq: 39))
        model.apply(try event("approval.resolved", seq: 40))

        XCTAssertTrue(model.pendingApprovals.isEmpty)
        guard case .approval(let payload) = model.items[0].payload else { return XCTFail("approval") }
        XCTAssertEqual(payload.resolution?.optionId, "allow_session")
        XCTAssertEqual(payload.resolution?.by, .client)
        XCTAssertEqual(model.items[0].status, .completed)

        // 뒤따르는 같은 id 의 item.completed 는 그대로 교체된다.
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: FixtureLoader.data("ws/item.started.approval.json")) as? [String: Any])
        json["type"] = "item.completed"
        json["seq"] = 41
        var item = try XCTUnwrap(json["item"] as? [String: Any])
        item["status"] = "completed"
        var payloadJSON = try XCTUnwrap(item["payload"] as? [String: Any])
        payloadJSON["resolution"] = ["optionId": "allow_session", "by": "client", "at": "2026-09-09T10:10:15Z"]
        item["payload"] = payloadJSON
        json["item"] = item
        model.apply(try JSONCoding.decoder.decode(ServerEvent.self, from: JSONSerialization.data(withJSONObject: json)))
        XCTAssertEqual(model.items.count, 1)
        guard case .approval(let completed) = model.items[0].payload else { return XCTFail("approval") }
        XCTAssertEqual(completed.resolution?.optionId, "allow_session")
    }

    // MARK: - status / error

    func testSessionStatusUpdatesStatusModeAndFatalError() throws {
        let model = makeModel()
        model.apply(try event("session.snapshot"))
        model.apply(try event("session.status", seq: 46))
        XCTAssertEqual(model.status, .error)
        XCTAssertEqual(model.fatalError, "에이전트 프로세스가 예기치 않게 종료되었습니다 (exit 1)")
        XCTAssertEqual(model.session?.status, .error)

        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: FixtureLoader.data("ws/session.status.json")) as? [String: Any])
        json["seq"] = 47
        json["status"] = "idle"
        json["mode"] = "auto-edit"
        json.removeValue(forKey: "reason")
        model.apply(try JSONCoding.decoder.decode(ServerEvent.self, from: JSONSerialization.data(withJSONObject: json)))
        XCTAssertEqual(model.status, .idle)
        XCTAssertEqual(model.mode, .autoEdit)
        XCTAssertNil(model.fatalError, "오류가 아닌 상태로 돌아오면 배너를 내린다")
    }

    func testRecoverableErrorIsTransientAndFatalErrorStays() async throws {
        let model = makeModel(transientDuration: .milliseconds(30))
        model.apply(try event("error", seq: 47))
        XCTAssertEqual(model.transientError, "turn already running")
        XCTAssertNil(model.fatalError)
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertNil(model.transientError, "recoverable 오류는 잠시 뒤 사라진다")

        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: FixtureLoader.data("ws/error.json")) as? [String: Any])
        json["seq"] = 48
        json["recoverable"] = false
        json["message"] = "프로세스가 종료되었습니다"
        model.apply(try JSONCoding.decoder.decode(ServerEvent.self, from: JSONSerialization.data(withJSONObject: json)))
        XCTAssertEqual(model.fatalError, "프로세스가 종료되었습니다")
        XCTAssertNil(model.transientError)
    }

    func testBusyMessageIsTranslated() throws {
        let model = makeModel(transientDuration: .seconds(10))
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: FixtureLoader.data("ws/error.json")) as? [String: Any])
        json["seq"] = 0
        json["message"] = "session is busy"
        model.apply(try JSONCoding.decoder.decode(ServerEvent.self, from: JSONSerialization.data(withJSONObject: json)))
        XCTAssertEqual(model.transientError, "에이전트가 응답 중입니다. 잠시 후 다시 보내세요.")
    }

    // MARK: - start (REST) + socket

    func testStartLoadsRestItemsThenConnectsWithSince() async throws {
        let detail = try FixtureLoader.data("rest/session-detail.json")
        StubURLProtocol.handler = { request in
            StubURLProtocol.response(request, status: 200, body: detail)
        }
        let transport = FakeWebSocketTransport(steps: [.frame(String(decoding: try FixtureLoader.data("ws/session.snapshot.json"), as: UTF8.self))])
        factory = FakeTransportFactory([transport])
        let model = makeModel()
        defer { model.stop() }

        await model.start()

        let expected = try JSONCoding.decoder.decode(SessionDetailResponse.self, from: detail)
        XCTAssertEqual(model.session?.id, expected.session.id)
        XCTAssertGreaterThanOrEqual(model.items.count, expected.items.count)
        let deadline = ContinuousClock.now + .seconds(3)
        while ContinuousClock.now < deadline, model.socketState != .open { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(model.socketState, .open)
        let expectedSince = max(expected.session.lastSeq, expected.items.map(\.seq).max() ?? 0)
        XCTAssertEqual(transport.connectRequests.first?.url?.query(), "since=\(expectedSince)")
        while ContinuousClock.now < deadline, model.status != .waitingApproval { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(model.status, .waitingApproval, "스냅샷이 apply 로 흘러들어온다")
        XCTAssertEqual(model.items.map(\.id).count, Set(model.items.map(\.id)).count)
    }

    func testSendIsBlockedWhileRunning() async throws {
        let model = makeModel(transientDuration: .seconds(10))
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: FixtureLoader.data("ws/session.status.json")) as? [String: Any])
        json["status"] = "running"
        json.removeValue(forKey: "reason")
        model.apply(try JSONCoding.decoder.decode(ServerEvent.self, from: JSONSerialization.data(withJSONObject: json)))
        await model.send(text: "hello")
        XCTAssertNotNil(model.transientError)
    }
}
