import SwiftUI
import UIKit
import XCTest
@testable import MacAgent

/// `WorkGroupCell` 렌더 확인(IOS.md 10.12). 버튼은 누르지 못하므로 `isExpanded` 를 바꿔 두 번 호스팅한다:
/// 접히면 요약 한 줄(제목·수치·머지 대기 캡슐), 펼치면 같은 카드 아래에 개별 카드(`RoomApprovalCard`·`ChangesReadyCard`·시스템 행)가
/// `RoomEntryRow` 그대로 붙는다. 그려지는 문구는 순수 상태(`WorkGroupSummary`)에서 온다.
@MainActor
final class WorkGroupCellRenderTests: XCTestCase {
    private var team: Team!
    private var members: [TeamMember] = []
    private var counter = 0

    override func setUp() async throws {
        try await super.setUp()
        team = try JSONCoding.decoder.decode(Team.self, from: FixtureLoader.data("rest/team.json"))
        members = team.members
        counter = 0
    }

    private func entry(_ fixture: String, mutate: ((inout RoomMessage) -> Void)? = nil) throws -> RoomEntry {
        counter += 1
        let event = try JSONCoding.decoder.decode(RoomEvent.self, from: FixtureLoader.data("room-ws/\(fixture).json"))
        var message: RoomMessage
        switch event {
        case .roomMessage(let e): message = e.message
        case .roomMessageUpdated(let e): message = e.message
        default: throw XCTSkip("메시지 이벤트가 아니다")
        }
        message.id = "msg_test_\(counter)"
        message.seq = counter
        mutate?(&message)
        return RoomEntry.make(message)
    }

    private func height<V: View>(_ view: V, width: CGFloat = 390) -> CGFloat {
        UIHostingController(rootView: view).sizeThatFits(in: CGSize(width: width, height: 4000)).height
    }

    private func rowHeight(_ entry: RoomEntry) -> CGFloat {
        height(RoomEntryRow(entry: entry, members: members, onReply: { _ in }))
    }

    private func cell(_ group: RoomEntryGroup, isExpanded: Bool) throws -> WorkGroupCell {
        guard case .work(let id, let entries, let summary) = group else { throw XCTSkip("작업 그룹이 아니다") }
        return WorkGroupCell(
            id: id, entries: entries, summary: summary, members: members,
            isExpanded: isExpanded, onToggle: {}
        )
    }

    private func summary(_ group: RoomEntryGroup) throws -> WorkGroupSummary {
        guard case .work(_, _, let summary) = group else { throw XCTSkip("작업 그룹이 아니다") }
        return summary
    }

    func testCollapsedIsOneLineAndExpandedAddsTheCards() async throws {
        let notice = try entry("room.message.system")
        let approval = try entry("room.message.updated")
        let change = try entry("room.message.changes")
        let groups = RoomEntryGrouping.group([notice, approval, change], members: members)
        XCTAssertEqual(groups.count, 1)

        // 접힌 셀이 그리는 문구.
        let summary = try summary(groups[0])
        XCTAssertEqual(summary.title, "지연 작업 3건")
        XCTAssertEqual(summary.detail, "명령 1 · 변경 1 · 공지 1")
        XCTAssertEqual(summary.badge, "머지 대기 1건")

        let collapsed = try cell(groups[0], isExpanded: false)
        let expanded = try cell(groups[0], isExpanded: true)

        // 실제 창에 붙여 레이아웃이 도는지 본다(다른 카드 렌더 테스트와 같은 방식).
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let controller = UIHostingController(rootView: expanded)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        controller.view.layoutIfNeeded()
        for _ in 0..<3 {
            try await Task.sleep(for: .milliseconds(20))
            controller.view.layoutIfNeeded()
        }
        XCTAssertGreaterThan(controller.view.bounds.height, 0)

        let collapsedHeight = height(collapsed)
        XCTAssertGreaterThan(collapsedHeight, 30, "아이콘 · 제목 · 수치 · 캡슐 한 줄")
        XCTAssertLessThan(collapsedHeight, 100, "접힌 셀은 카드 한 장")

        // 펼치면 머리 줄은 그대로 남고 개별 카드가 기존 뷰 그대로(같은 높이로) 아래에 붙는다.
        let rows = [notice, approval, change].map(rowHeight)
        let expandedHeight = height(expanded)
        XCTAssertGreaterThanOrEqual(expandedHeight, collapsedHeight + rows.reduce(0, +) * 0.9)
        XCTAssertGreaterThan(rows[2], 120, "변경 준비됨 카드(브랜치 · 파일 · 버튼)가 실제로 그려진다")

        // 항목이 늘면 펼친 높이도 그만큼 는다(개별 카드가 실제로 그려진다는 뜻).
        let shorter = RoomEntryGrouping.group([notice, approval], members: members)
        XCTAssertLessThan(height(try cell(shorter[0], isExpanded: true)), expandedHeight)
    }

    func testMergeReadyBadgeShowsOnlyWhenMergeIsWaiting() throws {
        let ready = RoomEntryGrouping.group([try entry("room.message.changes")], members: members)
        let merged = RoomEntryGrouping.group(
            [try entry("room.message.changes") { $0.changes?.status = .merged }],
            members: members
        )
        XCTAssertEqual(try summary(ready[0]).badge, "머지 대기 1건")
        XCTAssertNil(try summary(merged[0]).badge, "머지가 끝났으면 캡슐이 없다")
        XCTAssertEqual(try summary(ready[0]).title, "지연 변경 1건", "1건이어도 묶는다")

        let readyHeight = height(try cell(ready[0], isExpanded: false))
        let mergedHeight = height(try cell(merged[0], isExpanded: false))
        XCTAssertGreaterThan(readyHeight, mergedHeight, "머지 대기 캡슐이 붙는다")
        XCTAssertLessThan(readyHeight, 100, "캡슐이 붙어도 접힌 셀은 카드 한 장")
    }
}
