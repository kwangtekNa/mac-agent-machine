import Foundation
import XCTest
@testable import MacAgent

/// `RoomEntryGrouping.group(_:members:)`(순수, IOS.md 10.12): 연속된 작업 카드(해결된 승인 · 변경 · 공지)를 한 셀로 접는다.
/// 대기 중 승인·곁방 연결 카드·대화는 접지 않는다 — 대기 중 승인은 사람이 눌러야 에이전트가 진행하고, 곁방 카드는 그 방으로 가는 유일한 입구다.
final class RoomEntryGroupingTests: XCTestCase {
    private var team: Team!
    private var members: [TeamMember] = []
    private var minsu: TeamMember!
    private var jiyeon: TeamMember!
    private var counter = 0

    override func setUpWithError() throws {
        try super.setUpWithError()
        team = try JSONCoding.decoder.decode(Team.self, from: FixtureLoader.data("rest/team.json"))
        members = team.members
        minsu = team.members[0]
        jiyeon = team.members[1]
        counter = 0
    }

    // MARK: - helpers

    private func base(_ fixture: String) throws -> RoomMessage {
        let event = try JSONCoding.decoder.decode(RoomEvent.self, from: FixtureLoader.data("room-ws/\(fixture).json"))
        switch event {
        case .roomMessage(let e): return e.message
        case .roomMessageUpdated(let e): return e.message
        default: throw XCTSkip("메시지 이벤트가 아니다")
        }
    }

    /// fixture 를 복사해 id·seq 만 새로 붙인다(한 방 안의 서로 다른 메시지).
    private func entry(_ fixture: String, mutate: ((inout RoomMessage) -> Void)? = nil) throws -> RoomEntry {
        counter += 1
        var message = try base(fixture)
        message.id = "msg_test_\(counter)"
        message.seq = counter
        mutate?(&message)
        return RoomEntry.make(message)
    }

    private func resolvedApproval(by member: TeamMember? = nil) throws -> RoomEntry {
        try entry("room.message.updated") { message in
            if let member {
                message.author = .agent(memberId: member.id)
                message.approval?.memberId = member.id
            }
        }
    }

    private func pendingApproval() throws -> RoomEntry {
        try entry("room.message.approval")
    }

    private func changes(status: ChangeSetStatus = .ready, by member: TeamMember? = nil) throws -> RoomEntry {
        try entry("room.message.changes") { message in
            message.changes?.status = status
            if let member {
                message.author = .agent(memberId: member.id)
                message.changes?.memberId = member.id
            }
        }
    }

    private func system() throws -> RoomEntry { try entry("room.message.system") }

    private func summary(_ group: RoomEntryGroup) throws -> WorkGroupSummary {
        guard case .work(_, _, let summary) = group else { throw XCTSkip("작업 그룹이 아니다") }
        return summary
    }

    private func entries(_ group: RoomEntryGroup) -> [RoomEntry] {
        switch group {
        case .single(let entry): [entry]
        case .work(_, let entries, _): entries
        }
    }

    private func isWork(_ group: RoomEntryGroup) -> Bool {
        if case .work = group { return true }
        return false
    }

    // MARK: - 묶기 규칙

    func testConsecutiveWorkCardsBetweenMessagesBecomeOneGroup() throws {
        let user = try entry("room.message.user")
        let notice = try system()
        let approval = try resolvedApproval()
        let change = try changes()
        let agent = try entry("room.message.agent")

        let groups = RoomEntryGrouping.group([user, notice, approval, change, agent], members: members)

        XCTAssertEqual(groups.count, 3, "대화 · 작업 3건 · 대화")
        XCTAssertFalse(isWork(groups[0]))
        XCTAssertEqual(groups[0].id, user.id)
        XCTAssertTrue(isWork(groups[1]))
        XCTAssertEqual(entries(groups[1]).map(\.id), [notice.id, approval.id, change.id])
        XCTAssertEqual(groups[1].id, notice.id, "그룹 id 는 첫 항목의 id")
        XCTAssertFalse(isWork(groups[2]))
        XCTAssertEqual(groups[2].id, agent.id)
    }

