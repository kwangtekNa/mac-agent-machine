import Foundation
import XCTest
@testable import MacAgent

/// 계약 테스트: `packages/protocol/fixtures/` 의 72개 JSON 을 Swift Codable 로 전수 디코딩한다.
/// TS 쪽 `packages/protocol/test/fixtures.test.ts` 의 매핑표와 대칭이다.
/// 팀·방(2026-09-12 추가) fixture 는 `Team`/`Room`/`RoomEvent`/`RoomClientMessage` 로 디코드한다. 방 이벤트는 세션 WS 와 별도 enum 이다.
final class ProtocolFixturesTests: XCTestCase {
    private typealias Decoder = (Data) throws -> Any

    private static func decode<T: Decodable>(_ type: T.Type) -> Decoder {
        { data in try JSONCoding.decoder.decode(T.self, from: data) }
    }

    /// 파일 상대 경로 → 디코더. 폴더의 모든 `.json` 이 여기 있어야 하고, 여기 있는 키는 전부 파일로 있어야 한다.
    private static func table() -> [String: Decoder] {
        var t: [String: Decoder] = [
            // rest/ 18개
            "rest/me.json": decode(MeResponse.self),
            "rest/projects.json": decode(ProjectsResponse.self),
            "rest/sessions.json": decode(SessionsResponse.self),
            "rest/session.json": decode(Session.self),
            "rest/session-detail.json": decode(SessionDetailResponse.self),
            "rest/fs-list.json": decode(FsListResponse.self),
            "rest/fs-read-text.json": decode(FsReadResponse.self),
            "rest/fs-read-image.json": decode(FsReadResponse.self),
            "rest/git-status.json": decode(GitStatusResponse.self),
            "rest/git-diff.json": decode(GitDiffResponse.self),
            "rest/error.json": decode(ErrorResponse.self),
            "rest/login-start.json": decode(LoginStartResponse.self),
            "rest/login-status.json": decode(LoginStatusResponse.self),
            // 2026-09-10 추가분(사용량·모델·mkdir)
            "rest/fs-mkdir.json": decode(FsMkdirResponse.self),
            "rest/usage.json": decode(UsageResponse.self),
            "rest/usage-empty.json": decode(UsageResponse.self),
            "rest/models-claude.json": decode(ModelsResponse.self),
            "rest/models-codex.json": decode(ModelsResponse.self),
        ]
        // ws/ 23개: 전부 ServerEvent
        for name in wsExpectations.keys {
            t["ws/\(name).json"] = decode(ServerEvent.self)
        }
        // client/ 5개: 전부 ClientMessage
        for name in clientExpectations.keys {
            t["client/\(name).json"] = decode(ClientMessage.self)
        }
        // 2026-09-12 추가분(팀·방) rest 10개
        t["rest/team-roles.json"] = decode(TeamRolesResponse.self)
        t["rest/teams.json"] = decode(TeamsResponse.self)
        t["rest/team.json"] = decode(Team.self)
        t["rest/team-detail.json"] = decode(TeamDetailResponse.self)
        t["rest/room.json"] = decode(RoomDetailResponse.self)
        t["rest/room-message-post.json"] = decode(PostRoomMessageResponse.self)
        t["rest/changes.json"] = decode(ChangesResponse.self)
        t["rest/merge-result.json"] = decode(MergeResult.self)
        t["rest/team-templates.json"] = decode(TeamTemplatesResponse.self)
        t["rest/team-template.json"] = decode(TeamTemplate.self)
        // 2026-09-13 추가분(git init) rest 2개
        t["rest/git-init.json"] = decode(GitInitResponse.self)
        t["rest/git-init-dry-run.json"] = decode(GitInitResponse.self)
        // 2026-09-13 추가분(net ports) rest 1개. iOS step 1 이 실제 타입(NetPortsResponse)으로 바꾼다.
        t["rest/net-ports.json"] = decode(JSONValue.self)
        // room-ws/ 10개: 전부 RoomEvent (세션 ServerEvent 와 별도 enum)
        for name in roomWsExpectations.keys {
            t["room-ws/\(name).json"] = decode(RoomEvent.self)
        }
        // room-client/ 3개: 전부 RoomClientMessage
        for name in roomClientExpectations.keys {
            t["room-client/\(name).json"] = decode(RoomClientMessage.self)
        }
        return t
    }

