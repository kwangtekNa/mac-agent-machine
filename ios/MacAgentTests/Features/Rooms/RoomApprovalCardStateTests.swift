import Foundation
import XCTest
@testable import MacAgent

/// 방 승인 카드의 표시 규칙(순수 `RoomApprovalCardState`): 대기/해결, 팀원 없음.
final class RoomApprovalCardStateTests: XCTestCase {
    private var pending: RoomMessage!
    private var resolved: RoomMessage!
    private var jiyeon: TeamMember!

    override func setUpWithError() throws {
        try super.setUpWithError()
        pending = try message("room.message.approval")
        resolved = try message("room.message.updated")
        let team = try JSONCoding.decoder.decode(Team.self, from: FixtureLoader.data("rest/team.json"))
        jiyeon = team.members[1]
    }

    private func message(_ fixture: String) throws -> RoomMessage {
        let event = try JSONCoding.decoder.decode(RoomEvent.self, from: FixtureLoader.data("room-ws/\(fixture).json"))
        switch event {
        case .roomMessage(let e): return e.message
        case .roomMessageUpdated(let e): return e.message
        default: throw XCTSkip("메시지 이벤트가 아니다")
        }
    }

    func testPendingApprovalShowsMemberAndNoResolution() {
        let state = RoomApprovalCardState.make(message: pending, member: jiyeon)
        XCTAssertEqual(state.title, "npm test 실행")
        XCTAssertEqual(state.subtitle, "🧑‍💻 지연 · 개발자")
        XCTAssertTrue(state.isPending)
        XCTAssertNil(state.resolutionLine)
    }

    func testResolvedApprovalShowsLabelAndClock() throws {
        let state = RoomApprovalCardState.make(message: resolved, member: jiyeon)
        let at = try XCTUnwrap(resolved.approval?.resolution?.at)
        XCTAssertFalse(state.isPending)
        XCTAssertEqual(state.resolutionLine, "항상 허용됨 · \(Formatters.clock(at))")
        XCTAssertEqual(state.title, "npm test 실행")
    }

    /// 서버가 유령 카드를 정리한 경우(ADR-019, `by: "system"`). 사람이 누른 "중단됨" 과 구분돼야 한다.
    func testSystemResolvedApprovalSaysSystemCancelled() throws {
        let at = Date(timeIntervalSince1970: 1_757_000_000)
        var cleaned = resolved!
        cleaned.approval?.resolution = ApprovalResolution(optionId: "abort", by: .system, at: at)
        let state = RoomApprovalCardState.make(message: cleaned, member: jiyeon)
        XCTAssertFalse(state.isPending)
        XCTAssertEqual(state.resolutionLine, "시스템이 취소함 · \(Formatters.clock(at))")
        XCTAssertEqual(state.title, "npm test 실행")

        var aborted = resolved!
        aborted.approval?.resolution = ApprovalResolution(optionId: "abort", by: .client, at: at)
        XCTAssertEqual(
            RoomApprovalCardState.make(message: aborted, member: jiyeon).resolutionLine,
            "중단됨 · \(Formatters.clock(at))",
            "사람이 누른 중단은 그대로다"
        )
    }

    func testUnknownMemberLeavesSubtitleNil() {
        let state = RoomApprovalCardState.make(message: pending, member: nil)
        XCTAssertNil(state.subtitle)
        XCTAssertTrue(state.isPending)
        XCTAssertEqual(state.title, "npm test 실행")
    }

    func testMissingApprovalPayloadFallsBackToMessageText() {
        var broken = pending!
        broken.approval = nil
        let state = RoomApprovalCardState.make(message: broken, member: jiyeon)
        XCTAssertEqual(state.title, broken.text)
        XCTAssertFalse(state.isPending)
        XCTAssertNil(state.resolutionLine)
    }
}
