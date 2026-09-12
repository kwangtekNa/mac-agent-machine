import Foundation
import XCTest
@testable import MacAgent

/// `ApprovalResponding`(step 3): 배너·시트가 `TimelineModel` 과 `RoomModel` 을 같은 인터페이스로 쓴다.
/// `RoomModel` 은 `[RoomApproval]` 을 `[Approval]`(requestedAt 순)로 펼치고, 응답은 카드의 세션 API 로 보내며, 작성자 캡션을 준다.
/// `TimelineModel` 은 캡션이 없다.
@MainActor
final class ApprovalRespondingTests: XCTestCase {
    private let baseURL = URL(string: "http://127.0.0.1:7777")!
    private let teamId = "team_01J8ZQ4K5N7P9R3S6T8V0W2XT1"
    private let roomId = "room_01J8ZQ4K5N7P9R3S6T8V0W2XR0"
    private let devSessionId = "ses_01J8ZQ4K5N7P9R3S6T8V0W2XS2"
    private let approvalId = "apr_01J8ZQ4K5N7P9R3S6T8V0W2XE5"
    private let factory = FakeTransportFactory([])
    private let requests = Locked<[URLRequest]>([])

    override func setUp() {
        super.setUp()
        requests.value = []
    }

    override func tearDown() {
        StubURLProtocol.handler = nil
        super.tearDown()
    }

    // MARK: - helpers

    private func makeRoomModel() -> RoomModel {
        let factory = self.factory
        let client = APIClient(baseURL: baseURL, session: StubURLProtocol.makeSession())
        return RoomModel(
            teamId: teamId, roomId: roomId, client: client,
            approvalFailureDuration: .milliseconds(30),
            haptics: CountingHaptics(),
            socketFactory: { teamId, roomId, since in
                RoomSocket(baseURL: client.baseURL, teamId: teamId, roomId: roomId, since: since, transportFactory: { factory.make() })
            }
        )
    }

    private func makeTimelineModel() -> TimelineModel {
        let factory = self.factory
        let client = APIClient(baseURL: baseURL, session: StubURLProtocol.makeSession())
        return TimelineModel(
            sessionId: "ses_01J8ZQ4K5N7P9R3S6T8V0W2XAB", client: client,
            haptics: CountingHaptics(),
            socketFactory: { id, since in
                SessionSocket(baseURL: client.baseURL, sessionId: id, since: since, transportFactory: { factory.make() })
            }
        )
    }

