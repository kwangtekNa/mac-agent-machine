import Foundation
import XCTest
@testable import MacAgent

/// `TeamRoomsLogic`(순수): 방 행 정렬(`#전체` 먼저, DM 은 팀원 순서, 곁방은 최근 메시지 순)과 상태 점 상태 파생.
final class TeamRoomsViewLogicTests: XCTestCase {
    private var team: Team!
    private var sessions: [Session] = []
    private var minsu: TeamMember!
    private var jiyeon: TeamMember!

    override func setUpWithError() throws {
        try super.setUpWithError()
        team = try JSONCoding.decoder.decode(Team.self, from: FixtureLoader.data("rest/team.json"))
        sessions = try JSONCoding.decoder.decode(SessionsResponse.self, from: FixtureLoader.data("rest/sessions.json")).sessions
        minsu = team.members[0]
        jiyeon = team.members[1]
    }

    private func session(id: String, status: SessionStatus) -> Session {
        var s = sessions[0]
        s.id = id
        s.status = status
        return s
    }

    func testRowsPutGroupFirstThenDMsInMemberOrderThenSideRooms() throws {
        var shuffled = team!
        shuffled.rooms.reverse() // side, dm 지연, dm 민수, group
        let rows = TeamRoomsLogic.rows(team: shuffled)
        let side = try XCTUnwrap(team.rooms.first { $0.kind == .side })

        XCTAssertEqual(
            rows.map(\.identifier),
            ["rooms.group", "rooms.dm.\(minsu.id)", "rooms.dm.\(jiyeon.id)", "rooms.side.\(side.id)"]
        )
        XCTAssertEqual(rows.map(\.id), rows.map(\.room.id))
        XCTAssertEqual(rows[0].kind, .group)
        XCTAssertEqual(rows[0].room.kind, .group)
        XCTAssertEqual(rows[1].kind, .dm(minsu))
        XCTAssertEqual(rows[2].kind, .dm(jiyeon))
        XCTAssertEqual(rows[2].room.memberId, jiyeon.id)
        XCTAssertEqual(rows[3].kind, .side([minsu, jiyeon]))
        XCTAssertEqual(rows[3].room.kind, .side)
    }

    func testRowsSkipDMWithoutKnownMember() {
        var withGhost = team!
        var ghost = withGhost.rooms[1]
        ghost.id = "room_ghost"
        ghost.memberId = "agt_ghost"
        withGhost.rooms.insert(ghost, at: 0)
        XCTAssertEqual(TeamRoomsLogic.rows(team: withGhost).count, 4, "팀원을 모르는 DM 은 그리지 않는다(그룹 1 + DM 2 + 곁방 1)")
    }

    func testStateDerivesFromSessionsThenServerState() {
        XCTAssertEqual(TeamRoomsLogic.state(of: jiyeon, sessions: []), .running, "세션 목록에 없으면 서버 state")
        XCTAssertEqual(TeamRoomsLogic.state(of: minsu, sessions: []), .idle)
        XCTAssertEqual(
            TeamRoomsLogic.state(of: jiyeon, sessions: [session(id: jiyeon.sessionId!, status: .waitingApproval)]),
            .waitingApproval, "세션이 있으면 세션 status 매핑(MemberStatus)"
        )
        XCTAssertEqual(TeamRoomsLogic.state(of: minsu, sessions: [session(id: minsu.sessionId!, status: .error)]), .error)
        XCTAssertEqual(TeamRoomsLogic.state(of: jiyeon, sessions: [session(id: jiyeon.sessionId!, status: .idle)]), .idle)
    }

    // MARK: - 섹션 (group / dm / side, 2026-09-14)

