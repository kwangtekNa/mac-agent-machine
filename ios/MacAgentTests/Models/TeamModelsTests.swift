import Foundation
import XCTest
@testable import MacAgent

/// 팀·방 모델(PROTOCOL.md 6절) 계약. 판별자(`RoomAuthor.kind`, `RoomEvent.type`, `RoomClientMessage.type`)는 엄격,
/// 그 외 열거형은 lenient(`.unknown`), nullable 필드는 `null` 과 값 양쪽을 받는다.
final class TeamModelsTests: XCTestCase {
    private static let teamId = "team_01J8ZQ4K5N7P9R3S6T8V0W2XT1"
    private static let leadId = "agt_01J8ZQ4K5N7P9R3S6T8V0W2XA1"
    private static let devId = "agt_01J8ZQ4K5N7P9R3S6T8V0W2XA2"
    private static let groupRoomId = "room_01J8ZQ4K5N7P9R3S6T8V0W2XR0"

    /// fixture 를 딕셔너리로 읽어 일부만 바꾼 뒤 다시 직렬화한다.
    private func mutatedFixture(_ path: String, _ mutate: (inout [String: Any]) -> Void) throws -> Data {
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: FixtureLoader.data(path)) as? [String: Any])
        mutate(&json)
        return try JSONSerialization.data(withJSONObject: json)
    }

    private func setNested(_ json: inout [String: Any], _ keyPath: [String], _ value: Any?) {
        guard let first = keyPath.first else { return }
        if keyPath.count == 1 {
            if let value { json[first] = value } else { json.removeValue(forKey: first) }
            return
        }
        var child = json[first] as? [String: Any] ?? [:]
        setNested(&child, Array(keyPath.dropFirst()), value)
        json[first] = child
    }

    private func decodeFixture<T: Decodable>(_ type: T.Type, _ path: String) throws -> T {
        try JSONCoding.decoder.decode(T.self, from: FixtureLoader.data(path))
    }

    private func jsonObject(_ value: some Encodable) throws -> NSDictionary {
        try XCTUnwrap(JSONSerialization.jsonObject(with: JSONCoding.encoder.encode(value)) as? NSDictionary)
    }

    // MARK: - 엄격한 판별자

    func testRoomAuthorUnknownKindThrows() throws {
        let data = try mutatedFixture("room-ws/room.message.user.json") { json in
            self.setNested(&json, ["message", "author", "kind"], "bot")
        }
        XCTAssertThrowsError(try JSONCoding.decoder.decode(RoomEvent.self, from: data)) { error in
            XCTAssertTrue(error is DecodingError, "\(error)")
        }
        // REST 응답 안의 RoomMessage 도 같은 규칙
        let rest = try mutatedFixture("rest/room-message-post.json") { json in
            self.setNested(&json, ["message", "author", "kind"], "bot")
        }
        XCTAssertThrowsError(try JSONCoding.decoder.decode(PostRoomMessageResponse.self, from: rest))
        // agent 인데 memberId 가 없으면 실패
        let missingMember = try mutatedFixture("room-ws/room.message.agent.json") { json in
            self.setNested(&json, ["message", "author", "memberId"], nil)
        }
        XCTAssertThrowsError(try JSONCoding.decoder.decode(RoomEvent.self, from: missingMember))
    }

    func testRoomAuthorDecodesThreeKinds() throws {
        guard case .roomMessage(let user) = try decodeFixture(RoomEvent.self, "room-ws/room.message.user.json"),
              case .roomMessage(let agent) = try decodeFixture(RoomEvent.self, "room-ws/room.message.agent.json"),
              case .roomMessage(let system) = try decodeFixture(RoomEvent.self, "room-ws/room.message.system.json")
        else { return XCTFail("room.message 가 아니다") }
        XCTAssertEqual(user.message.author, .user)
        XCTAssertEqual(agent.message.author, .agent(memberId: Self.leadId))
        XCTAssertEqual(system.message.author, .system)
        XCTAssertEqual([user, agent, system].map(\.message.author.kind), [.user, .agent, .system])
        XCTAssertEqual(agent.message.author.memberId, Self.leadId)
        XCTAssertNil(user.message.author.memberId)
    }

    func testRoomAuthorRoundTrip() throws {
        for author in [RoomAuthor.user, .agent(memberId: Self.devId), .system] {
            let encoded = try JSONCoding.encoder.encode(author)
            XCTAssertEqual(try JSONCoding.decoder.decode(RoomAuthor.self, from: encoded), author)
        }
        XCTAssertEqual(try jsonObject(RoomAuthor.user), ["kind": "user"] as NSDictionary)
        XCTAssertEqual(try jsonObject(RoomAuthor.system), ["kind": "system"] as NSDictionary)
        XCTAssertEqual(
            try jsonObject(RoomAuthor.agent(memberId: "agt_1")),
            ["kind": "agent", "memberId": "agt_1"] as NSDictionary
        )
    }

    func testRoomEventUnknownTypeThrows() throws {
        let data = try mutatedFixture("room-ws/pong.json") { json in
            json["type"] = "room.teleported"
        }
        XCTAssertThrowsError(try JSONCoding.decoder.decode(RoomEvent.self, from: data)) { error in
            XCTAssertTrue(error is DecodingError, "\(error)")
        }
        // 세션 이벤트 type 을 방 스트림에 넣어도 실패한다(별도 enum)
        let sessionType = try mutatedFixture("room-ws/pong.json") { json in
            json["type"] = "session.status"
        }
        XCTAssertThrowsError(try JSONCoding.decoder.decode(RoomEvent.self, from: sessionType))
        // 반대로 세션 ServerEvent 는 room.* 를 모른다
        let roomInSession = try mutatedFixture("ws/pong.json") { json in
            json["type"] = "room.message"
        }
        XCTAssertThrowsError(try JSONCoding.decoder.decode(ServerEvent.self, from: roomInSession))
    }

    func testRoomClientMessageUnknownTypeThrows() throws {
        let data = try mutatedFixture("room-client/ping.json") { json in
            json["type"] = "room.rewind"
        }
        XCTAssertThrowsError(try JSONCoding.decoder.decode(RoomClientMessage.self, from: data)) { error in
            XCTAssertTrue(error is DecodingError, "\(error)")
        }
    }

    // MARK: - lenient 열거형

    func testUnknownEnumValuesDecodeAsUnknown() throws {
        let changes = try mutatedFixture("rest/changes.json") { json in
            var list = json["changes"] as? [[String: Any]] ?? []
            list[0]["status"] = "exploded"
            json["changes"] = list
        }
        XCTAssertEqual(try JSONCoding.decoder.decode(ChangesResponse.self, from: changes).changes[0].status, .unknown)

        let team = try mutatedFixture("rest/team.json") { json in
            var members = json["members"] as? [[String: Any]] ?? []
            members[0]["role"] = "designer"
            members[1]["state"] = "sleeping"
            json["members"] = members
            var rooms = json["rooms"] as? [[String: Any]] ?? []
            rooms[0]["kind"] = "thread"
            json["rooms"] = rooms
        }
        let decoded = try JSONCoding.decoder.decode(Team.self, from: team)
        XCTAssertEqual(decoded.members[0].role, .unknown)
        XCTAssertEqual(decoded.members[1].state, .unknown)
        XCTAssertEqual(decoded.rooms[0].kind, .unknown)

        let message = try mutatedFixture("room-ws/room.message.system.json") { json in
            self.setNested(&json, ["message", "kind"], "sticker")
        }
        guard case .roomMessage(let e) = try JSONCoding.decoder.decode(RoomEvent.self, from: message) else {
            return XCTFail("room.message 가 아니다")
        }
        XCTAssertEqual(e.message.kind, .unknown)

        let status = try mutatedFixture("room-ws/room.status.json") { json in
            var members = json["members"] as? [[String: Any]] ?? []
            members[0]["state"] = "napping"
            json["members"] = members
        }
        guard case .roomStatus(let s) = try JSONCoding.decoder.decode(RoomEvent.self, from: status) else {
            return XCTFail("room.status 가 아니다")
        }
        XCTAssertEqual(s.members[0].state, .unknown)

        XCTAssertEqual(RoleId.allCases.count, 6)
        XCTAssertEqual(TeamMemberState.allCases.count, 6)
        XCTAssertEqual(RoomKind.allCases.count, 4, "group·dm·side·unknown")
        XCTAssertEqual(RoomMessageKind.allCases.count, 5)
        XCTAssertEqual(ChangeSetStatus.allCases.count, 7)
        XCTAssertEqual(RoleId.teamLead.rawValue, "team-lead")
        XCTAssertEqual(RoleId.codeReviewer.rawValue, "code-reviewer")
        XCTAssertEqual(TeamMemberState.waitingApproval.rawValue, "waiting_approval")
    }

    // MARK: - RoomMessage 의 work / approval / changes

    func testRoomSnapshotMessagesCarryNullOrValuePayloads() throws {
        let event = try decodeFixture(RoomEvent.self, "room-ws/room.snapshot.json")
        guard case .roomSnapshot(let s) = event else { return XCTFail("room.snapshot 이 아니다") }
        XCTAssertEqual(event.type, .roomSnapshot)
        XCTAssertEqual(event.seq, 0)
        XCTAssertEqual(event.roomId, Self.groupRoomId)
        XCTAssertEqual(event.teamId, Self.teamId)
        XCTAssertEqual(s.messages.count, 4)
        XCTAssertEqual(s.messages.map(\.kind), [.system, .text, .text, .approval])
        XCTAssertEqual(s.messages.map(\.seq), [1, 2, 3, 4])

        // 시스템 메시지: 전부 null
        let system = s.messages[0]
        XCTAssertEqual(system.author, .system)
        XCTAssertNil(system.work)
        XCTAssertNil(system.approval)
        XCTAssertNil(system.changes)
        XCTAssertNil(system.dispatchId)
        XCTAssertEqual(system.hop, 0)
        XCTAssertTrue(system.mentions.isEmpty)

        // 사용자 메시지: 멘션만
        let user = s.messages[1]
        XCTAssertEqual(user.author, .user)
        XCTAssertEqual(user.mentions, [Self.leadId])
        XCTAssertEqual(user.hop, 0)
        XCTAssertNil(user.dispatchId)
        XCTAssertNil(user.work)

        // 에이전트 답변: work 값
        let reply = s.messages[2]
        XCTAssertEqual(reply.author, .agent(memberId: Self.leadId))
        XCTAssertEqual(reply.hop, 1)
        XCTAssertEqual(reply.dispatchId, "dsp_01J8ZQ4K5N7P9R3S6T8V0W2XH1")
        XCTAssertEqual(reply.mentions, [Self.devId])
        let work = try XCTUnwrap(reply.work)
        XCTAssertEqual(work.sessionId, "ses_01J8ZQ4K5N7P9R3S6T8V0W2XS1")
        XCTAssertEqual(work.turnId, "trn_01J8ZQ4K5N7P9R3S6T8V0W2XC2")
        XCTAssertEqual(work.toolCalls, 2)
        XCTAssertTrue(work.filesChanged.isEmpty)
        XCTAssertEqual(work.durationMs, 8200)
        XCTAssertEqual(work.usage.inputTokens, 5200)
        XCTAssertEqual(work.usage.outputTokens, 310)
        XCTAssertEqual(work.usage.cacheReadTokens, 12000)
        XCTAssertNil(work.usage.cacheWriteTokens)
        XCTAssertEqual(work.costUsd, 0.04)
        XCTAssertNil(reply.approval)
        XCTAssertNil(reply.changes)

        // 승인 카드: approval 값, resolution null
        let card = s.messages[3]
        XCTAssertEqual(card.hop, 2)
        XCTAssertNil(card.work)
        XCTAssertNil(card.changes)
        let approval = try XCTUnwrap(card.approval)
        XCTAssertEqual(approval.memberId, Self.devId)
        XCTAssertEqual(approval.sessionId, "ses_01J8ZQ4K5N7P9R3S6T8V0W2XS2")
        XCTAssertEqual(approval.approval.approvalId, "apr_01J8ZQ4K5N7P9R3S6T8V0W2XE5")
        XCTAssertEqual(approval.approval.kind, .command)
        XCTAssertEqual(approval.approval.options.map(\.id), ["allow", "allow_session", "deny"])
        XCTAssertNil(approval.resolution)

        // 스냅샷 나머지
        XCTAssertEqual(s.room.id, Self.groupRoomId)
        XCTAssertEqual(s.room.kind, .group)
        XCTAssertEqual(s.pendingApprovals.count, 1)
        XCTAssertEqual(s.pendingApprovals[0].approval.approvalId, approval.approval.approvalId)
        XCTAssertEqual(s.dispatch.running.map(\.memberId), [Self.devId])
        XCTAssertEqual(s.dispatch.running[0].hop, 2)
        XCTAssertTrue(s.dispatch.queued.isEmpty)
        XCTAssertEqual(s.members.map(\.state), [.idle, .waitingApproval])
        XCTAssertEqual(s.members.map(\.memberId), [Self.leadId, Self.devId])
        XCTAssertEqual(s.replayFrom, 0)
        XCTAssertFalse(s.truncated)
    }

    func testRoomMessageChangesCardAndUpdatedResolution() throws {
        let changesEvent = try decodeFixture(RoomEvent.self, "room-ws/room.message.changes.json")
        guard case .roomMessage(let c) = changesEvent else { return XCTFail("room.message 가 아니다") }
        XCTAssertEqual(c.message.kind, .changes)
        XCTAssertNil(c.message.work)
        XCTAssertNil(c.message.approval)
        let changes = try XCTUnwrap(c.message.changes)
        XCTAssertEqual(changes.id, "chg_01J8ZQ4K5N7P9R3S6T8V0W2XG1")
        XCTAssertEqual(changes.status, .ready)
        XCTAssertEqual(changes.files.map(\.path), ["src/login.ts", "src/login.test.ts"])
        XCTAssertEqual(changes.files.map(\.kind), [.modify, .modify])
        XCTAssertEqual(changes.files[1].additions, 12)
        XCTAssertEqual(changes.commits, 1)
        XCTAssertTrue(changes.conflictFiles.isEmpty)
        XCTAssertEqual(changes.messageId, c.message.id)
        XCTAssertEqual(changes.branch, "mam/backend/jiyeon")
        XCTAssertEqual(changes.baseBranch, "main")
        XCTAssertEqual(changes.commit.count, 40)

        let updatedEvent = try decodeFixture(RoomEvent.self, "room-ws/room.message.updated.json")
        guard case .roomMessageUpdated(let u) = updatedEvent else { return XCTFail("room.message.updated 가 아니다") }
        XCTAssertEqual(updatedEvent.type, .roomMessageUpdated)
        // 이벤트는 새 seq, message.seq 는 원래 값
        XCTAssertEqual(updatedEvent.seq, 5)
        XCTAssertEqual(u.message.seq, 4)
        XCTAssertEqual(u.message.id, "msg_01J8ZQ4K5N7P9R3S6T8V0W2XM4")
        let resolution = try XCTUnwrap(u.message.approval?.resolution)
        XCTAssertEqual(resolution.optionId, "allow_session")
        XCTAssertEqual(resolution.by, .client)
    }

    func testWorkSummaryCostUsdMayBeAbsent() throws {
        let room = try decodeFixture(RoomDetailResponse.self, "rest/room.json")
        XCTAssertEqual(room.messages.count, 7)
        XCTAssertFalse(room.truncated)
        XCTAssertEqual(room.messages[2].work?.costUsd, 0.04)
        let codexWork = try XCTUnwrap(room.messages[4].work)
        XCTAssertNil(codexWork.costUsd, "Codex 는 costUsd 키를 생략한다")
        XCTAssertEqual(codexWork.filesChanged, ["src/login.ts", "src/login.test.ts"])
        XCTAssertEqual(codexWork.toolCalls, 5)
        // 메시지 seq 는 방 이벤트 seq 라 건너뛸 수 있다(5 는 room.message.updated 가 소비)
        XCTAssertEqual(room.messages.map(\.seq), [1, 2, 3, 4, 6, 7, 8])
    }

    func testNullableFieldsAcceptNull() throws {
        let teamData = try mutatedFixture("rest/team.json") { json in
            var members = json["members"] as? [[String: Any]] ?? []
            members[0]["sessionId"] = NSNull()
            members[0]["model"] = NSNull()
            members[0]["effort"] = NSNull()
            json["members"] = members
        }
        let team = try JSONCoding.decoder.decode(Team.self, from: teamData)
        XCTAssertNil(team.members[0].sessionId)
        XCTAssertNil(team.members[0].model)
        XCTAssertNil(team.members[0].effort)
        XCTAssertEqual(team.members[1].sessionId, "ses_01J8ZQ4K5N7P9R3S6T8V0W2XS2")

        let statusData = try mutatedFixture("room-ws/room.status.json") { json in
            var dispatch = json["dispatch"] as? [String: Any] ?? [:]
            var running = dispatch["running"] as? [[String: Any]] ?? []
            running[0]["turnId"] = NSNull()
            dispatch["running"] = running
            json["dispatch"] = dispatch
            var members = json["members"] as? [[String: Any]] ?? []
            members[0]["sessionId"] = NSNull()
            json["members"] = members
        }
        guard case .roomStatus(let s) = try JSONCoding.decoder.decode(RoomEvent.self, from: statusData) else {
            return XCTFail("room.status 가 아니다")
        }
        XCTAssertNil(s.dispatch.running[0].turnId)
        XCTAssertNil(s.members[0].sessionId)
        XCTAssertEqual(s.dispatch.queued.count, 1)
        XCTAssertEqual(s.dispatch.queued[0].dispatchId, "dsp_01J8ZQ4K5N7P9R3S6T8V0W2XH4")

        let mergeData = try mutatedFixture("rest/merge-result.json") { json in
            json["mergeCommit"] = NSNull()
            self.setNested(&json, ["change", "status"], "conflict")
            self.setNested(&json, ["change", "conflictFiles"], ["src/login.ts"])
        }
        let merge = try JSONCoding.decoder.decode(MergeResult.self, from: mergeData)
        XCTAssertNil(merge.mergeCommit)
        XCTAssertEqual(merge.change.status, .conflict)
        XCTAssertEqual(merge.change.conflictFiles, ["src/login.ts"])
    }

    func testRoomErrorAndPongEvents() throws {
        let error = try decodeFixture(RoomEvent.self, "room-ws/room.error.json")
        guard case .roomError(let e) = error else { return XCTFail("room.error 가 아니다") }
        XCTAssertEqual(error.type, .roomError)
        XCTAssertEqual(error.seq, 10)
        XCTAssertTrue(e.recoverable)
        XCTAssertTrue(e.message.contains("@철수"))

        let pong = try decodeFixture(RoomEvent.self, "room-ws/pong.json")
        guard case .pong = pong else { return XCTFail("pong 이 아니다") }
        XCTAssertEqual(pong.seq, 0)
        XCTAssertEqual(pong.roomId, Self.groupRoomId)
        XCTAssertEqual(pong.teamId, Self.teamId)
    }

    // MARK: - Session.team

    func testSessionDecodesWithAndWithoutTeam() throws {
        let plain = try decodeFixture(Session.self, "rest/session.json")
        XCTAssertNil(plain.team, "일반 세션은 team 키 자체가 없다")

        let data = try mutatedFixture("rest/session.json") { json in
            json["team"] = ["teamId": Self.teamId, "memberId": Self.leadId]
        }
        let member = try JSONCoding.decoder.decode(Session.self, from: data)
        XCTAssertEqual(member.team, SessionTeamRef(teamId: Self.teamId, memberId: Self.leadId))
        XCTAssertEqual(member.team?.teamId, Self.teamId)
        XCTAssertEqual(member.team?.memberId, Self.leadId)

        // 멤버와이즈 init 의 기본값은 nil
        let constructed = Session(
            id: "ses_1", agent: .claude, cwd: "/Users/alice/work/app", title: "t", mode: .ask, model: nil,
            status: .idle, nativeId: nil, createdAt: .now, updatedAt: .now, lastSeq: 0, pendingApprovals: 0, preview: nil
        )
        XCTAssertNil(constructed.team)
        // 인코딩도 nil 이면 키를 생략한다
        let encoded = try jsonObject(constructed)
        XCTAssertNil(encoded["team"])
        let encodedMember = try jsonObject(member)
        XCTAssertEqual(encodedMember["team"] as? NSDictionary, ["teamId": Self.teamId, "memberId": Self.leadId] as NSDictionary)
    }

    // MARK: - Team

    func testTeamHasGroupRoomAndDMPerMember() throws {
        let team = try decodeFixture(Team.self, "rest/team.json")
        XCTAssertEqual(team.id, Self.teamId)
        // 마지막은 곁방(`kind: "side"`, 2026-09-14 추가. PROTOCOL.md 6.6).
        XCTAssertEqual(team.rooms.map(\.kind), [.group, .dm, .dm, .side])
        let group = team.rooms[0]
        XCTAssertNil(group.memberId)
        XCTAssertEqual(group.name, "전체")
        XCTAssertEqual(group.lastSeq, 9)
        XCTAssertNotNil(group.lastMessageAt)
        let dms = team.rooms.filter { $0.kind == .dm }
        XCTAssertEqual(dms.map(\.memberId), team.members.map(\.id))
        XCTAssertEqual(dms.map(\.name), team.members.map(\.name))
        XCTAssertNil(team.rooms[1].lastMessageAt)
        XCTAssertEqual(team.rooms[1].lastSeq, 0)
        XCTAssertNotNil(team.rooms[2].lastMessageAt)
        XCTAssertTrue(team.rooms.allSatisfy { $0.teamId == team.id })

        // 곁방: 참가자 집합이 신원이고(정렬된 팀원 id 2개 이상) `memberId` 는 null, 이름은 `↔` 로 이은 참가자 이름.
        let side = team.rooms[3]
        XCTAssertEqual(side.participants, team.members.map(\.id))
        XCTAssertNil(side.memberId)
        XCTAssertEqual(side.name, "민수 ↔ 지연")
        // 그 외 방은 키 자체가 없다.
        XCTAssertNil(group.participants)
        XCTAssertNil(team.rooms[1].participants)
    }

    func testTeamMembersAndSettings() throws {
        let team = try decodeFixture(Team.self, "rest/team.json")
        XCTAssertEqual(team.name, "backend")
        XCTAssertEqual(team.cwd, "/Users/alice/work/app")
        XCTAssertEqual(team.baseBranch, "main")
        XCTAssertEqual(
            team.settings,
            TeamSettings(maxHops: 6, maxConcurrent: 2, contextMaxMessages: 40, sideRoomMaxParticipants: 3)
        )
        XCTAssertEqual(team.members.count, 2)
        XCTAssertEqual(team.members.map(\.id), [Self.leadId, Self.devId])
        XCTAssertEqual(team.members.map(\.name), ["민수", "지연"])
        XCTAssertEqual(team.members.map(\.handle), ["minsu", "jiyeon"])
        XCTAssertEqual(team.members.map(\.role), [.teamLead, .developer])
        XCTAssertEqual(team.members.map(\.roleLabel), ["팀장", "개발자"])
        XCTAssertEqual(team.members.map(\.agent), [.claude, .codex])
        XCTAssertEqual(team.members.map(\.mode), [.autoEdit, .autoEdit])
        XCTAssertEqual(team.members.map(\.model), ["claude-opus-5", "gpt-5-codex"])
        XCTAssertEqual(team.members.map(\.effort), ["high", "medium"])
        XCTAssertEqual(team.members.map(\.state), [.idle, .running])
        XCTAssertEqual(team.members.map(\.isLead), [true, false])
        XCTAssertEqual(team.members.filter(\.isLead).count, 1)
        XCTAssertEqual(team.members[0].branch, "mam/backend/minsu")
        XCTAssertTrue(team.members[0].worktreePath.hasSuffix("/worktrees/\(Self.leadId)"))
        XCTAssertEqual(team.members[0].sessionId, "ses_01J8ZQ4K5N7P9R3S6T8V0W2XS1")
        XCTAssertFalse(team.members[0].prompt.isEmpty)
        XCTAssertEqual(team.members[0].emoji, "🧑‍💼")
    }

    func testTeamDetailTeamsRolesTemplatesAndMergeResult() throws {
        let detail = try decodeFixture(TeamDetailResponse.self, "rest/team-detail.json")
        XCTAssertEqual(detail.team.id, Self.teamId)
        XCTAssertEqual(detail.dispatch.running.count, 1)
        XCTAssertEqual(detail.dispatch.running[0].turnId, "trn_01J8ZQ4K5N7P9R3S6T8V0W2XC4")
        XCTAssertEqual(detail.dispatch.running[0].roomId, "room_01J8ZQ4K5N7P9R3S6T8V0W2XR2")
        XCTAssertEqual(detail.dispatch.queued.count, 1)
        XCTAssertEqual(detail.dispatch.queued[0].roomId, Self.groupRoomId)
        XCTAssertEqual(detail.changes.count, 1)
        XCTAssertEqual(detail.changes[0].status, .ready)

        let teams = try decodeFixture(TeamsResponse.self, "rest/teams.json")
        XCTAssertEqual(teams.teams.map(\.id), [Self.teamId])
        XCTAssertEqual(teams.teams[0], try decodeFixture(Team.self, "rest/team.json"))

        let roles = try decodeFixture(TeamRolesResponse.self, "rest/team-roles.json")
        XCTAssertEqual(roles.roles.map(\.id), [.developer, .planner, .teamLead, .codeReviewer, .custom])
        XCTAssertEqual(roles.roles.map(\.label), ["개발자", "기획자", "팀장", "코드 리뷰어", "커스텀"])
        XCTAssertEqual(try XCTUnwrap(roles.roles.last).prompt, "")
        XCTAssertTrue(roles.roles.dropLast().allSatisfy { !$0.prompt.isEmpty })

        let templates = try decodeFixture(TeamTemplatesResponse.self, "rest/team-templates.json")
        XCTAssertEqual(templates.templates.count, 1)
        let template = try decodeFixture(TeamTemplate.self, "rest/team-template.json")
        XCTAssertEqual(templates.templates[0], template)
        XCTAssertEqual(template.id, "tpl_01J8ZQ4K5N7P9R3S6T8V0W2XP1")
        XCTAssertEqual(template.name, "백엔드 2인")
        XCTAssertEqual(template.members.count, 2)
        XCTAssertEqual(template.members.map(\.isLead), [true, false])
        XCTAssertEqual(template.members.map(\.role), [.teamLead, .developer])
        XCTAssertEqual(template.members[0].model, "claude-opus-5")
        XCTAssertEqual(template.settings.maxHops, 6)

        let merge = try decodeFixture(MergeResult.self, "rest/merge-result.json")
        XCTAssertEqual(merge.change.status, .merged)
        XCTAssertEqual(merge.mergeCommit, "0123456789abcdef0123456789abcdef01234567")

        let posted = try decodeFixture(PostRoomMessageResponse.self, "rest/room-message-post.json")
        XCTAssertEqual(posted.dispatches, ["dsp_01J8ZQ4K5N7P9R3S6T8V0W2XH4"])
        XCTAssertEqual(posted.message.author, .user)
        XCTAssertEqual(posted.message.mentions, [Self.devId])

        let changes = try decodeFixture(ChangesResponse.self, "rest/changes.json")
        XCTAssertEqual(changes.changes.map(\.id), ["chg_01J8ZQ4K5N7P9R3S6T8V0W2XG1"])
    }

    // MARK: - 요청 인코딩 (nil 은 키 생략)

    func testRequestsOmitNilKeys() throws {
        XCTAssertEqual(
            try jsonObject(MemberInput(name: "지연", role: .developer, agent: .codex)),
            ["name": "지연", "role": "developer", "agent": "codex"] as NSDictionary
        )
        XCTAssertEqual(
            try jsonObject(MemberInput(
                name: "민수", role: .custom, agent: .claude, roleLabel: "아키텍트", emoji: "🏛️", prompt: "p",
                mode: .plan, model: "claude-opus-5", effort: "high", handle: "minsu", isLead: true
            )),
            [
                "name": "민수", "role": "custom", "agent": "claude", "roleLabel": "아키텍트", "emoji": "🏛️", "prompt": "p",
                "mode": "plan", "model": "claude-opus-5", "effort": "high", "handle": "minsu", "isLead": true,
            ] as NSDictionary
        )

        let minimal = CreateTeamRequest(
            cwd: "/Users/alice/work/app", name: "backend",
            members: [MemberInput(name: "민수", role: .teamLead, agent: .claude)]
        )
        XCTAssertEqual(
            try jsonObject(minimal),
            [
                "cwd": "/Users/alice/work/app", "name": "backend",
                "members": [["name": "민수", "role": "team-lead", "agent": "claude"]],
            ] as NSDictionary
        )
        let full = CreateTeamRequest(
            cwd: "~/work/app", name: "backend", members: [],
            settings: TeamSettings(maxHops: 3, maxConcurrent: 1, contextMaxMessages: 20, sideRoomMaxParticipants: 3),
            templateId: "tpl_01J8ZQ4K5N7P9R3S6T8V0W2XP1"
        )
        XCTAssertEqual(
            try jsonObject(full),
            [
                "cwd": "~/work/app", "name": "backend", "members": [],
                "settings": ["maxHops": 3, "maxConcurrent": 1, "contextMaxMessages": 20, "sideRoomMaxParticipants": 3],
                "templateId": "tpl_01J8ZQ4K5N7P9R3S6T8V0W2XP1",
            ] as NSDictionary
        )

        XCTAssertEqual(try jsonObject(PatchTeamRequest(name: "새 이름")), ["name": "새 이름"] as NSDictionary)
        XCTAssertEqual(
            try jsonObject(PatchTeamRequest(
                settings: TeamSettings(maxHops: 2, maxConcurrent: 2, contextMaxMessages: 10, sideRoomMaxParticipants: 4)
            )),
            ["settings": ["maxHops": 2, "maxConcurrent": 2, "contextMaxMessages": 10, "sideRoomMaxParticipants": 4]] as NSDictionary
        )
        XCTAssertEqual(try jsonObject(PatchMemberRequest()), [:] as NSDictionary)
        XCTAssertEqual(try jsonObject(PatchMemberRequest(emoji: "🦊")), ["emoji": "🦊"] as NSDictionary)
        XCTAssertEqual(
            try jsonObject(PatchMemberRequest(name: "지연2", prompt: "p", mode: .ask, model: "gpt-5", effort: "low")),
            ["name": "지연2", "prompt": "p", "mode": "ask", "model": "gpt-5", "effort": "low"] as NSDictionary
        )
        XCTAssertEqual(try jsonObject(PostRoomMessageRequest(text: "@민수 안녕")), ["text": "@민수 안녕"] as NSDictionary)
        XCTAssertEqual(
            try jsonObject(PostRoomMessageRequest(text: "봐줘", attachments: [Attachment(mediaType: "image/png", base64: "AAAA")])),
            ["text": "봐줘", "attachments": [["kind": "image", "mediaType": "image/png", "base64": "AAAA"]]] as NSDictionary
        )
        XCTAssertEqual(try jsonObject(PatchTeamTemplateRequest(name: "이름")), ["name": "이름"] as NSDictionary)
    }

    func testTeamTemplateMemberEncodesNullModelAndEffort() throws {
        // TS `TeamTemplateMemberSchema` 는 model/effort 가 nullable **필수** 키라 nil 이어도 키를 생략하지 않고 null 을 보낸다.
        let member = TeamTemplateMember(
            name: "민수", handle: "minsu", role: .teamLead, roleLabel: "팀장", emoji: "🧑‍💼", agent: .claude,
            prompt: "p", mode: .autoEdit, model: nil, effort: nil, isLead: true
        )
        let dict = try jsonObject(member)
        XCTAssertEqual(dict["model"] as? NSNull, NSNull())
        XCTAssertEqual(dict["effort"] as? NSNull, NSNull())
        XCTAssertEqual(dict["role"] as? String, "team-lead")
        XCTAssertEqual(dict["isLead"] as? Bool, true)
        XCTAssertEqual(try JSONCoding.decoder.decode(TeamTemplateMember.self, from: JSONCoding.encoder.encode(member)), member)

        let request = CreateTeamTemplateRequest(name: "1인", members: [member])
        let requestDict = try jsonObject(request)
        XCTAssertNil(requestDict["settings"])
        let members = try XCTUnwrap(requestDict["members"] as? [NSDictionary])
        XCTAssertEqual(members.count, 1)
        XCTAssertEqual(members[0]["model"] as? NSNull, NSNull())

        // 서버 응답 템플릿을 그대로 되돌려도 같은 값
        let template = try decodeFixture(TeamTemplate.self, "rest/team-template.json")
        let reencoded = try JSONCoding.decoder.decode(TeamTemplate.self, from: JSONCoding.encoder.encode(template))
        XCTAssertEqual(reencoded, template)
    }

    func testRoomClientMessageEncoding() throws {
        XCTAssertEqual(try jsonObject(RoomClientMessage.ping), ["type": "ping"] as NSDictionary)
        XCTAssertEqual(try jsonObject(RoomClientMessage.interrupt(memberId: nil)), ["type": "room.interrupt"] as NSDictionary)
        XCTAssertEqual(
            try jsonObject(RoomClientMessage.interrupt(memberId: Self.devId)),
            ["type": "room.interrupt", "memberId": Self.devId] as NSDictionary
        )
        XCTAssertEqual(
            try jsonObject(RoomClientMessage.send(text: "hi", attachments: nil)),
            ["type": "room.send", "text": "hi"] as NSDictionary
        )
        XCTAssertEqual(
            try jsonObject(RoomClientMessage.send(text: "hi", attachments: [Attachment(mediaType: "image/png", base64: "AA==")])),
            ["type": "room.send", "text": "hi", "attachments": [["kind": "image", "mediaType": "image/png", "base64": "AA=="]]] as NSDictionary
        )
        XCTAssertEqual(RoomClientMessage.send(text: "x", attachments: nil).type, .send)
        XCTAssertEqual(RoomClientMessage.interrupt(memberId: nil).type, .interrupt)
        XCTAssertEqual(RoomClientMessage.ping.type, .ping)
    }
}
