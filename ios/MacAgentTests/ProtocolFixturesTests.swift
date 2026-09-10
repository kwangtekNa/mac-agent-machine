import Foundation
import XCTest
@testable import MacAgent

/// 계약 테스트: `packages/protocol/fixtures/` 의 40개 JSON 을 Swift Codable 로 전수 디코딩한다.
/// TS 쪽 `packages/protocol/test/fixtures.test.ts` 의 매핑표와 대칭이다.
final class ProtocolFixturesTests: XCTestCase {
    private typealias Decoder = (Data) throws -> Any

    private static func decode<T: Decodable>(_ type: T.Type) -> Decoder {
        { data in try JSONCoding.decoder.decode(T.self, from: data) }
    }

    /// 파일 상대 경로 → 디코더. 폴더의 모든 `.json` 이 여기 있어야 하고, 여기 있는 키는 전부 파일로 있어야 한다.
    private static func table() -> [String: Decoder] {
        var t: [String: Decoder] = [
            // rest/ 13개
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
        ]
        // ws/ 22개: 전부 ServerEvent
        for name in wsExpectations.keys {
            t["ws/\(name).json"] = decode(ServerEvent.self)
        }
        // client/ 5개: 전부 ClientMessage
        for name in clientExpectations.keys {
            t["client/\(name).json"] = decode(ClientMessage.self)
        }
        return t
    }

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

    private func decodeFixture<T: Decodable>(_ type: T.Type, _ path: String) throws -> T {
        try JSONCoding.decoder.decode(T.self, from: FixtureLoader.data(path))
    }

    // MARK: - 매핑표 ↔ 폴더 (누락 방지)

    func testEveryFixtureFileIsInTableAndViceVersa() throws {
        let files = try FixtureLoader.allJSONPaths()
        let keys = Self.table().keys.sorted()
        XCTAssertEqual(files, keys, "fixtures/ 의 파일 목록과 매핑표가 다르다")
        XCTAssertEqual(files.count, 40)
    }

    func testTableCoversEveryEventTypeItemKindAndClientType() {
        let eventTypes = Set(Self.wsExpectations.values.map(\.type))
        XCTAssertEqual(eventTypes, Set(ServerEvent.EventType.allCases))
        let itemKinds = Set(Self.wsExpectations.values.compactMap(\.itemKind))
        XCTAssertEqual(itemKinds, Set(TimelineItemKind.allCases))
        XCTAssertEqual(Set(Self.clientExpectations.values), Set(ClientMessage.MessageType.allCases))
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

    func testTimelineItemRoundTrip() throws {
        let detail = try decodeFixture(SessionDetailResponse.self, "rest/session-detail.json")
        for item in detail.items {
            let encoded = try JSONCoding.encoder.encode(item)
            let decoded = try JSONCoding.decoder.decode(TimelineItem.self, from: encoded)
            XCTAssertEqual(decoded, item, item.id)
        }
    }
}
