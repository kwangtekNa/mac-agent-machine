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

    // MARK: - 문서 뷰어(2026-09-13, PROTOCOL.md `GET /fs/download`·`GET /fs/render`)

    func testDocumentKindByExtension() {
        XCTAssertEqual(FileViewerLogic.documentKind(forFileName: "보고서.pdf"), .quickLook)
        XCTAssertEqual(FileViewerLogic.documentKind(forFileName: "계약서.DOCX"), .quickLook, "대소문자를 가리지 않는다")
        for ext in ["doc", "docx", "xls", "xlsx", "ppt", "pptx", "rtf", "rtfd", "pages", "numbers", "key", "epub"] {
            XCTAssertEqual(FileViewerLogic.documentKind(forFileName: "a.\(ext)"), .quickLook, ext)
        }
        XCTAssertEqual(FileViewerLogic.documentKind(forFileName: "회의록.hwp"), .hwp)
        XCTAssertEqual(FileViewerLogic.documentKind(forFileName: "회의록.HWPX"), .hwpx)

        XCTAssertNil(FileViewerLogic.documentKind(forFileName: "README.md"), "마크다운은 기존 뷰어")
        XCTAssertNil(FileViewerLogic.documentKind(forFileName: "data.csv"), "csv 는 기존 텍스트 뷰어")
        XCTAssertNil(FileViewerLogic.documentKind(forFileName: "notes.txt"))
        XCTAssertNil(FileViewerLogic.documentKind(forFileName: "photo.png"))
        XCTAssertNil(FileViewerLogic.documentKind(forFileName: "Makefile"), "점 없는 이름")
        XCTAssertNil(FileViewerLogic.documentKind(forFileName: ""))
    }

    func testDocumentSizeLimit() {
        XCTAssertEqual(FileViewerLogic.documentLimitBytes, 104_857_600)
        XCTAssertFalse(FileViewerLogic.exceedsDocumentLimit(size: nil), "크기를 모르면 서버(415)가 판단한다")
        XCTAssertFalse(FileViewerLogic.exceedsDocumentLimit(size: 0))
        XCTAssertFalse(FileViewerLogic.exceedsDocumentLimit(size: 104_857_600))
        XCTAssertTrue(FileViewerLogic.exceedsDocumentLimit(size: 104_857_601))
        XCTAssertTrue(FileViewerLogic.documentTooLargeMessage.contains("100 MiB 를 넘어 미리 볼 수 없습니다"))
    }

    func testCacheURLIsDeterministicAndKeepsFileName() throws {
        let path = "/Users/alice/work/app/분기 보고서.pdf"
        let url = FileViewerLogic.cacheURL(for: path, fileName: "분기 보고서.pdf")
        XCTAssertEqual(url, FileViewerLogic.cacheURL(for: path, fileName: "분기 보고서.pdf"), "같은 경로는 늘 같은 자리")
        XCTAssertEqual(url.lastPathComponent, "분기 보고서.pdf", "QuickLook 이 확장자로 형식을 정하므로 이름을 바꾸지 않는다")

        let other = FileViewerLogic.cacheURL(for: "/Users/alice/other/분기 보고서.pdf", fileName: "분기 보고서.pdf")
        XCTAssertNotEqual(url, other)
        XCTAssertNotEqual(url.deletingLastPathComponent(), other.deletingLastPathComponent(), "경로마다 폴더를 나눈다")

        let caches = try FileManager.default.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: false)
        XCTAssertTrue(url.path.hasPrefix(caches.appending(path: "mam-docs").path + "/"), url.path)
        XCTAssertEqual(url.deletingLastPathComponent().lastPathComponent.count, 16, "sha256 앞 16자")
        XCTAssertEqual(url.deletingLastPathComponent().deletingLastPathComponent().lastPathComponent, "mam-docs")
    }

    func testHwpUnavailableMessage() {
        let server = "한글(HWP) 변환기가 없습니다. Mac 에서 `python3 -m pip install --user pyhwp` 를 실행하세요."
        let message = FileViewerLogic.hwpUnavailableMessage(server)
        XCTAssertTrue(message.hasPrefix("한글(HWP) 변환기가 없습니다."), message)
        XCTAssertFalse(message.contains("`"), "백틱은 떼고 명령만 남긴다")
        XCTAssertTrue(message.contains("\npython3 -m pip install --user pyhwp\n"), "명령은 따로 줄에 둔다: \(message)")

        XCTAssertEqual(FileViewerLogic.hwpUnavailableMessage("변환기가 없습니다"), "변환기가 없습니다", "백틱이 없으면 서버 문구 그대로")
        XCTAssertEqual(FileViewerLogic.hwpUnavailableMessage("   "), FileViewerLogic.hwpConverterMissingMessage, "빈 문구는 기본 안내")
    }

    func testConverterUnavailableDetection() {
        XCTAssertTrue(FileViewerLogic.isConverterUnavailable(APIError.server(code: .agentUnavailable, message: "x", status: 501)))
        XCTAssertTrue(FileViewerLogic.isConverterUnavailable(APIError.server(code: .agentUnavailable, message: "x", status: 500)))
        XCTAssertFalse(FileViewerLogic.isConverterUnavailable(APIError.server(code: .internalError, message: "x", status: 500)))
        XCTAssertFalse(FileViewerLogic.isConverterUnavailable(URLError(.timedOut)))
    }
}
