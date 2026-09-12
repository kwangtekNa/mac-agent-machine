import Foundation
import XCTest
@testable import MacAgent

/// `MemberStatus.status`: 방 이벤트의 팀원 상태가 있으면 그것, 없으면 세션 목록의 status 를 매핑, 세션이 없으면 idle.
final class MemberStatusTests: XCTestCase {
    private var members: [TeamMember] = []
    private var sessions: [Session] = []

    override func setUpWithError() throws {
        try super.setUpWithError()
        let detail = try JSONCoding.decoder.decode(TeamDetailResponse.self, from: FixtureLoader.data("rest/team-detail.json"))
        members = detail.team.members
        sessions = try JSONCoding.decoder.decode(SessionsResponse.self, from: FixtureLoader.data("rest/sessions.json")).sessions
    }

    private func session(id: String, status: SessionStatus) -> Session {
        var s = sessions[0]
        s.id = id
        s.status = status
        return s
    }

    func testRoomStateWinsOverSessions() {
        let member = members[1]
        let sessions = [session(id: member.sessionId!, status: .running)]
        XCTAssertEqual(MemberStatus.status(member: member, roomState: .queued, sessions: sessions), .queued)
        XCTAssertEqual(MemberStatus.status(member: member, roomState: .error, sessions: sessions), .error)
        XCTAssertEqual(MemberStatus.status(member: member, roomState: .idle, sessions: sessions), .idle, "방 상태 idle 도 그대로 쓴다")
    }

    func testSessionStatusIsMappedWhenNoRoomState() {
        let member = members[1]
        let id = member.sessionId!
        XCTAssertEqual(MemberStatus.status(member: member, roomState: nil, sessions: [session(id: id, status: .running)]), .running)
        XCTAssertEqual(MemberStatus.status(member: member, roomState: nil, sessions: [session(id: id, status: .waitingApproval)]), .waitingApproval)
        XCTAssertEqual(MemberStatus.status(member: member, roomState: nil, sessions: [session(id: id, status: .error)]), .error)
        for other in [SessionStatus.starting, .idle, .closed, .unknown] {
            XCTAssertEqual(MemberStatus.status(member: member, roomState: nil, sessions: [session(id: id, status: other)]), .idle, "\(other)")
        }
    }

    func testMatchesOnlyTheMembersSession() {
        let member = members[1]
        let others = [session(id: "ses_other", status: .running), session(id: member.sessionId!, status: .waitingApproval)]
        XCTAssertEqual(MemberStatus.status(member: member, roomState: nil, sessions: others), .waitingApproval)
    }

    func testNoSessionIsIdle() {
        var member = members[0]
        XCTAssertEqual(MemberStatus.status(member: member, roomState: nil, sessions: []), .idle)
        XCTAssertEqual(MemberStatus.status(member: member, roomState: nil, sessions: [session(id: "ses_other", status: .running)]), .idle)
        member.sessionId = nil
        XCTAssertEqual(MemberStatus.status(member: member, roomState: nil, sessions: sessions), .idle, "sessionId 가 null 이면 idle")
    }
}
