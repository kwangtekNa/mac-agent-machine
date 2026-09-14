import QuickLook
import SwiftUI
import UIKit
import WebKit
import XCTest
@testable import MacAgent

/// 문서 뷰어(QuickLook · 서버 변환 HTML)의 호스팅 검증. ADR-012: 새 패키지 없이 시스템 프레임워크만 쓴다.
@MainActor
final class DocumentViewTests: XCTestCase {
    private func host(_ view: some View) -> (UIWindow, UIViewController) {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
        let controller = UIHostingController(rootView: view)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        controller.view.layoutIfNeeded()
        return (window, controller)
    }

    private func findView<T: UIView>(_ type: T.Type, in view: UIView) -> T? {
        if let match = view as? T { return match }
        for sub in view.subviews {
            if let found = findView(type, in: sub) { return found }
        }
        return nil
    }

    private func findController<T: UIViewController>(_ type: T.Type, in controller: UIViewController) -> T? {
        if let match = controller as? T { return match }
        for child in controller.children {
            if let found = findController(type, in: child) { return found }
        }
        return nil
    }

    private func rendered() throws -> FsRenderResponse {
        try JSONCoding.decoder.decode(FsRenderResponse.self, from: try FixtureLoader.data("rest/fs-render.json"))
    }

    // MARK: - HTML(한글 문서)

    func testHTMLDocumentViewHostsWebViewWithJavaScriptDisabled() throws {
        let (window, controller) = host(HTMLDocumentView(document: try rendered()))
        defer { window.isHidden = true }
        let webView = try XCTUnwrap(findView(WKWebView.self, in: controller.view), "WKWebView 가 보여야 한다")
        XCTAssertFalse(
            webView.configuration.defaultWebpagePreferences.allowsContentJavaScript,
            "변환 HTML 에서 스크립트를 돌리지 않는다"
        )
        XCTAssertNotNil(webView.navigationDelegate, "링크 탭을 가로챌 델리게이트가 필요하다")
    }

    func testHTMLDocumentInjectsColorSchemeAndKeepsServerHTML() throws {
        let body = try rendered().html
        let document = HTMLDocumentView.document(html: body)
        XCTAssertTrue(document.contains("color-scheme: light dark"), "다크 모드는 CSS 로 따라간다")
        XCTAssertTrue(document.hasSuffix(body), "서버 HTML 은 그대로 두고 앞에만 주입한다")
        XCTAssertFalse(document.contains("<script"), "스크립트를 넣지 않는다")
    }

    func testLinkNavigationIsIgnored() {
        XCTAssertTrue(HTMLDocumentView.allowsNavigation(.other), "loadHTMLString 자체는 허용")
        XCTAssertFalse(HTMLDocumentView.allowsNavigation(.linkActivated), "링크 탭은 무시(외부 브라우저로 넘기지 않는다)")
        XCTAssertFalse(HTMLDocumentView.allowsNavigation(.formSubmitted))
    }

    func testWarningBanner() {
        XCTAssertNil(HTMLDocumentView.warningText([]))
        XCTAssertEqual(
            HTMLDocumentView.warningText(["변환하지 않은 요소: 수식", "이미지를 뺐습니다"]),
            "일부 요소는 표시되지 않았습니다: 변환하지 않은 요소: 수식, 이미지를 뺐습니다"
        )
    }

    // MARK: - QuickLook

    func testQuickLookViewHostsPreviewController() throws {
        let url = FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString).txt")
        try Data("hello".utf8).write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }

        let (window, controller) = host(QuickLookView(url: url))
        defer { window.isHidden = true }
        let preview = try XCTUnwrap(findController(QLPreviewController.self, in: controller), "QLPreviewController 가 임베드돼야 한다")
        XCTAssertEqual(preview.dataSource?.numberOfPreviewItems(in: preview), 1)
        let item = preview.dataSource?.previewController(preview, previewItemAt: 0)
        XCTAssertEqual(item?.previewItemURL, url)
    }
}
