import SwiftUI
import UIKit
import XCTest
@testable import MacAgent

/// `UIHostingController` 렌더 확인(버튼은 누르지 못하므로 렌더만): 카드가 실제로 그려지고, 상태에 따라 행이 늘고 준다.
/// 그려지는 문구는 같은 순수 상태(`ChangesCardState`·`WorkSummaryLabel`·`RoomApprovalCardState`)에서 온다.
@MainActor
final class RoomCardsRenderTests: XCTestCase {
    private var team: Team!
    private var jiyeon: TeamMember!

    override func setUp() async throws {
        try await super.setUp()
        team = try JSONCoding.decoder.decode(Team.self, from: FixtureLoader.data("rest/team.json"))
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

    private func height<V: View>(_ view: V, width: CGFloat = 390) -> CGFloat {
        UIHostingController(rootView: view).sizeThatFits(in: CGSize(width: width, height: 4000)).height
    }

    func testChangesReadyCardRendersMergeButtonAndFiles() throws {
        let changes = try message("room.message.changes")
        let ready = ChangesReadyCard(message: changes, member: jiyeon, submit: .idle, onMerge: {}, onDismiss: {})
        XCTAssertEqual(ChangesCardState.make(message: changes, member: jiyeon, submit: .idle).action, .merge(label: "main에 병합"))
        let readyHeight = height(ready)
        XCTAssertGreaterThan(readyHeight, 120, "제목 + 칩 + 브랜치 + 파일 2행 + 버튼 행")

        var merged = changes
        merged.changes?.status = .merged
        XCTAssertEqual(ChangesCardState.make(message: merged, member: jiyeon, submit: .idle).statusLine, "병합됨 · a1b2c3d")
        let mergedHeight = height(ChangesReadyCard(message: merged, member: jiyeon, submit: .idle, onMerge: {}, onDismiss: {}))
        XCTAssertGreaterThan(mergedHeight, 100, "상태 줄이 그려진다")
        XCTAssertLessThan(mergedHeight, readyHeight, "버튼 행이 사라진다")

        var conflict = changes
        conflict.changes?.status = .conflict
        conflict.changes?.conflictFiles = ["src/login.ts", "src/login.test.ts"]
        let conflictHeight = height(ChangesReadyCard(message: conflict, member: jiyeon, submit: .idle, onMerge: {}, onDismiss: {}))
        XCTAssertGreaterThan(conflictHeight, readyHeight, "충돌 파일 2행 + 캡션이 늘어난다")
    }

    func testWorkSummaryCardRendersOneLine() throws {
        let agent = try message("room.message.agent")
        let work = try XCTUnwrap(agent.work)
        XCTAssertEqual(WorkSummaryLabel.line(work), "도구 2회 · 파일 변경 없음 · 8초 · $0.04 추정")
        let h = height(WorkSummaryCard(messageId: agent.id, member: team.members[0], work: work, onOpen: { _ in }))
        XCTAssertGreaterThan(h, 20)
        XCTAssertLessThan(h, 80, "접힌 한 줄")
    }

    func testRoomApprovalCardRendersChipAndResolution() throws {
        let pending = try message("room.message.approval")
        let pendingHeight = height(RoomApprovalCard(message: pending, member: jiyeon, onShowDetail: {}))
        XCTAssertGreaterThan(pendingHeight, 90, "제목 + 칩 + prompt + 자세히 보기")

        let resolved = try message("room.message.updated")
        XCTAssertEqual(RoomApprovalCardState.make(message: resolved, member: jiyeon).resolutionLine?.hasPrefix("항상 허용됨 · "), true)
        let resolvedHeight = height(RoomApprovalCard(message: resolved, member: jiyeon, onShowDetail: {}))
        XCTAssertGreaterThan(resolvedHeight, 60)
        XCTAssertLessThan(resolvedHeight, pendingHeight, "해결되면 한 줄 요약만 남는다")
    }

    func testRoomEntryRowUsesCardsAndWorkSummary() throws {
        let members = team.members
        let agent = try message("room.message.agent")
        let rowHeight = height(RoomEntryRow(entry: .message(agent), members: members, onReply: { _ in }))
        let cardHeight = height(MessageCard(message: agent, role: .agent(member: members[0])))
        XCTAssertGreaterThan(rowHeight, cardHeight + 30, "work 가 있으면 아래에 작업 요약이 붙는다")

        var plain = agent
        plain.work = nil
        XCTAssertEqual(height(RoomEntryRow(entry: .message(plain), members: members, onReply: { _ in })), cardHeight, accuracy: 1)

        let changes = try message("room.message.changes")
        XCTAssertGreaterThan(height(RoomEntryRow(entry: .changes(changes), members: members, onReply: { _ in })), 120)
        let approval = try message("room.message.approval")
        XCTAssertGreaterThan(height(RoomEntryRow(entry: .approval(approval), members: members, onReply: { _ in })), 90)
    }
}
