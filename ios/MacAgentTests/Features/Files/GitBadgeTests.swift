import SwiftUI
import XCTest
@testable import MacAgent

final class GitBadgeTests: XCTestCase {
    func testMapping() {
        XCTAssertEqual(GitBadge.style(.modified)?.text, "M")
        XCTAssertEqual(GitBadge.style(.modified)?.color, .orange)
        XCTAssertEqual(GitBadge.style(.added)?.text, "A")
        XCTAssertEqual(GitBadge.style(.added)?.color, .green)
        XCTAssertEqual(GitBadge.style(.deleted)?.text, "D")
        XCTAssertEqual(GitBadge.style(.deleted)?.color, .red)
        XCTAssertEqual(GitBadge.style(.renamed)?.text, "R")
        XCTAssertEqual(GitBadge.style(.renamed)?.color, .teal)
        XCTAssertEqual(GitBadge.style(.untracked)?.text, "?")
        XCTAssertEqual(GitBadge.style(.untracked)?.color, .gray)
        XCTAssertEqual(GitBadge.style(.ignored)?.text, "!")
        XCTAssertEqual(GitBadge.style(.ignored)?.color, .secondary)
    }

    func testNilAndUnknown() {
        XCTAssertNil(GitBadge.style(nil))
        XCTAssertNil(GitBadge.style(.unknown))
    }
}