    func testPendingApprovalStaysSingleAndBreaksTheGroup() throws {
        let notice = try system()
        let pending = try pendingApproval()
        let change = try changes()

        XCTAssertFalse(RoomEntryGrouping.isGroupable(pending), "사람이 눌러야 에이전트가 진행한다")
        let groups = RoomEntryGrouping.group([notice, pending, change], members: members)

        XCTAssertEqual(groups.count, 3)
        XCTAssertEqual(entries(groups[0]).map(\.id), [notice.id])
        XCTAssertTrue(isWork(groups[0]))
        XCTAssertFalse(isWork(groups[1]), "대기 중 승인은 항상 펼쳐 둔다")
        XCTAssertEqual(groups[1].id, pending.id)
        XCTAssertTrue(isWork(groups[2]))
        XCTAssertEqual(entries(groups[2]).map(\.id), [change.id])
    }

    func testResolvedApprovalIsGroupable() throws {
        let resolved = try resolvedApproval()
        XCTAssertTrue(RoomEntryGrouping.isGroupable(resolved))

        let groups = RoomEntryGrouping.group([resolved], members: members)
        XCTAssertEqual(groups.count, 1)
        XCTAssertTrue(isWork(groups[0]))
    }

    func testSideRoomCardIsNeverGrouped() throws {
        let before = try system()
        let side = try entry("room.message.side-opened")
        let after = try system()

        XCTAssertFalse(RoomEntryGrouping.isGroupable(side), "곁방으로 들어가는 유일한 입구라 묻히면 안 된다")
        let groups = RoomEntryGrouping.group([before, side, after], members: members)

        XCTAssertEqual(groups.count, 3)
        XCTAssertEqual(entries(groups[0]).map(\.id), [before.id])
        XCTAssertFalse(isWork(groups[1]))
        XCTAssertEqual(groups[1].id, side.id)
        XCTAssertEqual(entries(groups[2]).map(\.id), [after.id])
    }

    func testTextMessagesAreNeverGrouped() throws {
        let user = try entry("room.message.user")
        let agent = try entry("room.message.agent")

        XCTAssertFalse(RoomEntryGrouping.isGroupable(user))
        XCTAssertFalse(RoomEntryGrouping.isGroupable(agent))
        let groups = RoomEntryGrouping.group([user, agent], members: members)
        XCTAssertEqual(groups.map(\.id), [user.id, agent.id])
        XCTAssertFalse(groups.contains(where: isWork))
    }

    func testSingleWorkCardIsStillAGroup() throws {
        let change = try changes()
        let groups = RoomEntryGrouping.group([change], members: members)

        XCTAssertEqual(groups.count, 1)
        XCTAssertTrue(isWork(groups[0]), "1건이어도 무조건 묶는다")
        XCTAssertEqual(groups[0].id, change.id)
        XCTAssertEqual(try summary(groups[0]).changes, 1)
    }

    func testEmptyEntriesMakeNoGroups() {
        XCTAssertTrue(RoomEntryGrouping.group([], members: members).isEmpty)
    }

    // MARK: - 요약

    func testSummaryCountsAndLabels() throws {
        let group = RoomEntryGrouping.group(
            [
                try resolvedApproval(by: jiyeon),
                try resolvedApproval(by: jiyeon),
                try changes(status: .ready, by: jiyeon),
                try changes(status: .merged, by: minsu),
                try system(),
            ],
            members: members
        )
        XCTAssertEqual(group.count, 1)
        let summary = try summary(group[0])

        XCTAssertEqual(summary.approvals, 2)
        XCTAssertEqual(summary.changes, 2)
        XCTAssertEqual(summary.systems, 1)
        XCTAssertEqual(summary.mergeReady, 1, "status == ready 인 변경 카드만")
        XCTAssertEqual(summary.memberNames, ["지연", "민수"], "등장 순서, 중복 제거")
        XCTAssertEqual(summary.title, "작업 5건")
        XCTAssertEqual(summary.detail, "명령 2 · 변경 2 · 공지 1")
        XCTAssertEqual(summary.badge, "머지 대기 1건")
        XCTAssertEqual(summary.accessibilityLabel, "작업 5건, 명령 2 변경 2 공지 1, 머지 대기 1건")
    }

