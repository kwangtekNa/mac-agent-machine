import SwiftUI
import UIKit
import XCTest
@testable import MacAgent

/// `TeamActivity`(팀원 상태 × 세션 조인)와 `TeamRow` 렌더. 텍스트 규칙은 순수 함수로, 뷰는 `UIHostingController` 로 그려지는지만 본다.
@MainActor
final class TeamRowRenderTests: XCTestCase {
    private var team: Team!
    private var sessions: [Session] = []

    override func setUp() async throws {
        try await super.setUp()
        team = try JSONCoding.decoder.decode(Team.self, from: FixtureLoader.data("rest/team.json"))
        sessions = try JSONCoding.decoder.decode(SessionsResponse.self, from: FixtureLoader.data("rest/sessions.json")).sessions
    }

    private func session(id: String, status: SessionStatus) -> Session {
        var s = sessions[0]
        s.id = id
        s.status = status
        return s
    }

    func testActivityJoinsSessionsAndFallsBackToMemberState() {
        // fixture: 민수 idle, 지연 running(서버 state). 세션 목록이 비면 member.state 를 쓴다.
        XCTAssertEqual(TeamActivity.of(team: team, sessions: []), TeamActivity(running: 1, waitingApproval: 0))
        XCTAssertEqual(TeamActivity.of(team: team, sessions: []).badge, "실행 1 · 승인 0")

        let joined = [
            session(id: team.members[0].sessionId!, status: .waitingApproval),
            session(id: team.members[1].sessionId!, status: .idle),
        ]
        XCTAssertEqual(TeamActivity.of(team: team, sessions: joined), TeamActivity(running: 0, waitingApproval: 1), "세션이 있으면 세션 status 가 우선")
        XCTAssertEqual(TeamActivity.state(of: team.members[1], sessions: joined), .idle)

        let quiet = [session(id: team.members[1].sessionId!, status: .closed)]
        XCTAssertNil(TeamActivity.of(team: team, sessions: quiet).badge, "둘 다 0 이면 배지 없음")
        XCTAssertEqual(TeamRow.trailingText(team: team, activity: .of(team: team, sessions: quiet)), "팀원 2명")
        XCTAssertEqual(TeamRow.trailingText(team: team, activity: TeamActivity(running: 2, waitingApproval: 1)), "실행 2 · 승인 1")
    }

    func testMemberStateLabels() {
        XCTAssertEqual(TeamMemberState.running.label, "실행 중")
        XCTAssertEqual(TeamMemberState.waitingApproval.label, "승인 대기")
        XCTAssertEqual(TeamMemberState.queued.label, "대기열")
        XCTAssertEqual(TeamMemberState.idle.label, "대기")
        XCTAssertEqual(TeamMemberState.error.label, "오류")
    }

    func testTeamRowRenders() async throws {
        let row = TeamRow(team: team, activity: .of(team: team, sessions: []))
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let controller = UIHostingController(rootView: List { row })
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        controller.view.layoutIfNeeded()
        for _ in 0..<3 {
            try await Task.sleep(for: .milliseconds(20))
            controller.view.layoutIfNeeded()
        }
        XCTAssertGreaterThan(controller.view.bounds.height, 0)
        let size = UIHostingController(rootView: row).sizeThatFits(in: CGSize(width: 390, height: 1000))
        XCTAssertGreaterThan(size.height, 20, "행이 이름·경로·배지 두 줄 높이로 그려진다")
        XCTAssertGreaterThan(size.width, 100)
    }
}
