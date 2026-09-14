import Foundation
import XCTest
@testable import MacAgent

/// `RoomModel.apply` 시나리오(PROTOCOL.md 6.3, IOS.md 6절 규칙을 방에 적용). fixture 이벤트를 그대로 쓰되 seq 가 겹치면 바꿔 넣는다.
@MainActor
final class RoomModelTests: XCTestCase {
    private let baseURL = URL(string: "http://127.0.0.1:7777")!
    private let teamId = "team_01J8ZQ4K5N7P9R3S6T8V0W2XT1"
    private let roomId = "room_01J8ZQ4K5N7P9R3S6T8V0W2XR0"
    private let leadId = "agt_01J8ZQ4K5N7P9R3S6T8V0W2XA1"
    private let devId = "agt_01J8ZQ4K5N7P9R3S6T8V0W2XA2"
    private let devSessionId = "ses_01J8ZQ4K5N7P9R3S6T8V0W2XS2"
    private let approvalId = "apr_01J8ZQ4K5N7P9R3S6T8V0W2XE5"
    private let changeId = "chg_01J8ZQ4K5N7P9R3S6T8V0W2XG1"
    private let changesMessageId = "msg_01J8ZQ4K5N7P9R3S6T8V0W2XM6"
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

    private func makeModel(
        roomId: String? = nil,
        transientDuration: Duration = .milliseconds(30),
        failureDuration: Duration = .milliseconds(30)
    ) -> RoomModel {
        let factory = self.factory!
        let client = APIClient(baseURL: baseURL, session: StubURLProtocol.makeSession())
        return RoomModel(
            teamId: teamId, roomId: roomId ?? self.roomId, client: client,
            transientErrorDuration: transientDuration, approvalFailureDuration: failureDuration,
            haptics: haptics,
            socketFactory: { teamId, roomId, since in
                RoomSocket(baseURL: client.baseURL, teamId: teamId, roomId: roomId, since: since, transportFactory: { factory.make() })
            }
        )
    }

