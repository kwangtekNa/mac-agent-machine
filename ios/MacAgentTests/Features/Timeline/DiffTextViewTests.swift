import XCTest
@testable import MacAgent

final class DiffTextViewTests: XCTestCase {
    func testClassifyLines() {
        XCTAssertEqual(DiffLine.classify("+  return token;"), .added)
        XCTAssertEqual(DiffLine.classify("-  return token;"), .removed)
        XCTAssertEqual(DiffLine.classify("@@ -10,3 +10,5 @@"), .hunk)
        XCTAssertEqual(DiffLine.classify("+++ b/src/login.ts"), .header)
        XCTAssertEqual(DiffLine.classify("--- a/src/login.ts"), .header)
        XCTAssertEqual(DiffLine.classify("diff --git a/src/login.ts b/src/login.ts"), .header)
        XCTAssertEqual(DiffLine.classify("index 1a2b..3c4d 100644"), .header)
        XCTAssertEqual(DiffLine.classify("   if (x) {"), .context)
        XCTAssertEqual(DiffLine.classify(""), .context)
    }

    func testSplitKeepsOrderAndDropsTrailingEmptyLine() {
        let lines = DiffLine.split("--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n")
        XCTAssertEqual(lines.map(\.kind), [.header, .header, .hunk, .removed, .added])
        XCTAssertEqual(lines.map(\.text), ["--- a", "+++ b", "@@ -1 +1 @@", "-old", "+new"])
        XCTAssertEqual(Set(lines.map(\.id)).count, lines.count)
    }
}
