import Foundation
import XCTest
@testable import MacAgent

/// 승인 배너의 표시 규칙(IOS.md 5.3, 7절)을 뷰에서 분리한 `ApprovalBannerState.make(pending:)` 로 검증한다.
@MainActor
final class ApprovalBannerLogicTests: XCTestCase {
    private func approval(_ fixture: String) throws -> Approval {
        let event = try JSONCoding.decoder.decode(ServerEvent.self, from: FixtureLoader.data("ws/approval.requested.\(fixture).json"))
        guard case .approvalRequested(let e) = event else { throw XCTSkip("approval.requested fixture 가 아니다") }
        return e.approval
    }

    func testEmptyPendingHasNoBanner() {
        XCTAssertNil(ApprovalBannerState.make(pending: []))
    }

    func testPicksOldestAndCountsOthers() throws {
        let command = try approval("command")        // 10:10:04
        let fileChange = try approval("file_change") // 10:10:22
        let permission = try approval("permission")  // 10:11:10

        let state = try XCTUnwrap(ApprovalBannerState.make(pending: [permission, fileChange, command]))
        XCTAssertEqual(state.approval.approvalId, command.approvalId, "requestedAt 이 가장 오래된 승인")
        XCTAssertEqual(state.othersCount, 2)
        XCTAssertEqual(state.othersLabel, "외 2건")

        let single = try XCTUnwrap(ApprovalBannerState.make(pending: [fileChange]))
        XCTAssertEqual(single.othersCount, 0)
        XCTAssertNil(single.othersLabel)
    }

    func testOptionsUpToThreeAreShownInOrder() throws {
        let state = try XCTUnwrap(ApprovalBannerState.make(pending: [try approval("command")]))
        XCTAssertEqual(state.actions, [
            .option(ApprovalOption(id: "allow", label: "허용", style: .primary)),
            .option(ApprovalOption(id: "allow_session", label: "이 세션에서 항상 허용", style: .secondary)),
            .option(ApprovalOption(id: "deny", label: "거절", style: .destructive)),
        ])
    }

    func testMoreThanThreeOptionsShowsFirstTwoPlusMore() throws {
        var approval = try approval("command")
        approval.options.append(ApprovalOption(id: "abort", label: "중단", style: .destructive))
        let state = try XCTUnwrap(ApprovalBannerState.make(pending: [approval]))
        XCTAssertEqual(state.actions, [
            .option(approval.options[0]),
            .option(approval.options[1]),
            .more,
        ])
    }

    func testUserInputShowsSingleAnswerAction() throws {
        let state = try XCTUnwrap(ApprovalBannerState.make(pending: [try approval("user_input")]))
        XCTAssertEqual(state.actions, [.answer])
        XCTAssertEqual(state.subtitle, .text("질문 3개"))
    }

    func testSubtitlePerKind() throws {
        XCTAssertEqual(try XCTUnwrap(ApprovalBannerState.make(pending: [try approval("command")])).subtitle, .command("$ npm test"))
        XCTAssertEqual(try XCTUnwrap(ApprovalBannerState.make(pending: [try approval("file_change")])).subtitle, .text("파일 1개"))
        XCTAssertEqual(try XCTUnwrap(ApprovalBannerState.make(pending: [try approval("permission")])).subtitle, .text("권한 요청"))

        var noDollar = try approval("command")
        noDollar.detail = "cwd: /tmp"
        XCTAssertNil(ApprovalBannerState.make(pending: [noDollar])?.subtitle, "$ 줄이 없으면 보조 정보 없음")

        var twoFiles = try approval("file_change")
        twoFiles.diff = "diff --git a/a b/a\n+x\ndiff --git a/b b/b\n+y\n"
        XCTAssertEqual(ApprovalBannerState.make(pending: [twoFiles])?.subtitle, .text("파일 2개"))
    }

    func testButtonStyleMapping() {
        XCTAssertEqual(ApprovalButtonStyle.map(.primary), .prominent)
        XCTAssertEqual(ApprovalButtonStyle.map(.secondary), .bordered)
        XCTAssertEqual(ApprovalButtonStyle.map(.destructive), .destructive)
        XCTAssertEqual(ApprovalButtonStyle.map(.unknown), .bordered, "모르는 스타일은 보조 버튼으로")
    }
}
