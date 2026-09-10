import SwiftUI
import UIKit
import XCTest
@testable import MacAgent

@MainActor
final class HighlightedCodeViewTests: XCTestCase {
    private let code = "import Foundation\n\nlet answer = 42 // \(String(repeating: "x", count: 400))\nfunc f() -> String { \"hi\" }\n"

    private func host(_ view: some View) -> (UIWindow, UITextView) {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
        let controller = UIHostingController(rootView: view)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        controller.view.layoutIfNeeded()
        let textView = findTextView(in: controller.view)!
        return (window, textView)
    }

    private func findTextView(in view: UIView) -> UITextView? {
        if let textView = view as? UITextView { return textView }
        for sub in view.subviews {
            if let found = findTextView(in: sub) { return found }
        }
        return nil
    }

    private func distinctColors(_ textView: UITextView) -> Int {
        var colors = Set<String>()
        textView.attributedText.enumerateAttribute(.foregroundColor, in: NSRange(location: 0, length: textView.attributedText.length)) { value, _, _ in
            if let color = value as? UIColor { colors.insert(color.description) }
        }
        return colors.count
    }

    func testHighlightIsAppliedInBackgroundAndScrollsHorizontally() async throws {
        let (window, textView) = host(HighlightedCodeView(text: code, language: "swift", highlightEnabled: true, wrapLines: false))
        defer { window.isHidden = true }
        XCTAssertEqual(textView.text, code, "plain 텍스트가 먼저 보인다")
        XCTAssertFalse(textView.isEditable)
        XCTAssertTrue(textView.isSelectable)

        var lightColors = 0
        for _ in 0..<50 where lightColors < 2 {
            try await Task.sleep(for: .milliseconds(100))
            lightColors = distinctColors(textView)
        }
        XCTAssertGreaterThanOrEqual(lightColors, 2, "키워드·문자열이 다른 색으로 칠해져야 한다")
        XCTAssertEqual(textView.text, code, "하이라이트 후에도 내용은 같다")
        textView.layoutIfNeeded()
        XCTAssertGreaterThan(textView.contentSize.width, textView.bounds.width, "줄바꿈 끔: 긴 줄은 가로로 스크롤")
    }

    func testPlainWhenHighlightDisabled() async throws {
        let (window, textView) = host(HighlightedCodeView(text: code, language: "swift", highlightEnabled: false, wrapLines: true))
        defer { window.isHidden = true }
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertLessThanOrEqual(distinctColors(textView), 1)
        XCTAssertEqual(textView.text, code)
        textView.layoutIfNeeded()
        XCTAssertEqual(textView.font?.fontName.contains("Mono") ?? false || textView.font?.familyName.lowercased().contains("mono") ?? false, true, "monospaced 시스템 폰트")
        XCTAssertLessThanOrEqual(textView.contentSize.width, textView.bounds.width + 1, "줄바꿈 켬: 가로 스크롤 없음")
    }
}
