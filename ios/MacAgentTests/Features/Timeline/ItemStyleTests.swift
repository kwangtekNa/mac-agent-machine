import SwiftUI
import XCTest
@testable import MacAgent

/// IOS.md 5.2 표의 대표 매핑.
final class ItemStyleTests: XCTestCase {
    private func item(_ payload: TimelinePayload, status: ItemStatus = .completed) -> TimelineItem {
        TimelineItem(id: "itm_x", seq: 1, turnId: nil, status: status, createdAt: .now, completedAt: nil, payload: payload)
    }

    private func tool(_ tool: ToolName) -> TimelineItem {
        item(.toolCall(ToolCallPayload(tool: tool, name: "X", title: "x", input: [:], output: "", exitCode: nil, truncated: false)))
    }

    private func approval(resolved: Bool) -> TimelineItem {
        let approval = Approval(
            approvalId: "apr_x", itemId: "itm_x", kind: .command, title: "t", prompt: "p", detail: nil, diff: nil,
            options: [], inputFields: [], requestedAt: .now
        )
        let resolution = resolved ? ApprovalResolution(optionId: "allow", by: .client, at: .now) : nil
        return item(.approval(ApprovalPayload(approval: approval, resolution: resolution)))
    }

    func testTableMappings() {
        XCTAssertEqual(ItemStyle.style(for: item(.reasoning(ReasoningPayload(text: "")))), ItemStyle(symbol: "brain", tint: .secondary, defaultExpanded: false))
        XCTAssertEqual(ItemStyle.style(for: tool(.bash)), ItemStyle(symbol: "terminal", tint: .gray, defaultExpanded: false))
        XCTAssertEqual(ItemStyle.style(for: tool(.grep)), ItemStyle(symbol: "doc.text.magnifyingglass", tint: .gray, defaultExpanded: false))
        XCTAssertEqual(ItemStyle.style(for: tool(.edit)), ItemStyle(symbol: "pencil.line", tint: .orange, defaultExpanded: false))
        XCTAssertEqual(ItemStyle.style(for: tool(.web)), ItemStyle(symbol: "globe", tint: .blue, defaultExpanded: false))
        XCTAssertEqual(ItemStyle.style(for: tool(.mcp)), ItemStyle(symbol: "puzzlepiece.extension", tint: .purple, defaultExpanded: false))
        XCTAssertEqual(ItemStyle.style(for: tool(.task)), ItemStyle(symbol: "person.2", tint: .indigo, defaultExpanded: false))
        XCTAssertEqual(ItemStyle.style(for: tool(.unknown)), ItemStyle(symbol: "wrench.and.screwdriver", tint: .gray, defaultExpanded: false))
        XCTAssertEqual(
            ItemStyle.style(for: item(.fileChange(FileChangePayload(files: [], patch: "")))),
            ItemStyle(symbol: "plus.forwardslash.minus", tint: .teal, defaultExpanded: true)
        )
        XCTAssertEqual(ItemStyle.style(for: item(.plan(PlanPayload(steps: [])))), ItemStyle(symbol: "checklist", tint: .mint, defaultExpanded: true))
        XCTAssertEqual(ItemStyle.style(for: approval(resolved: false)), ItemStyle(symbol: "hand.raised.fill", tint: .yellow, defaultExpanded: true))
        XCTAssertEqual(ItemStyle.style(for: approval(resolved: true)), ItemStyle(symbol: "hand.raised", tint: .secondary, defaultExpanded: false))
        XCTAssertEqual(ItemStyle.style(for: item(.turnSummary(TurnSummaryPayload(durationMs: 1, usage: Usage(inputTokens: 1, outputTokens: 1), stopReason: "end_turn")))).symbol, "clock")
        XCTAssertEqual(ItemStyle.style(for: item(.error(ErrorPayload(message: "", recoverable: true)))), ItemStyle(symbol: "exclamationmark.triangle.fill", tint: .red, defaultExpanded: true))
        XCTAssertEqual(ItemStyle.style(for: item(.system(SystemPayload(text: "")))), ItemStyle(symbol: "info.circle", tint: .secondary, defaultExpanded: true))
        XCTAssertEqual(ItemStyle.style(for: item(.userMessage(UserMessagePayload(text: "")))).symbol, "")
        XCTAssertEqual(ItemStyle.style(for: item(.assistantMessage(AssistantMessagePayload(text: "", phase: .final)))).symbol, "")
    }

    func testStatusOverridesTint() {
        XCTAssertEqual(ItemStyle.style(for: tool(.bash)).tint(for: .failed), .red)
        XCTAssertEqual(ItemStyle.style(for: tool(.edit)).tint(for: .cancelled), .secondary)
        XCTAssertEqual(ItemStyle.style(for: tool(.edit)).tint(for: .running), .orange)
    }
}
