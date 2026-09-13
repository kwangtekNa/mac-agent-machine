import Foundation
import XCTest
@testable import MacAgent

/// `TeamRoomsLogic`(순수): 방 행 정렬(`#전체` 먼저, DM 은 팀원 순서)과 상태 점 상태 파생.
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

    func testRowsPutGroupFirstThenDMsInMemberOrder() throws {
        var shuffled = team!
        shuffled.rooms.reverse() // dm 지연, dm 민수, group
        let rows = TeamRoomsLogic.rows(team: shuffled)

        XCTAssertEqual(rows.map(\.identifier), ["rooms.group", "rooms.dm.\(minsu.id)", "rooms.dm.\(jiyeon.id)"])
        XCTAssertEqual(rows.map(\.id), rows.map(\.room.id))
        XCTAssertEqual(rows[0].kind, .group)
        XCTAssertEqual(rows[0].room.kind, .group)
        XCTAssertEqual(rows[1].kind, .dm(minsu))
        XCTAssertEqual(rows[2].kind, .dm(jiyeon))
        XCTAssertEqual(rows[2].room.memberId, jiyeon.id)
    }

    func testRowsSkipDMWithoutKnownMember() {
        var withGhost = team!
        var ghost = withGhost.rooms[1]
        ghost.id = "room_ghost"
        ghost.memberId = "agt_ghost"
        withGhost.rooms.insert(ghost, at: 0)
        XCTAssertEqual(TeamRoomsLogic.rows(team: withGhost).count, 3, "팀원을 모르는 DM 은 그리지 않는다")
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

    func testGroupRowLastMessageLabel() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        var room = team.rooms[0]
        room.lastMessageAt = now.addingTimeInterval(-5 * 60)
        XCTAssertEqual(TeamRoomsLogic.lastMessageLabel(room, now: now), "5분 전")
        room.lastMessageAt = nil
        XCTAssertNil(TeamRoomsLogic.lastMessageLabel(room, now: now))
    }
}