    /// TS 쪽 fixtures.test.ts 의 ADDED_2026_09_13 과 같은 집합(git init 2개 + net ports 1개).
    private static let ADDED_2026_09_13: Set<String> = [
        "rest/git-init.json",
        "rest/git-init-dry-run.json",
        "rest/net-ports.json",
    ]

    /// TS 쪽 fixtures.test.ts 의 ADDED_2026_09_12 와 같은 집합(rest 10 + room-ws 10 + room-client 3).
    private static let ADDED_2026_09_12: Set<String> = [
        "rest/team-roles.json",
        "rest/teams.json",
        "rest/team.json",
        "rest/team-detail.json",
        "rest/room.json",
        "rest/room-message-post.json",
        "rest/changes.json",
        "rest/merge-result.json",
        "rest/team-templates.json",
        "rest/team-template.json",
        "room-ws/room.snapshot.json",
        "room-ws/room.message.user.json",
        "room-ws/room.message.agent.json",
        "room-ws/room.message.approval.json",
        "room-ws/room.message.changes.json",
        "room-ws/room.message.system.json",
        "room-ws/room.message.updated.json",
        "room-ws/room.status.json",
        "room-ws/room.error.json",
        "room-ws/pong.json",
        "room-client/room.send.json",
        "room-client/room.interrupt.json",
        "room-client/ping.json",
    ]

    /// `ws/<type>[.<variant>].json` → 기대하는 type 과 (있으면) 아이템 kind / 승인 kind.
    private static let wsExpectations: [String: (type: ServerEvent.EventType, itemKind: TimelineItemKind?, approvalKind: ApprovalKind?)] = [
        "session.snapshot": (.sessionSnapshot, nil, nil),
        "item.started.user_message": (.itemStarted, .userMessage, nil),
        "item.started.assistant_message": (.itemStarted, .assistantMessage, nil),
        "item.started.reasoning": (.itemStarted, .reasoning, nil),
        "item.started.tool_call": (.itemStarted, .toolCall, nil),
        "item.started.file_change": (.itemStarted, .fileChange, nil),
        "item.started.plan": (.itemStarted, .plan, nil),
        "item.started.approval": (.itemStarted, .approval, nil),
        "item.started.turn_summary": (.itemStarted, .turnSummary, nil),
        "item.started.error": (.itemStarted, .error, nil),
        "item.started.system": (.itemStarted, .system, nil),
        "item.delta": (.itemDelta, nil, nil),
        "item.completed.tool_call": (.itemCompleted, .toolCall, nil),
        "approval.requested.command": (.approvalRequested, nil, .command),
        "approval.requested.file_change": (.approvalRequested, nil, .fileChange),
        "approval.requested.permission": (.approvalRequested, nil, .permission),
        "approval.requested.user_input": (.approvalRequested, nil, .userInput),
        "approval.resolved": (.approvalResolved, nil, nil),
        "session.status": (.sessionStatus, nil, nil),
        "session.usage": (.sessionUsage, nil, nil),
        "turn.completed": (.turnCompleted, nil, nil),
        "error": (.error, nil, nil),
        "pong": (.pong, nil, nil),
    ]

    private static let clientExpectations: [String: ClientMessage.MessageType] = [
        "turn.start": .turnStart,
        "turn.interrupt": .turnInterrupt,
        "approval.respond": .approvalRespond,
        "session.setMode": .sessionSetMode,
        "ping": .ping,
    ]

    /// `room-ws/<type>[.<variant>].json` → 기대하는 방 이벤트 type.
    private static let roomWsExpectations: [String: RoomEvent.EventType] = [
        "room.snapshot": .roomSnapshot,
        "room.message.user": .roomMessage,
        "room.message.agent": .roomMessage,
        "room.message.approval": .roomMessage,
        "room.message.changes": .roomMessage,
        "room.message.system": .roomMessage,
        "room.message.updated": .roomMessageUpdated,
        "room.status": .roomStatus,
        "room.error": .roomError,
        "pong": .pong,
    ]

    private static let roomClientExpectations: [String: RoomClientMessage.MessageType] = [
        "room.send": .send,
        "room.interrupt": .interrupt,
        "ping": .ping,
    ]

