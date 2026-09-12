import UIKit
import XCTest
@testable import MacAgent

final class FileViewerLogicTests: XCTestCase {
    func testHighlightSizeGate() {
        XCTAssertEqual(FileViewerLogic.highlightLimitBytes, 204_800)
        XCTAssertTrue(FileViewerLogic.shouldHighlight(size: 204_800, language: "swift"))
        XCTAssertTrue(FileViewerLogic.shouldHighlight(size: 0, language: "typescript"))
        XCTAssertFalse(FileViewerLogic.shouldHighlight(size: 204_801, language: "swift"), "200 KiB 초과는 plain")
        XCTAssertFalse(FileViewerLogic.shouldHighlight(size: 10, language: "plaintext"), "plaintext 는 하이라이트 없음")
        XCTAssertFalse(FileViewerLogic.shouldHighlight(size: 10, language: "unknown-lang"))
    }

    func testBase64ImageDecodesFromFixture() throws {
        let file = try JSONCoding.decoder.decode(FsReadResponse.self, from: try FixtureLoader.data("rest/fs-read-image.json"))
        XCTAssertTrue(FileViewerLogic.isImage(file))
        let image = try XCTUnwrap(FileViewerLogic.image(from: file))
        XCTAssertEqual(image.size, CGSize(width: 1, height: 1))

        var broken = file
        broken.content = "not-base64!!"
        XCTAssertNil(FileViewerLogic.image(from: broken))
        var text = file
        text.encoding = "utf8"
        XCTAssertFalse(FileViewerLogic.isImage(text))
        XCTAssertNil(FileViewerLogic.image(from: text))
    }

    func testTruncatedBanner() throws {
        var file = try JSONCoding.decoder.decode(FsReadResponse.self, from: try FixtureLoader.data("rest/fs-read-text.json"))
        XCTAssertFalse(FileViewerLogic.showsTruncatedBanner(file))
        file.truncated = true
        XCTAssertTrue(FileViewerLogic.showsTruncatedBanner(file))
    }

    func testUnsupportedMediaAndFontSize() {
        XCTAssertTrue(FileViewerLogic.isUnsupportedMedia(APIError.server(code: .internalError, message: "binary", status: 415)))
        XCTAssertFalse(FileViewerLogic.isUnsupportedMedia(APIError.server(code: .notFound, message: "", status: 404)))
        XCTAssertFalse(FileViewerLogic.isUnsupportedMedia(URLError(.notConnectedToInternet)))
        XCTAssertEqual(FileViewerLogic.codeFontSize(bodyPointSize: 20), 17, accuracy: 0.001)
    }

    func testCanShowDiff() {
        XCTAssertTrue(FileViewerLogic.canShowDiff(isGitRepo: true, gitStatus: .modified))
        XCTAssertTrue(FileViewerLogic.canShowDiff(isGitRepo: true, gitStatus: .added))
        XCTAssertTrue(FileViewerLogic.canShowDiff(isGitRepo: true, gitStatus: .deleted))
        XCTAssertFalse(FileViewerLogic.canShowDiff(isGitRepo: true, gitStatus: .untracked))
        XCTAssertFalse(FileViewerLogic.canShowDiff(isGitRepo: true, gitStatus: nil))
        XCTAssertFalse(FileViewerLogic.canShowDiff(isGitRepo: false, gitStatus: .modified))
    }

    func testFileAccessMessages() {
        XCTAssertEqual(ErrorMessages.fileAccessMessage(for: APIError.server(code: .forbidden, message: "x", status: 403)), ErrorMessages.pathForbidden)
        XCTAssertEqual(ErrorMessages.fileAccessMessage(for: APIError.server(code: .notFound, message: "x", status: 404)), ErrorMessages.pathNotFound)
        XCTAssertEqual(ErrorMessages.fileAccessMessage(for: APIError.server(code: .internalError, message: "서버 오류", status: 500)), "서버 오류")
        XCTAssertEqual(ErrorMessages.fileAccessMessage(for: APIError.transport(URLError(.timedOut))), ErrorMessages.cannotConnect)
    }

    func testMarkdownRenderingGate() {
        XCTAssertTrue(FileViewerLogic.isMarkdown(language: "markdown"), "서버는 .md/.markdown 을 'markdown' 으로 준다")
        XCTAssertFalse(FileViewerLogic.isMarkdown(language: "plaintext"))
        XCTAssertFalse(FileViewerLogic.isMarkdown(language: "swift"))
        XCTAssertTrue(FileViewerLogic.canRenderMarkdown(size: 204_800, language: "markdown"))
        XCTAssertFalse(FileViewerLogic.canRenderMarkdown(size: 204_801, language: "markdown"), "200 KiB 초과는 원본만")
        XCTAssertFalse(FileViewerLogic.canRenderMarkdown(size: 10, language: "swift"))
    }
}
