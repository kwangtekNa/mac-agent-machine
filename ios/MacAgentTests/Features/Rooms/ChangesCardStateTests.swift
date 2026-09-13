import Foundation
import SwiftUI
import XCTest
@testable import MacAgent

/// "변경 준비됨" 카드의 버튼·문구 규칙(순수 `ChangesCardState`). 6개 status, 전송 상태, 실패 문구, 파일 5개 초과, 브랜치 줄.
final class ChangesCardStateTests: XCTestCase {
    private let changeId = "chg_01J8ZQ4K5N7P9R3S6T8V0W2XG1"
    private var message: RoomMessage!
    private var jiyeon: TeamMember!

    override func setUpWithError() throws {
        try super.setUpWithError()
        let event = try JSONCoding.decoder.decode(RoomEvent.self, from: FixtureLoader.data("room-ws/room.message.changes.json"))
        guard case .roomMessage(let e) = event else { throw XCTSkip("room.message 가 아니다") }
        message = e.message
        let team = try JSONCoding.decoder.decode(Team.self, from: FixtureLoader.data("rest/team.json"))
        jiyeon = team.members[1]
    }

    private func make(status: ChangeSetStatus, submit: MergeSubmitState = .idle, member: TeamMember? = nil, mutate: ((inout ChangeSet) -> Void)? = nil) -> ChangesCardState {
        var copy = message!
        copy.changes!.status = status
        mutate?(&copy.changes!)
        return ChangesCardState.make(message: copy, member: member ?? jiyeon, submit: submit)
    }

    func testReadyOffersMergeIntoBaseBranchAndDismiss() {
        let state = make(status: .ready)
        XCTAssertEqual(state.title, "변경 준비됨 · 파일 2개 · 커밋 1개")
        XCTAssertEqual(state.branchLine, "mam/backend/jiyeon → main")
        XCTAssertEqual(state.action, .merge(label: "main에 병합"))
        XCTAssertTrue(state.canDismiss)
        XCTAssertNil(state.statusLine)
        XCTAssertNil(state.errorLine)
        XCTAssertEqual(state.tint, .accentColor)
        XCTAssertEqual(state.files.map(\.path), ["src/login.ts", "src/login.test.ts"])
        XCTAssertNil(state.moreFilesLabel)
        XCTAssertEqual(state.conflictFiles, [])
    }

    func testMergingShowsProgressAndNoDismiss() {
        let state = make(status: .merging)
        XCTAssertEqual(state.action, .merging)
        XCTAssertFalse(state.canDismiss)
        XCTAssertNil(state.statusLine)
        XCTAssertEqual(state.tint, .accentColor)
    }

    func testSubmittingThisChangeIsMerging() {
        let state = make(status: .ready, submit: .submitting(changeId: changeId))
        XCTAssertEqual(state.action, .merging)
        XCTAssertTrue(state.canDismiss, "거절 버튼은 남되 뷰가 비활성화한다")
        XCTAssertEqual(make(status: .ready, submit: .submitting(changeId: "chg_other")).action, .merge(label: "main에 병합"), "다른 변경의 전송은 무관")
    }

    func testFailedSubmitShowsErrorLineAndKeepsMerge() {
        let state = make(status: .ready, submit: .failed(changeId: changeId, message: "작업 트리가 깨끗하지 않습니다"))
        XCTAssertEqual(state.errorLine, "작업 트리가 깨끗하지 않습니다")
        XCTAssertEqual(state.action, .merge(label: "main에 병합"))
        XCTAssertNil(make(status: .ready, submit: .failed(changeId: "chg_other", message: "x")).errorLine)
    }

    func testMergedShowsShortCommitInGreen() {
        let state = make(status: .merged)
        XCTAssertEqual(state.action, .none)
        XCTAssertFalse(state.canDismiss)
        XCTAssertEqual(state.statusLine, "병합됨 · a1b2c3d")
        XCTAssertEqual(state.tint, .green)
    }

    func testConflictListsFilesWithCaptionAndAllowsDismiss() {
        let state = make(status: .conflict) { $0.conflictFiles = ["src/login.ts"] }
        XCTAssertEqual(state.action, .none)
        XCTAssertTrue(state.canDismiss)
        XCTAssertEqual(state.conflictFiles, ["src/login.ts"])
        XCTAssertEqual(state.statusLine, "충돌이 났습니다. 지연이 worktree 에서 해결하면 새 카드가 올라옵니다")
        XCTAssertEqual(state.tint, .red)
        var conflictMessage = message!
        conflictMessage.changes!.status = .conflict
        XCTAssertEqual(
            ChangesCardState.make(message: conflictMessage, member: nil, submit: .idle).statusLine,
            "충돌이 났습니다. 팀원이 worktree 에서 해결하면 새 카드가 올라옵니다", "팀원을 모르면 일반 이름"
        )
        var minsu = jiyeon!
        minsu.name = "민수"
        XCTAssertEqual(
            ChangesCardState.make(message: conflictMessage, member: minsu, submit: .idle).statusLine,
            "충돌이 났습니다. 민수가 worktree 에서 해결하면 새 카드가 올라옵니다", "받침 없는 이름은 '가'"
        )
    }

    func testDismissedAndStaleAreSecondaryWithoutActions() {
        let dismissed = make(status: .dismissed)
        XCTAssertEqual(dismissed.action, .none)
        XCTAssertFalse(dismissed.canDismiss)
        XCTAssertEqual(dismissed.statusLine, "거절됨")
        XCTAssertEqual(dismissed.tint, .secondary)

        let stale = make(status: .stale)
        XCTAssertEqual(stale.action, .none)
        XCTAssertFalse(stale.canDismiss)
        XCTAssertEqual(stale.statusLine, "새 변경으로 대체됨")
        XCTAssertEqual(stale.tint, .secondary)
    }

    func testMoreThanFiveFilesAreTruncatedWithCount() {
        let state = make(status: .ready) { change in
            change.files = (1...7).map { FileChangeEntry(path: "src/f\($0).ts", kind: .modify, additions: $0, deletions: 0) }
        }
        XCTAssertEqual(state.files.count, 5)
        XCTAssertEqual(state.files.last?.path, "src/f5.ts")
        XCTAssertEqual(state.moreFilesLabel, "외 2개")
    }

    func testChangeIdAndBaseBranchAreExposedForDialog() {
        let state = make(status: .ready)
        XCTAssertEqual(state.changeId, changeId)
        XCTAssertEqual(state.baseBranch, "main")
        XCTAssertEqual(state.mergeConfirmation, "main에 병합합니다. 프로젝트의 작업 트리가 깨끗해야 합니다.")
    }
}