    private func roomEvent(_ name: String, seq: Int? = nil, mutate: ((inout [String: Any]) -> Void)? = nil) throws -> RoomEvent {
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: FixtureLoader.data("room-ws/\(name).json")) as? [String: Any])
        if let seq { json["seq"] = seq }
        mutate?(&json)
        return try JSONCoding.decoder.decode(RoomEvent.self, from: JSONSerialization.data(withJSONObject: json))
    }

    /// 요청을 기록하고 메서드·경로별로 응답한다. 등록되지 않은 경로는 전송 오류.
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

    // MARK: - RoomModel as ApprovalResponding

    func testRoomModelPendingApprovalsAreApprovalsInRequestedAtOrder() throws {
        let model = makeRoomModel()
        model.apply(try roomEvent("room.snapshot"))                       // apr_…E5, requestedAt 09:10:12
        // 나중에 도착했지만 더 먼저 요청된 승인.
        model.apply(try roomEvent("room.message.approval", seq: 5) { json in
            var message = json["message"] as! [String: Any]
            message["id"] = "msg_earlier"
            message["seq"] = 5
            var roomApproval = message["approval"] as! [String: Any]
            var approval = roomApproval["approval"] as! [String: Any]
            approval["approvalId"] = "apr_earlier"
            approval["title"] = "git push 실행"
            approval["requestedAt"] = "2026-09-12T09:09:00Z"
            roomApproval["approval"] = approval
            message["approval"] = roomApproval
            json["message"] = message
        })

        let responder: any ApprovalResponding = model
        XCTAssertEqual(responder.pendingApprovals.map(\.approvalId), ["apr_earlier", approvalId], "도착 순서가 아니라 requestedAt 순")
        XCTAssertEqual(responder.pendingApprovals.map(\.title), ["git push 실행", "npm test 실행"])
        XCTAssertEqual(responder.pendingApprovals.count, model.pendingRoomApprovals.count)
        XCTAssertEqual(responder.approvalSubmit, .idle)
    }

    func testRoomModelRespondPostsToMemberSessionApprovalEndpoint() async throws {
        install([("POST", "/api/v1/sessions/\(devSessionId)/approvals/\(approvalId)", 200, Data(#"{"ok":true}"#.utf8))])
        let model = makeRoomModel()
        model.apply(try roomEvent("room.snapshot"))
        let responder: any ApprovalResponding = model
        let approval = try XCTUnwrap(responder.pendingApprovals.first)

        await responder.respond(to: approval, optionId: "deny", inputs: ["a": "b"], message: "CI에서 돌립니다")

        XCTAssertEqual(responder.approvalSubmit, .submitting(approvalId: approvalId))
        XCTAssertEqual(responder.pendingApprovals.count, 1, "확정은 서버의 room.message.updated")
        let request = try XCTUnwrap(requests.value.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path(), "/api/v1/sessions/\(devSessionId)/approvals/\(approvalId)", "카드의 sessionId 로 기존 세션 API")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
        XCTAssertEqual(body["optionId"] as? String, "deny")
        XCTAssertEqual(body["inputs"] as? [String: String], ["a": "b"])
        XCTAssertEqual(body["message"] as? String, "CI에서 돌립니다")

        model.apply(try roomEvent("room.message.updated"))                // seq 5, resolution 채워짐
        XCTAssertTrue(responder.pendingApprovals.isEmpty)
        XCTAssertEqual(responder.approvalSubmit, .idle)
    }

    func testRoomModelRespondIgnoresApprovalNotInPending() async throws {
        install([])
        let model = makeRoomModel()
        model.apply(try roomEvent("room.snapshot"))
        let responder: any ApprovalResponding = model
        var stranger = try XCTUnwrap(responder.pendingApprovals.first)
        stranger.approvalId = "apr_unknown"

        await responder.respond(to: stranger, optionId: "allow", inputs: nil, message: nil)

        XCTAssertEqual(responder.approvalSubmit, .idle)
        XCTAssertTrue(requests.value.isEmpty, "pending 에 없는 승인은 보내지 않는다")
    }

    func testRoomModelAuthorLabelIsEmojiNameAndRole() async throws {
        install([
            ("GET", "/api/v1/teams/\(teamId)", 200, try FixtureLoader.data("rest/team-detail.json")),
            ("GET", "/api/v1/teams/\(teamId)/rooms/\(roomId)", 200, try FixtureLoader.data("rest/room.json")),
        ])
        let model = makeRoomModel()
        defer { model.stop() }
        await model.start()
        model.apply(try roomEvent("room.snapshot"))
        let responder: any ApprovalResponding = model
        let approval = try XCTUnwrap(responder.pendingApprovals.first)

        XCTAssertEqual(responder.authorLabel(for: approval), "🧑‍💻 지연 · 개발자")

        var stranger = approval
        stranger.approvalId = "apr_unknown"
        XCTAssertNil(responder.authorLabel(for: stranger), "pending 에 없는 승인은 캡션 없음")
    }

    func testRoomModelAuthorLabelIsNilWhenMembersUnknown() throws {
        let model = makeRoomModel()                                       // GET /teams/:id 없이 스냅샷만
        model.apply(try roomEvent("room.snapshot"))
        let responder: any ApprovalResponding = model
        let approval = try XCTUnwrap(responder.pendingApprovals.first)
        XCTAssertNil(responder.authorLabel(for: approval), "팀원을 모르면 캡션 없음")
    }

    // MARK: - TimelineModel as ApprovalResponding

    func testTimelineModelAuthorLabelIsNil() throws {
        let model = makeTimelineModel()
        model.apply(try JSONCoding.decoder.decode(ServerEvent.self, from: FixtureLoader.data("ws/approval.requested.command.json")))
        let responder: any ApprovalResponding = model
        let approval = try XCTUnwrap(responder.pendingApprovals.first)
        XCTAssertEqual(approval.approvalId, "apr_01J8ZQ4K5N7P9R3S6T8V0W2XE1")
        XCTAssertNil(responder.authorLabel(for: approval), "타임라인에는 작성자 캡션이 없다")
        XCTAssertEqual(responder.approvalSubmit, .idle)
    }
}