    func testSingleKindTitleHasNoDetail() throws {
        let approvals = try RoomEntryGrouping.group(
            [resolvedApproval(by: jiyeon), resolvedApproval(by: minsu), resolvedApproval(by: jiyeon)],
            members: members
        )
        XCTAssertEqual(try summary(approvals[0]).title, "명령 3건")
        XCTAssertEqual(try summary(approvals[0]).detail, "")
        XCTAssertNil(try summary(approvals[0]).badge, "머지 대기가 없으면 캡슐도 없다")

        let changed = try RoomEntryGrouping.group(
            [changes(status: .ready, by: jiyeon), changes(status: .ready, by: minsu)],
            members: members
        )
        XCTAssertEqual(try summary(changed[0]).title, "변경 2건")
        XCTAssertEqual(try summary(changed[0]).badge, "머지 대기 2건")

        let notices = try RoomEntryGrouping.group([system(), system(), system(), system()], members: members)
        XCTAssertEqual(try summary(notices[0]).title, "공지 4건", "시스템 공지는 작성자가 없어 이름 접두도 없다")
        XCTAssertEqual(try summary(notices[0]).detail, "")
        XCTAssertEqual(try summary(notices[0]).memberNames, [])
        XCTAssertEqual(try summary(notices[0]).accessibilityLabel, "공지 4건")
    }

    func testSingleMemberNamePrefixesTheTitle() throws {
        let one = try RoomEntryGrouping.group(
            [resolvedApproval(by: jiyeon), resolvedApproval(by: jiyeon), resolvedApproval(by: jiyeon)],
            members: members
        )
        XCTAssertEqual(try summary(one[0]).memberNames, ["지연"])
        XCTAssertEqual(try summary(one[0]).title, "지연 명령 3건")

        let mixed = try RoomEntryGrouping.group(
            [resolvedApproval(by: jiyeon), changes(status: .ready, by: jiyeon), system()],
            members: members
        )
        XCTAssertEqual(try summary(mixed[0]).title, "지연 작업 3건", "공지는 작성자가 없어 팀원은 여전히 한 명")

        let two = try RoomEntryGrouping.group(
            [resolvedApproval(by: jiyeon), resolvedApproval(by: minsu)],
            members: members
        )
        XCTAssertEqual(try summary(two[0]).title, "명령 2건", "여러 명이면 이름을 붙이지 않는다")
    }

    func testUnknownMemberHasNoName() throws {
        let unknown = try RoomEntryGrouping.group([changes(status: .ready, by: jiyeon)], members: [])
        XCTAssertEqual(try summary(unknown[0]).memberNames, [], "팀원 목록에 없으면 이름을 만들지 않는다")
        XCTAssertEqual(try summary(unknown[0]).title, "변경 1건")
    }

    // MARK: - 펼침 상태가 유지되도록 id 가 안정적이어야 한다

    func testGroupIdStaysStableWhenMessagesArrive() throws {
        let first = try system()
        let second = try resolvedApproval()
        var all: [RoomEntry] = [first, second]

        let before = RoomEntryGrouping.group(all, members: members)
        XCTAssertEqual(before.count, 1)
        XCTAssertEqual(before[0].id, first.id)

        all.append(try changes())
        let after = RoomEntryGrouping.group(all, members: members)
        XCTAssertEqual(after.count, 1)
        XCTAssertEqual(after[0].id, first.id, "뒤에 메시지가 붙어도 그룹 id(첫 항목)는 그대로 — 펼침 상태가 유지된다")
        XCTAssertEqual(entries(after[0]).count, 3)

        all.append(try entry("room.message.user"))
        let withMessage = RoomEntryGrouping.group(all, members: members)
        XCTAssertEqual(withMessage.count, 2)
        XCTAssertEqual(withMessage[0].id, first.id)
    }
}