    private func decodeFixture<T: Decodable>(_ type: T.Type, _ path: String) throws -> T {
        try JSONCoding.decoder.decode(T.self, from: FixtureLoader.data(path))
    }

    // MARK: - 매핑표 ↔ 폴더 (누락 방지)

    func testEveryFixtureFileIsInTableAndViceVersa() throws {
        let files = try FixtureLoader.allJSONPaths()
        let keys = Self.table().keys.sorted()
        XCTAssertEqual(files, keys, "fixtures/ 의 파일 목록과 매핑표가 다르다")
        XCTAssertEqual(files.count, 72)
        // TS 쪽 fixtures.test.ts 의 ADDED_2026_09_10 과 같은 집합
        for added in [
            "rest/usage.json", "rest/usage-empty.json", "rest/models-claude.json", "rest/models-codex.json",
            "rest/fs-mkdir.json", "ws/session.usage.json",
        ] {
            XCTAssertTrue(keys.contains(added), "\(added) 이 매핑표에 없다")
        }
        // TS 쪽 fixtures.test.ts 의 ADDED_2026_09_12 와 같은 집합(팀·방 23개)
        XCTAssertEqual(Self.ADDED_2026_09_12.count, 23)
        for added in Self.ADDED_2026_09_12 {
            XCTAssertTrue(keys.contains(added), "\(added) 이 매핑표에 없다")
        }
        // TS 쪽 fixtures.test.ts 의 ADDED_2026_09_13 과 같은 집합(git init 2개 + net ports 1개)
        XCTAssertEqual(Self.ADDED_2026_09_13.count, 3)
        for added in Self.ADDED_2026_09_13 {
            XCTAssertTrue(keys.contains(added), "\(added) 이 매핑표에 없다")
        }
        // 방 이벤트는 ws/·client/ 가 아니라 room-ws/·room-client/ 에만 있다(ServerEvent enum 이 깨지지 않도록)
        XCTAssertFalse(files.contains { $0.hasPrefix("ws/room.") || $0.hasPrefix("client/room.") })
    }

    func testTableCoversEveryEventTypeItemKindAndClientType() {
        let eventTypes = Set(Self.wsExpectations.values.map(\.type))
        XCTAssertEqual(eventTypes, Set(ServerEvent.EventType.allCases))
        let itemKinds = Set(Self.wsExpectations.values.compactMap(\.itemKind))
        XCTAssertEqual(itemKinds, Set(TimelineItemKind.allCases))
        XCTAssertEqual(Set(Self.clientExpectations.values), Set(ClientMessage.MessageType.allCases))
        XCTAssertEqual(Set(Self.roomWsExpectations.values), Set(RoomEvent.EventType.allCases))
        XCTAssertEqual(Set(Self.roomClientExpectations.values), Set(RoomClientMessage.MessageType.allCases))
        // 방 fixture 표는 ADDED_2026_09_12 와 정확히 같은 파일을 가리킨다
        let roomFiles = Set(Self.roomWsExpectations.keys.map { "room-ws/\($0).json" })
            .union(Self.roomClientExpectations.keys.map { "room-client/\($0).json" })
        XCTAssertTrue(roomFiles.isSubset(of: Self.ADDED_2026_09_12))
        XCTAssertEqual(roomFiles.count, 13)
    }

    // MARK: - 전수 디코딩

    func testAllFixturesDecode() throws {
        for (path, decode) in Self.table().sorted(by: { $0.key < $1.key }) {
            let data = try FixtureLoader.data(path)
            XCTAssertNoThrow(try decode(data), "\(path) 디코딩 실패")
            do {
                _ = try decode(data)
            } catch {
                XCTFail("\(path): \(error)")
            }
        }
    }

