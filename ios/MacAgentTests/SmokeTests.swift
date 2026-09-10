import Highlightr
import MarkdownUI
import XCTest

/// 프로젝트 뼈대 스모크 테스트: fixture 폴더 참조가 번들에 들어가고, 허용된 두 패키지가 링크되는지 확인한다.
final class SmokeTests: XCTestCase {
    func testFixturesFolderIsBundled() throws {
        let bundle = Bundle(for: Self.self)
        let fixtures = try XCTUnwrap(
            bundle.url(forResource: "fixtures", withExtension: nil),
            "테스트 번들 안에 fixtures/ 폴더 참조가 없다"
        )
        let meURL = fixtures.appending(path: "rest/me.json")
        let data = try Data(contentsOf: meURL)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["user"] as? String, "alice")
    }

    func testMarkdownUIIsLinked() {
        let content = MarkdownContent("**MacAgent**")
        XCTAssertNotNil(content)
    }

    func testHighlightrIsLinked() {
        let highlighter = Highlightr()
        XCTAssertNotNil(highlighter)
    }
}
