import Foundation
import XCTest
@testable import MacAgent

/// 호출 횟수만 세는 햅틱.
@MainActor
final class CountingHaptics: HapticsProviding {
    private(set) var warnings = 0
    func warning() { warnings += 1 }
}

/// `TimelineModel.respond` 와 승인 이벤트 처리(step 6). 확정은 서버의 `approval.resolved` 에만 의존한다.
@MainActor
final class TimelineModelApprovalTests: XCTestCase {
    private let baseURL = URL(string: "http://127.0.0.1:7777")!
    private let sessionId = "ses_01J8ZQ4K5N7P9R3S6T8V0W2XAB"
    private let approvalId = "apr_01J8ZQ4K5N7P9R3S6T8V0W2XE1"
    private var factory: FakeTransportFactory!
    private var haptics: CountingHaptics!
    private let requests = Locked<[URLRequest]>([])

    override func setUp() {
        super.setUp()
        factory = FakeTransportFactory([])
        haptics = CountingHaptics()
        requests.value = []
    }

    override func tearDown() {
        StubURLProtocol.handler = nil
        super.tearDown()
    }

    // MARK: - helpers

    private func makeModel(failureDuration: Duration = .milliseconds(30)) -> TimelineModel {
        let factory = self.factory!
        let client = APIClient(baseURL: baseURL, session: StubURLProtocol.makeSession())
        return TimelineModel(
            sessionId: sessionId, client: client,
            approvalFailureDuration: failureDuration,
            haptics: haptics,
            socketFactory: { id, since in
                SessionSocket(baseURL: client.baseURL, sessionId: id, since: since, transportFactory: { factory.make() })
            }
        )
    }

    private func event(_ name: String, seq: Int? = nil) throws -> ServerEvent {
        var data = try FixtureLoader.data("ws/\(name).json")
        if let seq {
            var json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            json["seq"] = seq
            data = try JSONSerialization.data(withJSONObject: json)
        }
        return try JSONCoding.decoder.decode(ServerEvent.self, from: data)
    }