    func testWsFixturesHaveExpectedTypeAndKinds() throws {
        for (name, expected) in Self.wsExpectations {
            let event = try decodeFixture(ServerEvent.self, "ws/\(name).json")
            XCTAssertEqual(event.type, expected.type, name)
            XCTAssertEqual(event.sessionId, "ses_01J8ZQ4K5N7P9R3S6T8V0W2XAB", name)
            switch event {
            case .itemStarted(let e), .itemCompleted(let e):
                XCTAssertEqual(e.item.kind, expected.itemKind, name)
                XCTAssertEqual(e.item.payload.kind, expected.itemKind, name)
            case .approvalRequested(let e):
                XCTAssertEqual(e.approval.kind, expected.approvalKind, name)
            default:
                XCTAssertNil(expected.itemKind, name)
                XCTAssertNil(expected.approvalKind, name)
            }
            if expected.type == .sessionSnapshot || expected.type == .pong {
                XCTAssertEqual(event.seq, 0, name)
            } else {
                XCTAssertGreaterThan(event.seq, 0, name)
            }
        }
    }

    // MARK: - client/ 왕복

    func testClientFixturesRoundTrip() throws {
        for (name, expectedType) in Self.clientExpectations {
            let data = try FixtureLoader.data("client/\(name).json")
            let message = try JSONCoding.decoder.decode(ClientMessage.self, from: data)
            XCTAssertEqual(message.type, expectedType, name)

            let encoded = try JSONCoding.encoder.encode(message)
            let original = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary, name)
            let reencoded = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? NSDictionary, name)
            XCTAssertEqual(reencoded, original, "client/\(name).json 왕복 결과가 fixture 와 다르다")

