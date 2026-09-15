import Foundation
import XCTest
@testable import MacAgent

/// 해결된 승인의 한 줄 문구(`ApprovalCardBody.resolutionText`). 타임라인 카드와 방 카드가 같이 쓴다.
/// 누가 처리했는지(`by`)가 먼저다: 서버가 정리한 유령 카드(ADR-019)는 사람이 누른 "중단됨" 과 달라야 한다.
final class ApprovalResolutionTextTests: XCTestCase {
    private let at = Date(timeIntervalSince1970: 1_757_000_000)

    private func text(_ optionId: String, _ by: ApprovalResolvedBy) -> String {
        ApprovalCardBody.resolutionText(ApprovalResolution(optionId: optionId, by: by, at: at))
    }

    func testClientResolutionsKeepOptionLabels() {
        XCTAssertEqual(text("allow", .client), "허용됨")
        XCTAssertEqual(text("allow_session", .client), "항상 허용됨")
        XCTAssertEqual(text("deny", .client), "거절됨")
        XCTAssertEqual(text("abort", .client), "중단됨")
    }

    func testSystemCleanupAndTimeoutSayWhoResolved() {
        XCTAssertEqual(text("abort", .system), "시스템이 취소함", "재시작·세션 종료로 서버가 정리한 카드")
        XCTAssertEqual(text("allow", .system), "시스템이 취소함", "optionId 와 무관하게 by 가 이긴다")
        XCTAssertEqual(text("deny", .timeout), "시간 초과")
        XCTAssertEqual(text("abort", .timeout), "시간 초과")
    }

    func testUnknownOptionIdFallsBackToRawValue() {
        XCTAssertEqual(text("submit", .client), "submit")
        XCTAssertEqual(text("weird_option", .client), "weird_option")
    }

    /// lenient 열거형이라 모르는 `by` 가 올 수 있다. 그때는 지금까지의 문구 그대로다.
    func testUnknownByKeepsOptionLabel() {
        XCTAssertEqual(text("allow", .unknown), "허용됨")
        XCTAssertEqual(text("nope", .unknown), "nope")
    }

    /// `resolutionLabel(_ optionId:)` 은 그대로 남아 있어야 한다(타임라인 카드·기존 호출부가 쓴다).
    func testOptionIdLabelStillAvailable() {
        XCTAssertEqual(ApprovalCardBody.resolutionLabel("allow_session"), "항상 허용됨")
        XCTAssertEqual(ApprovalCard.resolutionLabel("abort"), "중단됨")
    }
}