    func testSectionsSplitGroupDMAndSideRooms() throws {
        let sections = TeamRoomsLogic.sections(team: team)

        XCTAssertEqual(sections.map(\.id), ["group", "dm", "side"])
        XCTAssertNil(sections[0].title, "그룹방 섹션은 헤더가 없다")
        XCTAssertEqual(sections[1].title, "DM")
        XCTAssertEqual(sections[2].title, "에이전트 간")
        XCTAssertEqual(sections[0].rows.map(\.identifier), ["rooms.group"])
        XCTAssertEqual(sections[1].rows.map(\.identifier), ["rooms.dm.\(minsu.id)", "rooms.dm.\(jiyeon.id)"])
        let side = try XCTUnwrap(team.rooms.first { $0.kind == .side })
        XCTAssertEqual(sections[2].rows.map(\.identifier), ["rooms.side.\(side.id)"])
        XCTAssertEqual(sections[2].rows[0].kind, .side([minsu, jiyeon]), "참가자 id 순서대로 팀원을 붙인다")
        XCTAssertEqual(sections.flatMap(\.rows), TeamRoomsLogic.rows(team: team))
    }

    func testSideSectionIsHiddenWhenThereIsNoSideRoom() {
        var withoutSide = team!
        withoutSide.rooms.removeAll { $0.kind == .side }
        let sections = TeamRoomsLogic.sections(team: withoutSide)

        XCTAssertEqual(sections.map(\.id), ["group", "dm"], "곁방이 없으면 섹션 자체를 숨긴다")
        XCTAssertFalse(TeamRoomsLogic.rows(team: withoutSide).contains { if case .side = $0.kind { return true } else { return false } })
    }

    func testSideRowsSortByLastMessageThenName() throws {
        var team = self.team!
        let template = try XCTUnwrap(team.rooms.first { $0.kind == .side })
        func side(_ id: String, _ name: String, minutesAgo: Double?) -> Room {
            var room = template
            room.id = id
            room.name = name
            room.lastMessageAt = minutesAgo.map { Date(timeIntervalSince1970: 1_800_000_000 - $0 * 60) }
            return room
        }
        team.rooms.removeAll { $0.kind == .side }
        team.rooms += [
            side("room_never_b", "민수 ↔ 나중", minutesAgo: nil),
            side("room_old", "민수 ↔ 오래", minutesAgo: 90),
            side("room_never_a", "민수 ↔ 가나", minutesAgo: nil),
            side("room_new", "민수 ↔ 최근", minutesAgo: 3),
        ]
        let rows = TeamRoomsLogic.sections(team: team).last?.rows ?? []

        XCTAssertEqual(
            rows.map(\.room.id), ["room_new", "room_old", "room_never_a", "room_never_b"],
            "최근 메시지 순, 메시지가 없으면 이름 순으로 뒤에"
        )
    }

    func testSideRowKeepsOnlyKnownParticipants() throws {
        var team = self.team!
        let index = try XCTUnwrap(team.rooms.firstIndex { $0.kind == .side })
        team.rooms[index].participants = [minsu.id, "agt_ghost"]
        let rows = TeamRoomsLogic.sections(team: team).last?.rows ?? []

        XCTAssertEqual(rows.count, 1, "참가자를 일부 몰라도 방은 보인다(이름은 서버가 만든 room.name)")
        XCTAssertEqual(rows[0].kind, .side([minsu]))
        XCTAssertEqual(rows[0].room.name, "민수 ↔ 지연")
    }

    func testSideRowLastMessageLabelReusesGroupRule() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        var room = team.rooms[3]
        room.lastMessageAt = now.addingTimeInterval(-90 * 60)
        XCTAssertEqual(TeamRoomsLogic.lastMessageLabel(room, now: now), "1시간 전")
    }

    func testGroupRowLastMessageLabel() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        var room = team.rooms[0]
        room.lastMessageAt = now.addingTimeInterval(-5 * 60)
        XCTAssertEqual(TeamRoomsLogic.lastMessageLabel(room, now: now), "5분 전")
        room.lastMessageAt = nil
        XCTAssertNil(TeamRoomsLogic.lastMessageLabel(room, now: now))
    }
}