            // 디코드 → 인코드 → 디코드도 같은 값
            XCTAssertEqual(try JSONCoding.decoder.decode(ClientMessage.self, from: encoded), message, name)
        }
    }

    // MARK: - room-ws/ 와 room-client/ (2026-09-12 추가)

    func testRoomWsFixturesHaveExpectedType() throws {
        for (name, expectedType) in Self.roomWsExpectations {
            let event = try decodeFixture(RoomEvent.self, "room-ws/\(name).json")
            XCTAssertEqual(event.type, expectedType, name)
            XCTAssertEqual(event.roomId, "room_01J8ZQ4K5N7P9R3S6T8V0W2XR0", name)
            XCTAssertEqual(event.teamId, "team_01J8ZQ4K5N7P9R3S6T8V0W2XT1", name)
            if expectedType == .roomSnapshot || expectedType == .pong {
                XCTAssertEqual(event.seq, 0, name)
            } else {
                XCTAssertGreaterThan(event.seq, 0, name)
            }
            switch event {
            case .roomMessage(let e), .roomMessageUpdated(let e):
                XCTAssertEqual(e.message.roomId, event.roomId, name)
                XCTAssertGreaterThan(e.message.seq, 0, name)
            default:
                break
            }
        }
    }

    func testRoomClientFixturesRoundTrip() throws {
        for (name, expectedType) in Self.roomClientExpectations {
            let data = try FixtureLoader.data("room-client/\(name).json")
            let message = try JSONCoding.decoder.decode(RoomClientMessage.self, from: data)
            XCTAssertEqual(message.type, expectedType, name)

            let encoded = try JSONCoding.encoder.encode(message)
            let original = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary, name)
            let reencoded = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? NSDictionary, name)
            XCTAssertEqual(reencoded, original, "room-client/\(name).json 왕복 결과가 fixture 와 다르다")
            XCTAssertEqual(try JSONCoding.decoder.decode(RoomClientMessage.self, from: encoded), message, name)
        }
    }

    // MARK: - 핵심 값 단언

    func testToolCallItemStarted() throws {
        let event = try decodeFixture(ServerEvent.self, "ws/item.started.tool_call.json")
        guard case .itemStarted(let e) = event else { return XCTFail("item.started 가 아니다") }
        XCTAssertEqual(e.item.kind, .toolCall)
        XCTAssertEqual(e.item.status, .running)
        XCTAssertNil(e.item.completedAt)
        guard case .toolCall(let payload) = e.item.payload else { return XCTFail("payload 가 .toolCall 이 아니다") }
        XCTAssertEqual(payload.tool, .bash)
        XCTAssertEqual(payload.name, "Bash")
        XCTAssertEqual(payload.title, "npm test")
        XCTAssertEqual(payload.input["command"], .string("npm test"))
        XCTAssertEqual(payload.input["timeout"], .number(120_000))
        XCTAssertNil(payload.exitCode)
        XCTAssertFalse(payload.truncated)
    }

    func testToolCallItemCompletedHasExitCode() throws {
        let event = try decodeFixture(ServerEvent.self, "ws/item.completed.tool_call.json")
        guard case .itemCompleted(let e) = event, case .toolCall(let payload) = e.item.payload else {
            return XCTFail("item.completed tool_call 이 아니다")
        }
        XCTAssertEqual(payload.exitCode, 0)
        XCTAssertNotNil(e.item.completedAt)
        XCTAssertFalse(payload.output.isEmpty)
    }

    func testApprovalRequestedCommand() throws {
        let event = try decodeFixture(ServerEvent.self, "ws/approval.requested.command.json")
        guard case .approvalRequested(let e) = event else { return XCTFail("approval.requested 가 아니다") }
        let approval = e.approval
        XCTAssertEqual(approval.kind, .command)
        XCTAssertEqual(approval.approvalId, "apr_01J8ZQ4K5N7P9R3S6T8V0W2XE1")
        XCTAssertEqual(approval.options.count, 3)
        XCTAssertEqual(approval.options.map(\.id), ["allow", "allow_session", "deny"])
        XCTAssertEqual(approval.options.map(\.style), [.primary, .secondary, .destructive])
        XCTAssertEqual(approval.detail, "cwd: /Users/alice/work/app\n$ npm test")
        XCTAssertNil(approval.diff)
        XCTAssertTrue(approval.inputFields.isEmpty)
    }

    func testApprovalRequestedUserInputFields() throws {
        let event = try decodeFixture(ServerEvent.self, "ws/approval.requested.user_input.json")
        guard case .approvalRequested(let e) = event else { return XCTFail("approval.requested 가 아니다") }
        XCTAssertEqual(e.approval.kind, .userInput)
        XCTAssertEqual(e.approval.inputFields.map(\.type), [.text, .secret, .choice])
        XCTAssertEqual(e.approval.inputFields[2].choices, ["merge", "rebase", "squash"])
        XCTAssertNil(e.approval.inputFields[0].choices)
    }

    func testApprovalItemCarriesResolution() throws {
        let detail = try decodeFixture(SessionDetailResponse.self, "rest/session-detail.json")
        let approvalItems = detail.items.compactMap { item -> ApprovalPayload? in
            if case .approval(let p) = item.payload { return p }
            return nil
        }
        XCTAssertEqual(approvalItems.count, 1)
        let resolution = try XCTUnwrap(approvalItems.first?.resolution)
        XCTAssertEqual(resolution.optionId, "allow_session")
        XCTAssertEqual(resolution.by, .client)

        // 아직 처리되지 않은 approval 아이템은 resolution 이 없다
        let started = try decodeFixture(ServerEvent.self, "ws/item.started.approval.json")
        guard case .itemStarted(let e) = started, case .approval(let p) = e.item.payload else {
            return XCTFail("item.started approval 이 아니다")
        }
        XCTAssertNil(p.resolution)
        XCTAssertEqual(p.approval.kind, .command)
    }

    func testSessionSnapshotHasItemsAndPendingApprovals() throws {
        let event = try decodeFixture(ServerEvent.self, "ws/session.snapshot.json")
        guard case .sessionSnapshot(let e) = event else { return XCTFail("session.snapshot 이 아니다") }
        XCTAssertFalse(e.items.isEmpty)
        XCTAssertEqual(e.items.map(\.kind), [.toolCall, .approval])
        XCTAssertEqual(e.pendingApprovals.count, 1)
        XCTAssertEqual(e.session.status, .waitingApproval)
        XCTAssertEqual(e.session.pendingApprovals, 1)
        XCTAssertNil(e.session.preview)
        XCTAssertEqual(e.replayFrom, 36)
        XCTAssertFalse(e.truncated)
    }

    func testSessionDetailItemsAreDiverseAndOrdered() throws {
        let detail = try decodeFixture(SessionDetailResponse.self, "rest/session-detail.json")
        XCTAssertGreaterThanOrEqual(detail.items.count, 5)
        XCTAssertGreaterThanOrEqual(Set(detail.items.map(\.kind)).count, 5)
        let seqs = detail.items.map(\.seq)
        XCTAssertEqual(seqs, seqs.sorted())
        XCTAssertGreaterThanOrEqual(detail.session.lastSeq, seqs.last ?? 0)
        // 턴 밖 system 아이템은 turnId 가 null
        let system = try XCTUnwrap(detail.items.first { $0.kind == .system })
        XCTAssertNil(system.turnId)
        XCTAssertNotNil(detail.items.first { $0.kind == .userMessage }?.turnId)
    }

    func testFsListMixesNilAndValueGitStatus() throws {
        let list = try decodeFixture(FsListResponse.self, "rest/fs-list.json")
        XCTAssertEqual(list.parent, "/Users/alice/work")
        let statuses = list.entries.map(\.gitStatus)
        XCTAssertTrue(statuses.contains(nil))
        XCTAssertTrue(statuses.contains(.modified))
        XCTAssertTrue(statuses.contains(.added))
        XCTAssertTrue(statuses.contains(.untracked))
        XCTAssertTrue(statuses.contains(.ignored))
        let types = Set(list.entries.map(\.type))
        XCTAssertTrue(types.isSuperset(of: [.dir, .file, .symlink, .other]))
        XCTAssertTrue(list.entries.map(\.size).contains(nil))
        XCTAssertTrue(list.entries.map(\.size).contains(1240))
    }

    func testDatesAreParsed() throws {
        let session = try decodeFixture(Session.self, "rest/session.json")
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: session.createdAt)
        XCTAssertEqual(parts.year, 2026)
        XCTAssertEqual(parts.month, 9)
        XCTAssertEqual(parts.day, 9)
        XCTAssertEqual(parts.hour, 10)
        XCTAssertEqual(parts.minute, 0)
        XCTAssertEqual(parts.second, 0)
        XCTAssertEqual(session.updatedAt.timeIntervalSince(session.createdAt), 12 * 60)

        let projects = try decodeFixture(ProjectsResponse.self, "rest/projects.json")
        XCTAssertNotNil(projects.projects[0].lastSessionAt)
        XCTAssertNil(projects.projects[1].lastSessionAt)
    }

    func testMeAndErrorResponses() throws {
        let me = try decodeFixture(MeResponse.self, "rest/me.json")
        XCTAssertEqual(me.agents.map(\.kind), [.claude, .codex])
        XCTAssertEqual(me.agents[0].account, "alice@example.com")
        XCTAssertNil(me.agents[1].account)
        XCTAssertEqual(me.server.protocolVersion, 1)

        let error = try decodeFixture(ErrorResponse.self, "rest/error.json")
        XCTAssertEqual(error.error.code, .notFound)
        XCTAssertFalse(error.error.message.isEmpty)
    }

    func testTurnCompletedAndTurnSummaryUsage() throws {
        let event = try decodeFixture(ServerEvent.self, "ws/turn.completed.json")
        guard case .turnCompleted(let e) = event else { return XCTFail("turn.completed 가 아니다") }
        XCTAssertEqual(e.usage.cacheReadTokens, 16000)
        XCTAssertEqual(e.costUsd, 0.12)
        XCTAssertEqual(e.stopReason, "end_turn")

        let summary = try decodeFixture(ServerEvent.self, "ws/item.started.turn_summary.json")
        guard case .itemStarted(let s) = summary, case .turnSummary(let p) = s.item.payload else {
            return XCTFail("turn_summary 가 아니다")
        }
        XCTAssertEqual(p.durationMs, 30412)
        XCTAssertEqual(p.usage.inputTokens, 18420)
    }

    // MARK: - 2026-09-13 추가분 (git init)

    func testGitInitFixtures() throws {
        let initialized = try decodeFixture(GitInitResponse.self, "rest/git-init.json")
        XCTAssertTrue(initialized.initialized)
        XCTAssertEqual(initialized.branch, "main")
        XCTAssertEqual(initialized.commit, "9f1c2b3a4d5e6f708192a3b4c5d6e7f8091a2b3c")
        XCTAssertEqual(initialized.files, 12)
        XCTAssertEqual(initialized.bytes, 48213)
        XCTAssertTrue(initialized.createdGitignore)

        let dryRun = try decodeFixture(GitInitResponse.self, "rest/git-init-dry-run.json")
        XCTAssertFalse(dryRun.initialized)
        XCTAssertNil(dryRun.commit, "dryRun 은 commit null")
        XCTAssertEqual(dryRun.files, initialized.files, "files/bytes 는 dryRun 과 실제가 같다")
        XCTAssertEqual(dryRun.bytes, initialized.bytes)

        // 요청 본문: dryRun nil 이면 키 생략
        let plain = try JSONSerialization.jsonObject(with: JSONCoding.encoder.encode(GitInitRequest(cwd: "~/work/x"))) as? NSDictionary
        XCTAssertEqual(plain, ["cwd": "~/work/x"] as NSDictionary)
        let dry = try JSONSerialization.jsonObject(with: JSONCoding.encoder.encode(GitInitRequest(cwd: "~/work/x", dryRun: true))) as? NSDictionary
        XCTAssertEqual(dry, ["cwd": "~/work/x", "dryRun": true] as NSDictionary)
    }

    // MARK: - 2026-09-10 추가분 (사용량·모델·mkdir)

    func testSessionCarriesEffortAndUsage() throws {
        let session = try decodeFixture(Session.self, "rest/session.json")
        XCTAssertEqual(session.effort, "high")
        let usage = try XCTUnwrap(session.usage)
        XCTAssertEqual(usage.inputTokens, 12000)
        XCTAssertEqual(usage.outputTokens, 3400)
        XCTAssertEqual(usage.cacheReadTokens, 90000)
        XCTAssertEqual(usage.cacheWriteTokens, 5000)
        XCTAssertEqual(usage.costUsd, 0.42)
        XCTAssertEqual(usage.turns, 3)
        let context = try XCTUnwrap(usage.context)
        XCTAssertEqual(context.tokens, 42000)
        XCTAssertEqual(context.window, 200000)
        XCTAssertEqual(context.percent, 21)
        XCTAssertEqual(usage.updatedAt, session.updatedAt)

        // session-detail 과 snapshot 의 Session 도 같은 모양
        let detail = try decodeFixture(SessionDetailResponse.self, "rest/session-detail.json")
        XCTAssertNotNil(detail.session.effort)
        XCTAssertGreaterThan(try XCTUnwrap(detail.session.usage?.turns), 0)
        guard case .sessionSnapshot(let e) = try decodeFixture(ServerEvent.self, "ws/session.snapshot.json") else {
            return XCTFail("session.snapshot 이 아니다")
        }
        XCTAssertNotNil(e.session.effort)
        XCTAssertGreaterThan(try XCTUnwrap(e.session.usage?.context?.window), 0)
    }

    func testSessionsSecondEntryHasNilUsageAndEffort() throws {
        let list = try decodeFixture(SessionsResponse.self, "rest/sessions.json")
        XCTAssertGreaterThanOrEqual(list.sessions.count, 2)
        XCTAssertNotNil(list.sessions[0].usage)
        XCTAssertNotNil(list.sessions[0].effort)
        XCTAssertNil(list.sessions[1].usage)
        XCTAssertNil(list.sessions[1].effort)
    }

    func testSessionUsageEventDecodes() throws {
        let event = try decodeFixture(ServerEvent.self, "ws/session.usage.json")
        guard case .sessionUsage(let e) = event else { return XCTFail("session.usage 가 아니다") }
        XCTAssertEqual(event.type, .sessionUsage)
        XCTAssertEqual(e.seq, 44)
        XCTAssertEqual(e.sessionId, "ses_01J8ZQ4K5N7P9R3S6T8V0W2XAB")
        XCTAssertEqual(e.usage.turns, 3)
        XCTAssertEqual(e.usage.context?.percent, 21)
        XCTAssertEqual(e.usage.costUsd, 0.42)
        // Session.usage 와 같은 객체
        let session = try decodeFixture(Session.self, "rest/session.json")
        XCTAssertEqual(e.usage.inputTokens, session.usage?.inputTokens)
        XCTAssertEqual(e.usage.context, session.usage?.context)
    }

    func testUsageResponse() throws {
        let usage = try decodeFixture(UsageResponse.self, "rest/usage.json")
        XCTAssertEqual(usage.agents.map(\.kind), [.claude, .codex])
        let claude = try XCTUnwrap(usage.agents.first { $0.kind == .claude })
        XCTAssertEqual(claude.plan, "max")
        XCTAssertFalse(claude.live)
        XCTAssertNotNil(claude.observedAt)
        XCTAssertEqual(claude.limits.map(\.id), ["five_hour", "seven_day"])
        XCTAssertEqual(claude.limits.map(\.status), [.ok, .warning])
        XCTAssertEqual(claude.limits[0].usedPercent, 42)
        XCTAssertEqual(claude.limits[0].windowMinutes, 300)
        XCTAssertNotNil(claude.limits[0].resetsAt)
        XCTAssertEqual(claude.limits[0].label, "5시간")
        let codex = try XCTUnwrap(usage.agents.first { $0.kind == .codex })
        XCTAssertTrue(codex.live)
        XCTAssertEqual(codex.limits.map(\.id), ["primary", "secondary"])

        let empty = try decodeFixture(UsageResponse.self, "rest/usage-empty.json")
        XCTAssertEqual(empty.agents.count, 2)
        for agent in empty.agents {
            XCTAssertNil(agent.plan)
            XCTAssertNil(agent.observedAt)
            XCTAssertTrue(agent.limits.isEmpty)
        }
    }

    func testUsageLimitStatusUnknownValueIsLenient() throws {
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: FixtureLoader.data("rest/usage.json")) as? [String: Any])
        var agents = try XCTUnwrap(json["agents"] as? [[String: Any]])
        var limits = try XCTUnwrap(agents[0]["limits"] as? [[String: Any]])
        limits[0]["status"] = "throttled"
        limits[1]["windowMinutes"] = NSNull()
        limits[1]["resetsAt"] = NSNull()
        agents[0]["limits"] = limits
        json["agents"] = agents
        let data = try JSONSerialization.data(withJSONObject: json)
        let usage = try JSONCoding.decoder.decode(UsageResponse.self, from: data)
        XCTAssertEqual(usage.agents[0].limits[0].status, .unknown)
        XCTAssertEqual(usage.agents[0].limits[1].status, .warning)
        XCTAssertNil(usage.agents[0].limits[1].windowMinutes)
        XCTAssertNil(usage.agents[0].limits[1].resetsAt)
        XCTAssertEqual(UsageLimitStatus.allCases.count, 4)
    }

    func testModelsResponses() throws {
        let claude = try decodeFixture(ModelsResponse.self, "rest/models-claude.json")
        XCTAssertEqual(claude.models.map(\.id), ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"])
        XCTAssertEqual(claude.models.filter(\.isDefault).count, 1)
        XCTAssertEqual(claude.models[0].displayName, "Opus 5")
        XCTAssertEqual(claude.models[0].description, "가장 뛰어난 모델")
        XCTAssertEqual(claude.models[0].efforts, ["low", "medium", "high", "xhigh", "max"])
        XCTAssertEqual(claude.models[0].defaultEffort, "high")
        // effort 미지원 모델: efforts [] 와 description/defaultEffort null
        XCTAssertTrue(claude.models[2].efforts.isEmpty)
        XCTAssertNil(claude.models[2].description)
        XCTAssertNil(claude.models[2].defaultEffort)

        let codex = try decodeFixture(ModelsResponse.self, "rest/models-codex.json")
        XCTAssertEqual(codex.models.count, 2)
        XCTAssertEqual(codex.models.filter(\.isDefault).map(\.id), ["gpt-5-codex"])
        for model in codex.models where model.defaultEffort != nil {
            XCTAssertTrue(model.efforts.contains(try XCTUnwrap(model.defaultEffort)), model.id)
        }
    }

    func testFsMkdirResponse() throws {
        let response = try decodeFixture(FsMkdirResponse.self, "rest/fs-mkdir.json")
        XCTAssertEqual(response.entry.type, .dir)
        XCTAssertEqual(response.entry.name, "new-app")
        XCTAssertEqual(response.entry.path, "/Users/alice/work/new-app")
        XCTAssertNil(response.entry.size)
        XCTAssertNil(response.entry.gitStatus)
    }

    func testTimelineItemRoundTrip() throws {
        let detail = try decodeFixture(SessionDetailResponse.self, "rest/session-detail.json")
        for item in detail.items {
            let encoded = try JSONCoding.encoder.encode(item)
            let decoded = try JSONCoding.decoder.decode(TimelineItem.self, from: encoded)
            XCTAssertEqual(decoded, item, item.id)
        }
    }
}