    private func json(_ path: String, mutate: ((inout [String: Any]) -> Void)? = nil) throws -> Data {
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: FixtureLoader.data(path)) as? [String: Any])
        mutate?(&json)
        return try JSONSerialization.data(withJSONObject: json)
    }

    private func event(_ name: String, seq: Int? = nil, mutate: ((inout [String: Any]) -> Void)? = nil) throws -> RoomEvent {
        try JSONCoding.decoder.decode(RoomEvent.self, from: json("room-ws/\(name).json") { json in
            if let seq { json["seq"] = seq }
            mutate?(&json)
        })
    }

    private func frame(_ name: String, seq: Int? = nil, mutate: ((inout [String: Any]) -> Void)? = nil) throws -> String {
        String(decoding: try json("room-ws/\(name).json") { json in
            if let seq { json["seq"] = seq }
            mutate?(&json)
        }, as: UTF8.self)
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

    private func installTeamAndRoom(roomBody: Data? = nil, extra: [(method: String, path: String, status: Int, body: Data)] = []) throws {
        install([
            ("GET", "/api/v1/teams/\(teamId)", 200, try FixtureLoader.data("rest/team-detail.json")),
            ("GET", "/api/v1/teams/\(teamId)/rooms/\(roomId)", 200, try roomBody ?? FixtureLoader.data("rest/room.json")),
        ] + extra)
    }

    private func waitUntil(_ condition: @MainActor () -> Bool, timeout: Duration = .seconds(3)) async throws {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline, !condition() { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(condition(), "시간 안에 조건을 만족하지 못했다")
    }

    private func openSocket(_ model: RoomModel) async throws -> FakeWebSocketTransport {
        model.resume()
        try await waitUntil { model.socketState == .open }
        return try XCTUnwrap(factory.transports.last)
    }

    private func body(of request: URLRequest?) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request?.httpBody)) as? [String: Any])
    }

    private func changes(in model: RoomModel) -> ChangeSet? {
        model.entries.first { $0.id == changesMessageId }?.message.changes
    }

    private var conflictBody: Data {
        Data(#"{"error":{"code":"conflict","message":"이미 처리된 승인입니다"}}"#.utf8)
    }

    // MARK: - RoomEntry

    func testRoomEntryClassifiesByKindAndDemotesUnknownToSystem() throws {
        func message(_ name: String, mutate: ((inout [String: Any]) -> Void)? = nil) throws -> RoomMessage {
            guard case .roomMessage(let e) = try event(name, mutate: mutate) else { throw XCTSkip("room.message 가 아니다") }
            return e.message
        }
        guard case .message = RoomEntry.make(try message("room.message.user")) else { return XCTFail("user → message") }
        guard case .message = RoomEntry.make(try message("room.message.agent")) else { return XCTFail("agent → message") }
        guard case .approval = RoomEntry.make(try message("room.message.approval")) else { return XCTFail("approval") }
        guard case .changes = RoomEntry.make(try message("room.message.changes")) else { return XCTFail("changes") }
        guard case .system = RoomEntry.make(try message("room.message.system")) else { return XCTFail("system") }

        let approvalWithoutPayload = try message("room.message.approval") { json in
            var m = json["message"] as! [String: Any]
            m["approval"] = NSNull()
            json["message"] = m
        }
        guard case .system = RoomEntry.make(approvalWithoutPayload) else { return XCTFail("approval 없는 approval 은 system 으로 강등") }
        let unknownKind = try message("room.message.user") { json in
            var m = json["message"] as! [String: Any]
            m["kind"] = "poll"
            json["message"] = m
        }
        let entry = RoomEntry.make(unknownKind)
        guard case .system = entry else { return XCTFail("모르는 kind 는 system") }
        XCTAssertEqual(entry.id, "msg_01J8ZQ4K5N7P9R3S6T8V0W2XM2")
        XCTAssertEqual(entry.seq, 2)
        XCTAssertEqual(entry.createdAt, unknownKind.createdAt)
        XCTAssertEqual(entry.message, unknownKind)
    }

    // MARK: - snapshot

    func testSnapshotFillsEntriesPendingStatesAndLastSeq() throws {
        let model = makeModel()
        model.apply(try event("room.snapshot"))

        XCTAssertEqual(model.entries.map(\.seq), [1, 2, 3, 4])
        XCTAssertEqual(model.pendingRoomApprovals.map(\.approval.approvalId), [approvalId])
        XCTAssertEqual(model.memberStates, [leadId: .idle, devId: .waitingApproval])
        XCTAssertEqual(model.dispatch?.running.map(\.memberId), [devId])
        XCTAssertEqual(model.room?.id, roomId)
        XCTAssertEqual(model.lastSeq, 4, "스냅샷 뒤의 lastSeq 는 방의 lastSeq")
        XCTAssertFalse(model.hasOlderHistory)
        XCTAssertTrue(model.isReplaying)
        XCTAssertNil(model.fatalError)
        XCTAssertEqual(haptics.warnings, 0, "스냅샷의 대기 승인은 재생이다")
    }

    func testSnapshotTruncatedSetsHasOlderHistory() throws {
        let model = makeModel()
        model.apply(try event("room.snapshot") { $0["truncated"] = true })
        XCTAssertTrue(model.hasOlderHistory)
    }

    // MARK: - messages

    func testDuplicateAndOldSeqAreIgnoredButSnapshotAndPongAreNot() throws {
        let model = makeModel()
        model.apply(try event("room.snapshot"))
        model.apply(try event("room.message.approval"))                 // seq 4 → 중복
        model.apply(try event("room.message.agent"))                    // seq 3 → 과거
        XCTAssertEqual(model.entries.count, 4)
        XCTAssertEqual(model.pendingRoomApprovals.count, 1)
        XCTAssertTrue(model.isReplaying, "중복·과거 이벤트는 라이브가 아니다")
        model.apply(try event("pong"))
        XCTAssertEqual(model.lastSeq, 4)
        XCTAssertEqual(haptics.warnings, 0)
    }

    func testLiveMessageIsAppendedInSeqOrderAndSameIdReplaces() throws {
        let model = makeModel()
        model.apply(try event("room.snapshot"))
        model.apply(try event("room.message.changes"))                  // seq 7
        XCTAssertEqual(model.entries.map(\.seq), [1, 2, 3, 4, 7])
        XCTAssertFalse(model.isReplaying)

        // 이벤트 seq 8 로 온 새 메시지(message.seq 5, 새 id)는 message.seq 순서대로 들어간다.
        model.apply(try event("room.message.agent", seq: 8) { json in
            var m = json["message"] as! [String: Any]
            m["id"] = "msg_new_agent"
            m["seq"] = 5
            json["message"] = m
        })
        XCTAssertEqual(model.entries.map(\.seq), [1, 2, 3, 4, 5, 7])
        XCTAssertEqual(model.entries[4].id, "msg_new_agent")
        XCTAssertEqual(model.lastSeq, 8)

        // 같은 id 가 다시 오면 교체된다(개수 그대로).
        model.apply(try event("room.message.agent", seq: 9) { json in
            var m = json["message"] as! [String: Any]
            m["id"] = "msg_new_agent"
            m["seq"] = 5
            m["text"] = "다시"
            json["message"] = m
        })
        XCTAssertEqual(model.entries.count, 6)
        XCTAssertEqual(model.entries[4].message.text, "다시")
        XCTAssertEqual(model.entries.map(\.id).count, Set(model.entries.map(\.id)).count)
    }

    func testMessageUpdatedResolvesApprovalKeepsOrderAndClearsSubmit() throws {
        let model = makeModel()
        model.apply(try event("room.snapshot"))
        model.apply(try event("room.message.changes"))                  // seq 7
        XCTAssertEqual(model.pendingRoomApprovals.count, 1)

        model.apply(try event("room.message.updated", seq: 9))          // message.seq 4, resolution 채워짐
        XCTAssertTrue(model.pendingRoomApprovals.isEmpty)
        XCTAssertEqual(model.entries.map(\.seq), [1, 2, 3, 4, 7], "message.seq 는 원래 값이라 정렬이 유지된다")
        guard case .approval(let updated) = model.entries[3] else { return XCTFail("approval entry") }
        XCTAssertEqual(updated.approval?.resolution?.optionId, "allow_session")
        XCTAssertEqual(model.lastSeq, 9)
        XCTAssertEqual(model.approvalSubmit, .idle)
    }

    // MARK: - status / members

    func testStatusUpdatesMemberStatesAndWorkingQueuedMembers() async throws {
        try installTeamAndRoom()
        let model = makeModel()
        defer { model.stop() }
        await model.start()
        XCTAssertEqual(model.members.map(\.id), [leadId, devId])
        XCTAssertEqual(model.lead?.id, leadId)
        XCTAssertEqual(model.leadName, "민수")
        XCTAssertTrue(model.isGroup)
        XCTAssertNil(model.dmMember)
        XCTAssertEqual(model.member(id: devId)?.handle, "jiyeon")
        XCTAssertNil(model.member(id: "agt_nope"))

        model.apply(try event("room.snapshot"))                         // A1 idle, A2 waiting_approval
        XCTAssertEqual(model.workingMembers.map(\.id), [devId])
        XCTAssertTrue(model.queuedMembers.isEmpty)

        model.apply(try event("room.status", seq: 10))                  // A2 running, 대기열에 A2 (start 뒤 lastSeq 9)
        XCTAssertEqual(model.memberStates, [leadId: .idle, devId: .running])
        XCTAssertEqual(model.dispatch?.queued.map(\.dispatchId), ["dsp_01J8ZQ4K5N7P9R3S6T8V0W2XH4"])
        XCTAssertEqual(model.workingMembers.map(\.id), [devId])
        XCTAssertTrue(model.queuedMembers.isEmpty, "작업 중인 팀원은 대기 목록에 넣지 않는다")
        XCTAssertFalse(model.isReplaying, "첫 라이브 이벤트")

        model.apply(try event("room.status", seq: 11) { json in
            json["members"] = [
                ["memberId": self.leadId, "state": "queued", "sessionId": NSNull()],
                ["memberId": self.devId, "state": "idle", "sessionId": self.devSessionId],
            ]
        })
        XCTAssertTrue(model.workingMembers.isEmpty)
        XCTAssertEqual(model.queuedMembers.map(\.id), [leadId])
    }

    func testDMRoomExposesMemberAndIsNotGroup() async throws {
        let dmRoomId = "room_01J8ZQ4K5N7P9R3S6T8V0W2XR2"
        install([
            ("GET", "/api/v1/teams/\(teamId)", 200, try FixtureLoader.data("rest/team-detail.json")),
            ("GET", "/api/v1/teams/\(teamId)/rooms/\(dmRoomId)", 200, try json("rest/room.json") { json in
                json["room"] = ["id": dmRoomId, "teamId": self.teamId, "kind": "dm", "memberId": self.devId,
                                "name": "지연", "lastSeq": 1, "lastMessageAt": NSNull()]
                json["messages"] = []
            }),
        ])
        let model = makeModel(roomId: dmRoomId)
        defer { model.stop() }
        await model.start()
        XCTAssertFalse(model.isGroup)
        XCTAssertEqual(model.dmMember?.id, devId)
        XCTAssertEqual(model.room?.kind, .dm)
        XCTAssertTrue(model.entries.isEmpty)
        XCTAssertEqual(model.lastSeq, 1)
    }

    // MARK: - 곁방 (2026-09-14, PROTOCOL.md 6.6)

    func testSideRoomDerivesParticipantsFromMembers() async throws {
        let sideRoomId = "room_01J8ZQ4K5N7P9R3S6T8V0W2XR3"
        install([
            ("GET", "/api/v1/teams/\(teamId)", 200, try FixtureLoader.data("rest/team-detail.json")),
            ("GET", "/api/v1/teams/\(teamId)/rooms/\(sideRoomId)", 200, try json("rest/room.json") { json in
                json["room"] = [
                    "id": sideRoomId, "teamId": self.teamId, "kind": "side", "memberId": NSNull(),
                    "name": "민수 ↔ 지연", "lastSeq": 7, "lastMessageAt": "2026-09-12T09:31:20Z",
                    "participants": [self.devId, self.leadId],
                ]
                json["messages"] = []
            }),
        ])
        let model = makeModel(roomId: sideRoomId)
        defer { model.stop() }
        await model.start()

        XCTAssertEqual(model.room?.kind, .side)
        XCTAssertFalse(model.isGroup)
        XCTAssertNil(model.dmMember, "곁방은 DM 상대가 없다")
        XCTAssertEqual(model.participants.map(\.id), [devId, leadId], "room.participants 순서를 따른다")
        XCTAssertEqual(model.lastSeq, 7)
    }

    func testSideRoomParticipantsSkipUnknownMembersAndAreEmptyElsewhere() async throws {
        try installTeamAndRoom()
        let model = makeModel()
        defer { model.stop() }
        await model.start()
        XCTAssertTrue(model.participants.isEmpty, "그룹방은 참가자가 없다")

        // 스냅샷이 곁방으로 바뀌면(같은 방 id) 참가자도 따라 바뀐다. 모르는 팀원은 뺀다.
        model.apply(try event("room.snapshot", mutate: { json in
            json["room"] = [
                "id": self.roomId, "teamId": self.teamId, "kind": "side", "memberId": NSNull(),
                "name": "민수 ↔ 유령", "lastSeq": 4, "lastMessageAt": NSNull(),
                "participants": [self.leadId, "agt_ghost"],
            ]
        }))
        XCTAssertEqual(model.participants.map(\.id), [leadId], "모르는 팀원은 뺀다")
    }

    // MARK: - error

    func testRecoverableErrorIsTransientAndFatalErrorStays() async throws {
        let model = makeModel(transientDuration: .milliseconds(30))
        model.apply(try event("room.error"))                            // seq 10, recoverable
        XCTAssertEqual(model.transientError, "멘션한 팀원을 찾을 수 없습니다: @철수")
        XCTAssertNil(model.fatalError)
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertNil(model.transientError)

        model.apply(try event("room.error", seq: 11) { json in
            json["recoverable"] = false
            json["message"] = "세션을 시작할 수 없습니다"
        })
        XCTAssertEqual(model.fatalError, "세션을 시작할 수 없습니다")
        XCTAssertNil(model.transientError)
        XCTAssertEqual(model.lastSeq, 11)
    }

    // MARK: - start (REST ×2) + socket

    func testStartLoadsTeamThenRoomThenConnectsWithSince() async throws {
        try installTeamAndRoom()
        let transport = FakeWebSocketTransport(steps: [.frame(try frame("room.snapshot"))])
        factory = FakeTransportFactory([transport])
        let model = makeModel()
        defer { model.stop() }

        await model.start()

        XCTAssertEqual(requests.value.map { $0.url?.path() ?? "" }, [
            "/api/v1/teams/\(teamId)", "/api/v1/teams/\(teamId)/rooms/\(roomId)",
        ], "팀 → 방 순서로 GET 두 번")
        XCTAssertEqual(model.members.count, 2)
        XCTAssertEqual(model.room?.name, "전체")
        XCTAssertEqual(model.entries.map(\.seq), [1, 2, 3, 4, 6, 7, 8])
        XCTAssertEqual(model.dispatch?.queued.count, 1, "GET /teams/:id 의 dispatch")
        XCTAssertFalse(model.hasOlderHistory)
        XCTAssertEqual(model.lastSeq, 9, "room.lastSeq(9) > 마지막 메시지 seq(8)")
        XCTAssertNil(model.fatalError)

        try await waitUntil { model.socketState == .open }
        XCTAssertEqual(transport.connectRequests.first?.url?.query(), "since=9")
        XCTAssertEqual(transport.connectRequests.first?.url?.path(), "/api/v1/teams/\(teamId)/rooms/\(roomId)/ws")
        try await waitUntil { model.isReplaying }
        XCTAssertEqual(model.pendingRoomApprovals.count, 1, "스냅샷이 apply 로 흘러들어온다")
        XCTAssertEqual(model.entries.count, 7, "같은 id 는 교체된다")
        XCTAssertEqual(model.lastSeq, 9)
        XCTAssertEqual(haptics.warnings, 0)
    }

    func testStartWithRestFailureStillConnectsSocket() async throws {
        install([])
        let model = makeModel()
        defer { model.stop() }
        await model.start()
        XCTAssertEqual(model.fatalError, ErrorMessages.cannotConnect)
        XCTAssertTrue(model.entries.isEmpty)
        try await waitUntil { model.socketState == .open }
        XCTAssertEqual(factory.transports.last?.connectRequests.first?.url?.query(), "since=0")
    }

    func testReloadMembersReplacesMembersFromTeamDetail() async throws {
        install([])
        let model = makeModel()
        defer { model.stop() }
        XCTAssertTrue(model.members.isEmpty)

        install([("GET", "/api/v1/teams/\(teamId)", 200, try json("rest/team-detail.json") { json in
            var team = json["team"] as! [String: Any]
            var members = team["members"] as! [[String: Any]]
            members[0]["mode"] = "full-auto"
            members[0]["effort"] = "max"
            team["members"] = members
            json["team"] = team
        })])
        await model.reloadMembers()

        XCTAssertEqual(requests.value.map { $0.url?.path() ?? "" }, ["/api/v1/teams/\(teamId)"], "GET /teams/:id 한 번")
        XCTAssertEqual(model.members.map(\.name), ["민수", "지연"])
        XCTAssertEqual(model.members[0].mode, .fullAuto, "서버 값으로 교체된다")
        XCTAssertEqual(model.members[0].effort, "max")
        XCTAssertNil(model.fatalError)

        install([])
        await model.reloadMembers()
        XCTAssertEqual(model.members.count, 2, "실패하면 이전 값을 둔다")
        XCTAssertNil(model.fatalError, "재조회 실패는 배너를 띄우지 않는다")
    }

    // MARK: - send

    func testSendOverOpenSocketUsesRoomSendAndNoOptimisticEntry() async throws {
        let model = makeModel()
        defer { model.stop() }
        model.apply(try event("room.snapshot"))
        let transport = try await openSocket(model)

        await model.send(text: "  @지연 README 에 변경 내용도 적어줘 \n")

        XCTAssertFalse(model.isSending)
        let sent = try XCTUnwrap(transport.sent.last)
        XCTAssertEqual(
            try XCTUnwrap(JSONSerialization.jsonObject(with: Data(sent.utf8)) as? NSDictionary),
            try XCTUnwrap(JSONSerialization.jsonObject(with: FixtureLoader.data("room-client/room.send.json")) as? NSDictionary)
        )
        XCTAssertEqual(model.entries.count, 4, "사용자 메시지는 서버 에코를 기다린다")
        XCTAssertTrue(requests.value.isEmpty, "소켓이 열려 있으면 REST 를 쓰지 않는다")
        XCTAssertNil(model.transientError)

        await model.send(text: "   ")
        XCTAssertEqual(transport.sent.count, 1, "빈 텍스트는 보내지 않는다")

        transport.push(.frame(try frame("room.message.user", seq: 8) { json in
            var m = json["message"] as! [String: Any]
            m["id"] = "msg_echo"
            m["seq"] = 8
            json["message"] = m
        }))
        try await waitUntil { model.entries.count == 5 }
        XCTAssertEqual(model.entries.last?.id, "msg_echo")
    }

    func testSendWithoutOpenSocketPostsViaRest() async throws {
        install([("POST", "/api/v1/teams/\(teamId)/rooms/\(roomId)/messages", 201, try FixtureLoader.data("rest/room-message-post.json"))])
        let model = makeModel()
        model.apply(try event("room.snapshot"))

        await model.send(text: "@지연 README 에 변경 내용도 적어줘", attachments: [Attachment(mediaType: "image/png", base64: "aGk=")])

        let request = try XCTUnwrap(requests.value.first)
        XCTAssertEqual(request.httpMethod, "POST")
        let body = try body(of: request)
        XCTAssertEqual(body["text"] as? String, "@지연 README 에 변경 내용도 적어줘")
        XCTAssertEqual((body["attachments"] as? [[String: Any]])?.first?["mediaType"] as? String, "image/png")
        XCTAssertNil(model.transientError)
        XCTAssertEqual(model.entries.map(\.seq), [1, 2, 3, 4, 8], "REST 응답의 메시지는 서버 확정값이라 넣는다")
        XCTAssertEqual(model.lastSeq, 4, "REST 응답은 lastSeq 를 올리지 않는다(소켓 재생을 버리지 않도록)")
    }

    func testSendFailureShowsSendFailed() async throws {
        install([])
        let model = makeModel(transientDuration: .seconds(10))
        await model.send(text: "hello")
        XCTAssertEqual(model.transientError, ErrorMessages.sendFailed)
    }

    // MARK: - interrupt

    func testInterruptSendsRoomInterrupt() async throws {
        let model = makeModel(transientDuration: .seconds(10))
        defer { model.stop() }
        await model.interrupt(memberId: devId)
        XCTAssertNil(model.transientError, "소켓이 없으면 조용히 무시한다")
        let transport = try await openSocket(model)
        await model.interrupt(memberId: devId)
        await model.interrupt(memberId: nil)
        XCTAssertEqual(transport.sent.count, 2)
        XCTAssertEqual(
            try XCTUnwrap(JSONSerialization.jsonObject(with: Data(transport.sent[0].utf8)) as? NSDictionary),
            try XCTUnwrap(JSONSerialization.jsonObject(with: FixtureLoader.data("room-client/room.interrupt.json")) as? NSDictionary)
        )
        XCTAssertEqual(
            try XCTUnwrap(JSONSerialization.jsonObject(with: Data(transport.sent[1].utf8)) as? NSDictionary),
            ["type": "room.interrupt"] as NSDictionary
        )
    }

    // MARK: - respond (기존 세션 API, 방 소켓으로 보내지 않는다)

    func testRespondPostsToSessionApprovalEndpointAndWaitsForUpdated() async throws {
        install([("POST", "/api/v1/sessions/\(devSessionId)/approvals/\(approvalId)", 200, Data(#"{"ok":true}"#.utf8))])
        let model = makeModel()
        defer { model.stop() }
        model.apply(try event("room.snapshot"))
        let transport = try await openSocket(model)
        let pending = try XCTUnwrap(model.pendingRoomApprovals.first)

        await model.respond(to: pending, optionId: "deny", inputs: ["a": "b"], message: "CI에서 돌립니다")

        XCTAssertEqual(model.approvalSubmit, .submitting(approvalId: approvalId))
        XCTAssertEqual(model.pendingRoomApprovals.count, 1, "낙관적으로 pending 에서 빼지 않는다")
        XCTAssertTrue(transport.sent.isEmpty, "승인 응답은 방 소켓으로 보내지 않는다")
        let request = try XCTUnwrap(requests.value.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path(), "/api/v1/sessions/\(devSessionId)/approvals/\(approvalId)")
        let body = try body(of: request)
        XCTAssertEqual(body["optionId"] as? String, "deny")
        XCTAssertEqual(body["inputs"] as? [String: String], ["a": "b"])
        XCTAssertEqual(body["message"] as? String, "CI에서 돌립니다")

        transport.push(.frame(try frame("room.message.updated")))       // seq 5
        try await waitUntil { model.pendingRoomApprovals.isEmpty }
        XCTAssertEqual(model.approvalSubmit, .idle)
    }

    func testRespondConflictMarksAlreadyResolvedThenRemovesPendingAndRefreshes() async throws {
        try installTeamAndRoom(extra: [("POST", "/api/v1/sessions/\(devSessionId)/approvals/\(approvalId)", 409, conflictBody)])
        let model = makeModel(failureDuration: .milliseconds(30))
        model.apply(try event("room.snapshot"))

        await model.respond(to: try XCTUnwrap(model.pendingRoomApprovals.first), optionId: "allow")

        XCTAssertEqual(model.approvalSubmit, .failed(approvalId: approvalId, message: ErrorMessages.approvalAlreadyResolved))
        XCTAssertEqual(model.pendingRoomApprovals.count, 1, "문구를 보여주는 동안은 아직 pending")
        try await waitUntil { model.approvalSubmit == .idle }
        XCTAssertTrue(model.pendingRoomApprovals.isEmpty)
        try await waitUntil { model.entries.count == 7 }
        XCTAssertTrue(requests.value.contains { $0.httpMethod == "GET" && $0.url?.path() == "/api/v1/teams/\(self.teamId)/rooms/\(self.roomId)" },
                      "방을 다시 읽어 서버 상태와 맞춘다")
        guard case .approval(let entry) = model.entries[3] else { return XCTFail("approval entry") }
        XCTAssertEqual(entry.approval?.resolution?.optionId, "allow_session", "REST 의 확정값")
        XCTAssertEqual(model.lastSeq, 4, "재조회는 lastSeq 를 올리지 않는다")
    }

    func testRespondTransportFailureKeepsPending() async throws {
        install([])
        let model = makeModel(failureDuration: .milliseconds(30))
        model.apply(try event("room.snapshot"))
        await model.respond(to: try XCTUnwrap(model.pendingRoomApprovals.first), optionId: "allow")
        XCTAssertEqual(model.approvalSubmit, .failed(approvalId: approvalId, message: ErrorMessages.approvalSendFailed))
        try await waitUntil { model.approvalSubmit == .idle }
        XCTAssertEqual(model.pendingRoomApprovals.count, 1, "보내지 못한 승인은 그대로 남는다")
        XCTAssertEqual(requests.value.count, 1, "전송 실패는 재조회 사유가 아니다")
    }

    func testRespondIgnoresUnknownApprovalAndConcurrentSubmit() async throws {
        install([("POST", "/api/v1/sessions/\(devSessionId)/approvals/\(approvalId)", 200, Data(#"{"ok":true}"#.utf8))])
        let model = makeModel()
        model.apply(try event("room.snapshot"))
        var stranger = try XCTUnwrap(model.pendingRoomApprovals.first)
        stranger.approval.approvalId = "apr_unknown"
        await model.respond(to: stranger, optionId: "allow")
        XCTAssertEqual(model.approvalSubmit, .idle)
        XCTAssertTrue(requests.value.isEmpty)

        await model.respond(to: try XCTUnwrap(model.pendingRoomApprovals.first), optionId: "allow")
        XCTAssertEqual(model.approvalSubmit, .submitting(approvalId: approvalId))
        await model.respond(to: try XCTUnwrap(model.pendingRoomApprovals.first), optionId: "deny")
        XCTAssertEqual(requests.value.count, 1, "전송 중에는 다시 보내지 않는다")
    }

    // MARK: - merge / dismiss (REST, 확정은 서버 값)

    func testRequestMergePostsAndReplacesChangesFromResult() async throws {
        install([("POST", "/api/v1/teams/\(teamId)/changes/\(changeId)/merge", 200, try FixtureLoader.data("rest/merge-result.json"))])
        let model = makeModel()
        model.apply(try event("room.snapshot"))
        model.apply(try event("room.message.changes"))                  // seq 7
        let change = try XCTUnwrap(changes(in: model))
        XCTAssertEqual(change.status, .ready)

        await model.requestMerge(change)

        let request = try XCTUnwrap(requests.value.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path(), "/api/v1/teams/\(teamId)/changes/\(changeId)/merge")
        XCTAssertEqual(model.mergeSubmit, .idle)
        XCTAssertEqual(changes(in: model)?.status, .merged, "응답의 ChangeSet 은 서버 확정값")
        XCTAssertEqual(model.entries.map(\.seq), [1, 2, 3, 4, 7])
    }

    func testRequestMergeFailureSetsFailedThenIdleWithoutChangingCard() async throws {
        install([("POST", "/api/v1/teams/\(teamId)/changes/\(changeId)/merge", 409, Data(#"{"error":{"code":"conflict","message":"작업 트리가 깨끗하지 않습니다"}}"#.utf8))])
        let model = makeModel(failureDuration: .milliseconds(30))
        model.apply(try event("room.snapshot"))
        model.apply(try event("room.message.changes"))
        let change = try XCTUnwrap(changes(in: model))

        await model.requestMerge(change)

        XCTAssertEqual(model.mergeSubmit, .failed(changeId: changeId, message: "작업 트리가 깨끗하지 않습니다"))
        XCTAssertEqual(changes(in: model)?.status, .ready, "낙관적 갱신 없음")
        try await waitUntil { model.mergeSubmit == .idle }
    }

    func testMergeSubmitIsClearedByMessageUpdated() async throws {
        install([])  // 응답이 없는 서버: submitting 상태에서 이벤트가 먼저 온다고 가정
        let model = makeModel(failureDuration: .seconds(10))
        model.apply(try event("room.snapshot"))
        model.apply(try event("room.message.changes"))
        let change = try XCTUnwrap(changes(in: model))
        let task = Task { await model.requestMerge(change) }
        try await waitUntil { model.mergeSubmit != .idle }
        model.apply(try event("room.message.changes", seq: 8) { json in
            json["type"] = "room.message.updated"
            var m = json["message"] as! [String: Any]
            var c = m["changes"] as! [String: Any]
            c["status"] = "merged"
            m["changes"] = c
            json["message"] = m
        })
        XCTAssertEqual(changes(in: model)?.status, .merged)
        await task.value
        XCTAssertEqual(model.mergeSubmit, .idle, "이벤트로 확정된 뒤의 전송 실패는 무시한다")
    }

    func testMergeFailureIsClearedByMessageUpdatedMerged() async throws {
        install([("POST", "/api/v1/teams/\(teamId)/changes/\(changeId)/merge", 409, Data(#"{"error":{"code":"conflict","message":"작업 트리가 깨끗하지 않습니다"}}"#.utf8))])
        let model = makeModel(failureDuration: .seconds(10))
        model.apply(try event("room.snapshot"))
        model.apply(try event("room.message.changes"))
        let change = try XCTUnwrap(changes(in: model))
        await model.requestMerge(change)
        XCTAssertEqual(model.mergeSubmit, .failed(changeId: changeId, message: "작업 트리가 깨끗하지 않습니다"))
        let failedEntry = try XCTUnwrap(model.entries.first { $0.id == changesMessageId }?.message)
        XCTAssertEqual(
            ChangesCardState.make(message: failedEntry, member: nil, submit: model.mergeSubmit).errorLine,
            "작업 트리가 깨끗하지 않습니다", "카드 하단 빨간 캡션"
        )

        // 다른 클라이언트가 머지해 updated(merged) 가 오면 실패 문구도 걷고 카드는 서버 값으로 확정된다.
        model.apply(try event("room.message.changes", seq: 8) { json in
            json["type"] = "room.message.updated"
            var m = json["message"] as! [String: Any]
            var c = m["changes"] as! [String: Any]
            c["status"] = "merged"
            m["changes"] = c
            json["message"] = m
        })
        XCTAssertEqual(changes(in: model)?.status, .merged)
        XCTAssertEqual(model.mergeSubmit, .idle)
        let mergedEntry = try XCTUnwrap(model.entries.first { $0.id == changesMessageId }?.message)
        let state = ChangesCardState.make(message: mergedEntry, member: nil, submit: model.mergeSubmit)
        XCTAssertEqual(state.statusLine, "병합됨 · a1b2c3d")
        XCTAssertEqual(state.action, .none)
        XCTAssertNil(state.errorLine)
    }

    func testDismissPostsAndReplacesChanges() async throws {
        install([("POST", "/api/v1/teams/\(teamId)/changes/\(changeId)/dismiss", 200, try json("rest/merge-result.json") { json in
            var c = json["change"] as! [String: Any]
            c["status"] = "dismissed"
            json = c
        })])
        let model = makeModel()
        model.apply(try event("room.snapshot"))
        model.apply(try event("room.message.changes"))
        let change = try XCTUnwrap(changes(in: model))

        await model.dismiss(change)

        XCTAssertEqual(requests.value.first?.url?.path(), "/api/v1/teams/\(teamId)/changes/\(changeId)/dismiss")
        XCTAssertEqual(model.mergeSubmit, .idle)
        XCTAssertEqual(changes(in: model)?.status, .dismissed)
    }

    // MARK: - haptics

    func testHapticsOnlyForLiveApprovalMessages() throws {
        let model = makeModel()
        model.apply(try event("room.snapshot"))
        XCTAssertEqual(haptics.warnings, 0)
        model.apply(try event("room.message.approval"))                 // seq 4 → 재생 중복
        XCTAssertEqual(haptics.warnings, 0)
        XCTAssertTrue(model.isReplaying)

        model.apply(try event("room.message.approval", seq: 5) { json in
            var m = json["message"] as! [String: Any]
            m["id"] = "msg_live_approval"
            m["seq"] = 5
            var a = m["approval"] as! [String: Any]
            var ap = a["approval"] as! [String: Any]
            ap["approvalId"] = "apr_live"
            ap["requestedAt"] = "2026-09-12T09:11:00Z"
            a["approval"] = ap
            m["approval"] = a
            json["message"] = m
        })
        XCTAssertEqual(haptics.warnings, 1, "첫 라이브 승인 요청")
        XCTAssertFalse(model.isReplaying)
        XCTAssertEqual(model.pendingRoomApprovals.map(\.approval.approvalId), [approvalId, "apr_live"], "requestedAt 오름차순")

        model.apply(try event("room.message.updated", seq: 6))          // 이미 처리된 승인 갱신은 햅틱 없음
        XCTAssertEqual(haptics.warnings, 1)
        XCTAssertEqual(model.pendingRoomApprovals.map(\.approval.approvalId), ["apr_live"])

        model.apply(try event("room.snapshot"))                         // 재접속 스냅샷: 다시 재생
        XCTAssertTrue(model.isReplaying)
        XCTAssertEqual(haptics.warnings, 1)
    }
}
