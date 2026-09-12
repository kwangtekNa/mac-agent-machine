import SwiftUI
import XCTest
@testable import MacAgent

/// `ItemCard` 의 `CardChrome` init(step 3): `TimelineItem` 없이도 카드 컨테이너를 쓰되,
/// 기존 `item:` init 은 같은 접근성 요약(`ItemAccessibility.summary`)을 담은 `CardChrome` 을 만들어 위임한다.
@MainActor
final class ItemCardChromeTests: XCTestCase {
    private func item(
        _ payload: TimelinePayload,
        status: ItemStatus = .completed,
        createdAt: Date = Date(timeIntervalSince1970: 1_700_000_000)
    ) -> TimelineItem {
        TimelineItem(id: "itm_x", seq: 1, turnId: nil, status: status, createdAt: createdAt, completedAt: nil, payload: payload)
    }

    func testItemInitBuildsChromeWithSameAccessibilitySummary() {
        let tool = item(.toolCall(ToolCallPayload(tool: .bash, name: "Bash", title: "npm test", input: [:], output: "", exitCode: 0, truncated: false)))

        let card = ItemCard(item: tool, style: ItemStyle.style(for: tool), title: "npm test") { EmptyView() }

        XCTAssertEqual(
            card.chrome,
            CardChrome(status: tool.status, createdAt: tool.createdAt, summary: ItemAccessibility.summary(for: tool, title: "npm test"))
        )
        XCTAssertEqual(card.chrome.summary, "도구 실행 npm test, 완료")
    }

    func testItemInitLeavesSummaryNilForMessageKinds() {
        let message = item(.assistantMessage(AssistantMessagePayload(text: "hi", phase: .final)), status: .running)

        let card = ItemCard(item: message, style: ItemStyle.style(for: message)) { EmptyView() }

        XCTAssertNil(card.chrome.summary, "메시지 카드는 본문이 그대로 읽힌다")
        XCTAssertEqual(card.chrome.status, .running)
        XCTAssertEqual(card.chrome.createdAt, message.createdAt)
        XCTAssertNil(card.title)
    }

    func testChromeInitKeepsGivenValues() {
        let chrome = CardChrome(status: .failed, createdAt: Date(timeIntervalSince1970: 1), summary: "도구 실행 npm test, 실패")
        let style = ItemStyle(symbol: "hand.raised.fill", tint: .yellow, defaultExpanded: true)

        let card = ItemCard(chrome: chrome, style: style, title: "npm test 실행", badge: "exit 1") { EmptyView() }

        XCTAssertEqual(card.chrome, chrome)
        XCTAssertEqual(card.title, "npm test 실행")
        XCTAssertEqual(card.badge, "exit 1")
        XCTAssertFalse(card.titleMonospaced)
    }
}
