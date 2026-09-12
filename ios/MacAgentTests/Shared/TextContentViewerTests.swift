import SwiftUI
import UIKit
import XCTest
@testable import MacAgent

/// 전체 화면 텍스트 뷰어: 도구 출력·입력 JSON 은 UITextView(가로 스크롤, 선택 가능)로 전문을 보여주고, diff 는 줄 색 뷰로 보여준다.
/// 카드 쪽의 더블 탭·펼침 버튼은 여기서 검증하지 않는다. 이유: SwiftUI 는 보조 기술이 붙어 있을 때만 접근성 트리를 만들어
/// UIHostingController 단위 테스트에서는 버튼 요소가 노출되지 않는다(요소 수 0). 카드는 접근성 요소가 하나로 합쳐져
/// XCUITest 로도 내부 버튼을 누를 수 없으므로 실기기·시뮬레이터에서 손으로 확인한다.
@MainActor
final class TextContentViewerTests: XCTestCase {
    private let longOutput = (1...300).map { "line \($0): " + String(repeating: "y", count: 80) }.joined(separator: "\n")

    private func host(_ view: some View) async throws -> (UIWindow, UIViewController) {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let controller = UIHostingController(rootView: view)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        controller.view.layoutIfNeeded()
        for _ in 0..<5 {
            try await Task.sleep(for: .milliseconds(20))
            controller.view.layoutIfNeeded()
        }
        return (window, controller)
    }

    private func find<T: UIView>(_ type: T.Type, in view: UIView) -> T? {
        if let match = view as? T { return match }
        for sub in view.subviews {
            if let found = find(type, in: sub) { return found }
        }
        return nil
    }

    func testContentRules() {
        XCTAssertEqual(TextContentViewer.Content.text("a\nb").rawText, "a\nb")
        XCTAssertEqual(TextContentViewer.Content.code("{\"a\":1}", language: "json").rawText, "{\"a\":1}")
        XCTAssertEqual(TextContentViewer.Content.diff("+x\n-y").rawText, "+x\n-y")
        XCTAssertTrue(TextContentViewer.Content.text("a").allowsWrapToggle)
        XCTAssertTrue(TextContentViewer.Content.code("{}", language: "json").allowsWrapToggle)
        XCTAssertFalse(TextContentViewer.Content.diff("+x").allowsWrapToggle, "diff 는 줄 단위 색 뷰라 줄바꿈 토글이 없다")
    }

    func testTextContentShowsFullOutputInScrollableTextView() async throws {
        let (window, controller) = try await host(
            TextContentViewer(title: "npm test", subtitle: "도구 출력", content: .text(longOutput), truncated: true)
        )
        defer { window.isHidden = true }

        let textView = try XCTUnwrap(find(UITextView.self, in: controller.view), "출력 전문은 UITextView 로 그린다")
        XCTAssertEqual(textView.text, longOutput)
        XCTAssertTrue(textView.isSelectable)
        XCTAssertFalse(textView.isEditable)
        XCTAssertTrue(textView.isScrollEnabled)
        textView.layoutIfNeeded()
        XCTAssertGreaterThan(textView.contentSize.width, textView.bounds.width, "기본은 줄바꿈 없이 가로 스크롤")
    }

    func testCodeContentShowsSameTextInTextView() async throws {
        let json = "{\n  \"command\": \"npm test\",\n  \"timeout\": 120000\n}"
        let (window, controller) = try await host(
            TextContentViewer(title: "npm test", subtitle: "도구 입력", content: .code(json, language: "json"), truncated: false)
        )
        defer { window.isHidden = true }
        let textView = try XCTUnwrap(find(UITextView.self, in: controller.view), "입력 JSON 도 UITextView 로 그린다")
        XCTAssertEqual(textView.text, json)
    }

    func testDiffContentDoesNotUsePlainTextView() async throws {
        let (window, controller) = try await host(
            TextContentViewer(title: "파일 1개 변경", subtitle: "변경 내용", content: .diff("--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y"), truncated: false)
        )
        defer { window.isHidden = true }
        XCTAssertNil(find(UITextView.self, in: controller.view), "diff 는 DiffTextView(줄 색)로 그린다")
        XCTAssertNotNil(find(UIScrollView.self, in: controller.view), "세로 스크롤 안에 놓인다")
    }
}