    private func frame(_ name: String, seq: Int) throws -> String {
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: FixtureLoader.data("ws/\(name).json")) as? [String: Any])
        json["seq"] = seq
        return String(decoding: try JSONSerialization.data(withJSONObject: json), as: UTF8.self)
    }

    private func pendingApproval(_ model: TimelineModel) throws -> Approval {
        try XCTUnwrap(model.pendingApprovals.first { $0.approvalId == approvalId })
    }

    /// 요청을 기록하고 경로별로 응답한다. 등록되지 않은 경로는 전송 오류.
    private func install(_ routes: [(method: String, path: String, status: Int, body: Data)]) {
        let requests = self.requests
        StubURLProtocol.handler = { request in
            var copy = request
            copy.httpBody = StubURLProtocol.body(of: request)
            requests.withValue { $0.append(copy) }
            let path = request.url?.path() ?? ""
            guard let route = routes.first(where: { $0.method == request.httpMethod && $0.path == path }) else {
                throw URLError(.unsupportedURL)
            }
            return StubURLProtocol.response(request, status: route.status, body: route.body)
        }
    }

    private func waitUntil(_ condition: @MainActor () -> Bool, timeout: Duration = .seconds(3)) async throws {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline, !condition() { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(condition(), "시간 안에 조건을 만족하지 못했다")
    }

    private func openSocket(_ model: TimelineModel) async throws -> FakeWebSocketTransport {
        model.resume()
        try await waitUntil { model.socketState == .open }
        return try XCTUnwrap(factory.transports.last)
    }

    private var errorBody: Data {
        Data(#"{"error":{"code":"conflict","message":"이미 처리된 승인입니다"}}"#.utf8)
    }

    // MARK: - respond

    func testRespondOverOpenSocketSendsApprovalRespondAndWaitsForResolved() async throws {
        let model = makeModel()
        defer { model.stop() }
        model.apply(try event("item.started.approval"))
        model.apply(try event("approval.requested.command", seq: 39))
        let transport = try await openSocket(model)

        await model.respond(to: try pendingApproval(model), optionId: "deny", inputs: ["a": "b"], message: "CI에서 돌립니다")

        XCTAssertEqual(model.approvalSubmit, .submitting(approvalId: approvalId))
        XCTAssertEqual(model.pendingApprovals.count, 1, "낙관적으로 pending 에서 빼지 않는다")
        let sentJSON = try XCTUnwrap(transport.sent.last)
        let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(sentJSON.utf8)) as? [String: Any])
        XCTAssertEqual(sent["type"] as? String, "approval.respond")
        XCTAssertEqual(sent["approvalId"] as? String, approvalId)
        XCTAssertEqual(sent["optionId"] as? String, "deny")
        XCTAssertEqual(sent["inputs"] as? [String: String], ["a": "b"])
        XCTAssertEqual(sent["message"] as? String, "CI에서 돌립니다")
        XCTAssertTrue(requests.value.isEmpty, "소켓이 열려 있으면 REST 를 쓰지 않는다")

        transport.push(.frame(try frame("approval.resolved", seq: 40)))
        try await waitUntil { model.pendingApprovals.isEmpty }
        XCTAssertEqual(model.approvalSubmit, .idle)
        guard case .approval(let payload) = model.items[0].payload else { return XCTFail("approval item") }
        XCTAssertEqual(payload.resolution?.optionId, "allow_session", "resolution 은 서버 이벤트의 값")
    }

    func testRespondWithoutOpenSocketUsesRest() async throws {
        let model = makeModel()
        model.apply(try event("approval.requested.command", seq: 39))
        install([("POST", "/api/v1/sessions/\(sessionId)/approvals/\(approvalId)", 200, Data(#"{"ok":true}"#.utf8))])

        await model.respond(to: try pendingApproval(model), optionId: "allow")

        XCTAssertEqual(model.approvalSubmit, .submitting(approvalId: approvalId))
        XCTAssertEqual(model.pendingApprovals.count, 1)
        let request = try XCTUnwrap(requests.value.first)
        XCTAssertEqual(request.httpMethod, "POST")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(request.httpBody)) as? [String: Any])
        XCTAssertEqual(body["optionId"] as? String, "allow")
        XCTAssertNil(body["inputs"])
        XCTAssertNil(body["message"])

        model.apply(try event("approval.resolved", seq: 40))
        XCTAssertTrue(model.pendingApprovals.isEmpty)
        XCTAssertEqual(model.approvalSubmit, .idle)
    }

    func testConflictMarksFailedThenRemovesPendingAndRefreshesDetail() async throws {
        let model = makeModel(failureDuration: .milliseconds(30))
        model.apply(try event("approval.requested.command", seq: 39))
        install([
            ("POST", "/api/v1/sessions/\(sessionId)/approvals/\(approvalId)", 409, errorBody),
            ("GET", "/api/v1/sessions/\(sessionId)", 200, try FixtureLoader.data("rest/session-detail.json")),
        ])

        await model.respond(to: try pendingApproval(model), optionId: "allow")

        XCTAssertEqual(model.approvalSubmit, .failed(approvalId: approvalId, message: "이미 처리된 요청입니다"))
        XCTAssertEqual(model.pendingApprovals.count, 1, "문구를 보여주는 동안은 아직 pending")

        try await waitUntil { model.approvalSubmit == .idle }
        XCTAssertTrue(model.pendingApprovals.isEmpty)
        XCTAssertTrue(requests.value.contains { $0.httpMethod == "GET" && $0.url?.path() == "/api/v1/sessions/\(sessionId)" },
                      "refreshDetail 로 GET /sessions/:id 를 다시 읽는다")
        XCTAssertEqual(model.session?.id, sessionId)
    }

    func testSocketErrorWhileSubmittingIsTreatedAsAlreadyResolved() async throws {
        let model = makeModel(failureDuration: .milliseconds(30))
        defer { model.stop() }
        model.apply(try event("approval.requested.command", seq: 39))
        install([("GET", "/api/v1/sessions/\(sessionId)", 200, try FixtureLoader.data("rest/session-detail.json"))])
        let transport = try await openSocket(model)

        await model.respond(to: try pendingApproval(model), optionId: "allow")
        XCTAssertEqual(model.approvalSubmit, .submitting(approvalId: approvalId))

        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: FixtureLoader.data("ws/error.json")) as? [String: Any])
        json["seq"] = 0
        json["message"] = "approval already resolved"
        transport.push(.frame(String(decoding: try JSONSerialization.data(withJSONObject: json), as: UTF8.self)))

        try await waitUntil { model.approvalSubmit == .failed(approvalId: self.approvalId, message: "이미 처리된 요청입니다") }
        XCTAssertNil(model.transientError, "승인 실패는 배너 문구로만 보인다")
        try await waitUntil { model.approvalSubmit == .idle }
        XCTAssertTrue(model.pendingApprovals.isEmpty)
        XCTAssertTrue(requests.value.contains { $0.httpMethod == "GET" })
    }

    func testTransportFailureKeepsPendingAndClearsFailure() async throws {
        let model = makeModel(failureDuration: .milliseconds(30))
        model.apply(try event("approval.requested.command", seq: 39))
        install([])  // 모든 요청이 전송 오류

        await model.respond(to: try pendingApproval(model), optionId: "allow")

        guard case .failed(let id, let message) = model.approvalSubmit else { return XCTFail("failed 여야 한다") }
        XCTAssertEqual(id, approvalId)
        XCTAssertNotEqual(message, "이미 처리된 요청입니다")
        try await waitUntil { model.approvalSubmit == .idle }
        XCTAssertEqual(model.pendingApprovals.count, 1, "보내지 못한 승인은 그대로 남아 다시 시도할 수 있다")
        XCTAssertFalse(requests.value.contains { $0.httpMethod == "GET" }, "전송 실패는 서버 상태 재조회 사유가 아니다")
    }

    func testRespondIgnoresUnknownApprovalAndSecondConcurrentSubmit() async throws {
        let model = makeModel()
        model.apply(try event("approval.requested.command", seq: 39))
        model.apply(try event("approval.requested.file_change", seq: 40))
        install([("POST", "/api/v1/sessions/\(sessionId)/approvals/\(approvalId)", 200, Data(#"{"ok":true}"#.utf8))])

        let stranger = Approval(
            approvalId: "apr_unknown", itemId: "itm_x", kind: .command, title: "t", prompt: "p", detail: nil, diff: nil,
            options: [], inputFields: [], requestedAt: .now
        )
        await model.respond(to: stranger, optionId: "allow")
        XCTAssertEqual(model.approvalSubmit, .idle)
        XCTAssertTrue(requests.value.isEmpty)

        await model.respond(to: try pendingApproval(model), optionId: "allow")
        XCTAssertEqual(model.approvalSubmit, .submitting(approvalId: approvalId))
        await model.respond(to: model.pendingApprovals[1], optionId: "allow")
        XCTAssertEqual(model.approvalSubmit, .submitting(approvalId: approvalId), "전송 중에는 다른 승인을 보내지 않는다")
        XCTAssertEqual(requests.value.count, 1)
    }

    // MARK: - resolved by others / haptics

    func testResolvedByOtherClientRemovesPendingWithoutSubmit() throws {
        let model = makeModel()
        model.apply(try event("item.started.approval"))
        model.apply(try event("approval.requested.command", seq: 39))
        XCTAssertEqual(model.pendingApprovals.count, 1)

        model.apply(try event("approval.resolved", seq: 40))

        XCTAssertTrue(model.pendingApprovals.isEmpty, "누가 처리했든 배너는 즉시 사라진다")
        XCTAssertEqual(model.approvalSubmit, .idle)
        guard case .approval(let payload) = model.items[0].payload else { return XCTFail("approval item") }
        XCTAssertEqual(payload.resolution?.by, .client)
    }

    func testHapticsOnlyForLiveApprovalRequests() throws {
        let model = makeModel()
        model.apply(try event("session.snapshot"))   // pendingApprovals 1건 포함, lastSeq 38
        XCTAssertEqual(model.pendingApprovals.count, 1)
        XCTAssertEqual(haptics.warnings, 0, "스냅샷의 대기 승인은 재생이다")
        XCTAssertTrue(model.isReplaying)

        model.apply(try event("approval.requested.command", seq: 38))   // 재생 중복
        XCTAssertEqual(haptics.warnings, 0)
        XCTAssertTrue(model.isReplaying)

        model.apply(try event("approval.requested.file_change", seq: 39)) // 첫 라이브 이벤트
        XCTAssertEqual(haptics.warnings, 1)
        XCTAssertFalse(model.isReplaying)

        model.apply(try event("approval.requested.permission", seq: 44))
        XCTAssertEqual(haptics.warnings, 2)

        // 재접속 스냅샷 뒤에도 같은 규칙.
        model.apply(try event("session.snapshot"))
        XCTAssertTrue(model.isReplaying)
        XCTAssertEqual(haptics.warnings, 2)
    }

    func testSnapshotWithoutSubmittedApprovalResetsSubmitState() async throws {
        let model = makeModel()
        model.apply(try event("approval.requested.file_change", seq: 39))
        let fileChangeId = "apr_01J8ZQ4K5N7P9R3S6T8V0W2XE2"
        install([("POST", "/api/v1/sessions/\(sessionId)/approvals/\(fileChangeId)", 200, Data(#"{"ok":true}"#.utf8))])
        await model.respond(to: try XCTUnwrap(model.pendingApprovals.first), optionId: "allow")
        XCTAssertEqual(model.approvalSubmit, .submitting(approvalId: fileChangeId))

        // 재접속 스냅샷의 pendingApprovals 에 그 승인이 없으면(다른 경로로 처리됨) 전송 상태도 정리된다.
        model.apply(try event("session.snapshot"))
        XCTAssertEqual(model.pendingApprovals.map(\.approvalId), [approvalId])
        XCTAssertEqual(model.approvalSubmit, .idle)
    }
}
