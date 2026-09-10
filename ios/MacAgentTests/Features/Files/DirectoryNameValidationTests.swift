import XCTest
@testable import MacAgent

/// 새 폴더 이름의 제출 전 검증(IOS.md 9.2). UI 편의일 뿐이며 최종 판단은 서버 400/409 다.
final class DirectoryNameValidationTests: XCTestCase {
    func testEmptyOrWhitespaceIsRejected() {
        XCTAssertEqual(DirectoryNameValidation.validate(""), DirectoryNameValidation.emptyMessage)
        XCTAssertEqual(DirectoryNameValidation.validate("   "), DirectoryNameValidation.emptyMessage)
        XCTAssertEqual(DirectoryNameValidation.validate("\n"), DirectoryNameValidation.emptyMessage)
    }

    func testSlashIsRejected() {
        XCTAssertEqual(DirectoryNameValidation.validate("a/b"), DirectoryNameValidation.slashMessage)
        XCTAssertEqual(DirectoryNameValidation.validate("/"), DirectoryNameValidation.slashMessage)
        XCTAssertEqual(DirectoryNameValidation.validate("docs/"), DirectoryNameValidation.slashMessage)
    }

    func testControlCharactersAreRejected() {
        XCTAssertEqual(DirectoryNameValidation.validate("a\nb"), DirectoryNameValidation.controlMessage)
        XCTAssertEqual(DirectoryNameValidation.validate("a\u{07}b"), DirectoryNameValidation.controlMessage)
        XCTAssertEqual(DirectoryNameValidation.validate("tab\tname"), DirectoryNameValidation.controlMessage)
        XCTAssertEqual(DirectoryNameValidation.validate("x\u{7F}"), DirectoryNameValidation.controlMessage)
    }

    func testValidNamesPassAndAreTrimmed() {
        for name in ["mam-picker-test", "새 폴더", ".hidden", "a b", "café", "v1.2"] {
            XCTAssertNil(DirectoryNameValidation.validate(name), name)
        }
        XCTAssertNil(DirectoryNameValidation.validate("  ok  "))
        XCTAssertEqual(DirectoryNameValidation.normalized("  ok  "), "ok")
    }
}
