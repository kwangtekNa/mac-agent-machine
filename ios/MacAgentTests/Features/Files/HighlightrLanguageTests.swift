import XCTest
@testable import MacAgent

final class HighlightrLanguageTests: XCTestCase {
    func testAllMappings() {
        let expected: [String: String] = [
            "typescript": "typescript", "javascript": "javascript", "swift": "swift", "python": "python",
            "ruby": "ruby", "go": "go", "rust": "rust", "java": "java", "kotlin": "kotlin", "c": "c", "cpp": "cpp",
            "objective-c": "objectivec", "shell": "bash", "json": "json", "yaml": "yaml", "toml": "ini",
            "markdown": "markdown", "html": "xml", "css": "css", "scss": "scss", "sql": "sql", "xml": "xml",
            "dockerfile": "dockerfile", "makefile": "makefile",
        ]
        for (server, highlightr) in expected {
            XCTAssertEqual(HighlightrLanguage.name(for: server), highlightr, server)
        }
        XCTAssertEqual(HighlightrLanguage.mapping.count, expected.count, "표에 없는 매핑이 추가됐다")
    }

    func testPlaintextAndUnknownAreNil() {
        XCTAssertNil(HighlightrLanguage.name(for: "plaintext"))
        XCTAssertNil(HighlightrLanguage.name(for: "brainfuck"))
        XCTAssertNil(HighlightrLanguage.name(for: ""))
        XCTAssertNil(HighlightrLanguage.name(for: "Swift"), "대소문자 그대로 비교")
    }
}

import Highlightr

extension HighlightrLanguageTests {
    /// 매핑한 이름이 번들된 highlight.js 가 아는 언어여야 한다.
    func testMappedNamesAreSupportedByHighlightr() throws {
        let highlightr = try XCTUnwrap(Highlightr())
        let supported = Set(highlightr.supportedLanguages())
        for (server, name) in HighlightrLanguage.mapping {
            XCTAssertTrue(supported.contains(name), "\(server) → \(name) 은 Highlightr 가 모르는 언어")
        }
    }
}
