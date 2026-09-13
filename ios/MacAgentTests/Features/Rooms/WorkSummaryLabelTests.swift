import Foundation
import XCTest
@testable import MacAgent

/// 작업 요약 한 줄(순수): `도구 7회 · 파일 3개 변경 · 12초`(+ ` · $0.04 추정`), 파일 0개면 `파일 변경 없음`.
final class WorkSummaryLabelTests: XCTestCase {
    private func work(toolCalls: Int = 7, files: [String] = ["a", "b", "c"], durationMs: Int = 12_000, costUsd: Double? = nil) -> WorkSummary {
        WorkSummary(
            sessionId: "ses_01J8ZQ4K5N7P9R3S6T8V0W2XS2", turnId: "trn_01J8ZQ4K5N7P9R3S6T8V0W2XC3",
            toolCalls: toolCalls, filesChanged: files, durationMs: durationMs,
            usage: Usage(inputTokens: 10, outputTokens: 5), costUsd: costUsd
        )
    }

    func testLineWithoutCost() {
        XCTAssertEqual(WorkSummaryLabel.line(work()), "도구 7회 · 파일 3개 변경 · 12초")
    }

    func testLineWithCostSaysEstimated() {
        XCTAssertEqual(WorkSummaryLabel.line(work(costUsd: 0.04)), "도구 7회 · 파일 3개 변경 · 12초 · $0.04 추정")
    }

    func testNoFilesChanged() {
        XCTAssertEqual(WorkSummaryLabel.line(work(toolCalls: 2, files: [], durationMs: 8_200)), "도구 2회 · 파일 변경 없음 · 8초")
    }

    func testMinutesAndSeconds() {
        XCTAssertEqual(WorkSummaryLabel.line(work(durationMs: 90_000)), "도구 7회 · 파일 3개 변경 · 1분 30초")
    }

    func testAccessibilityLabelUsesCommas() {
        XCTAssertEqual(WorkSummaryLabel.accessibilityLabel(work()), "작업 요약, 도구 7회, 파일 3개 변경, 12초")
        XCTAssertEqual(
            WorkSummaryLabel.accessibilityLabel(work(costUsd: 0.04)),
            "작업 요약, 도구 7회, 파일 3개 변경, 12초, $0.04 추정"
        )
    }
}
