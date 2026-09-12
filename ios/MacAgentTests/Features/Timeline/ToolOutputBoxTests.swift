import SwiftUI
import UIKit
import XCTest
@testable import MacAgent

/// 도구 출력 상자는 최대 240pt 안에서 스크롤되고(긴 출력이 이웃 카드를 덮지 않게), 짧은 출력은 내용만큼만 차지한다.
@MainActor
final class ToolOutputBoxTests: XCTestCase {
    private func host(_ view: some View) async throws -> (UIWindow, UIScrollView) {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let controller = UIHostingController(rootView: view)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        controller.view.layoutIfNeeded()
        // 프리퍼런스·지오메트리 갱신이 한 번 더 돌도록 런루프를 몇 번 넘긴다.
        for _ in 0..<5 {
            try await Task.sleep(for: .milliseconds(20))
            controller.view.layoutIfNeeded()
        }
        let scrollView = try XCTUnwrap(findScrollView(in: controller.view), "SwiftUI ScrollView 는 UIScrollView 로 그려진다")
        return (window, scrollView)
    }

    private func findScrollView(in view: UIView) -> UIScrollView? {
        if let scrollView = view as? UIScrollView { return scrollView }
        for sub in view.subviews {
            if let found = findScrollView(in: sub) { return found }
        }
        return nil
    }

    func testLongOutputStaysWithinMaxHeightAndScrolls() async throws {
        let output = (1...400).map { "line \($0): " + String(repeating: "x", count: 60) }.joined(separator: "\n")
        let (window, scrollView) = try await host(ToolOutputBox(output: output))
        defer { window.isHidden = true }

        XCTAssertLessThanOrEqual(scrollView.frame.height, ToolOutputBox.maxHeight + 1, "긴 출력도 상자 높이는 최대 240pt")
        XCTAssertGreaterThan(scrollView.frame.height, 100, "상자가 사라지면 안 된다")
        XCTAssertGreaterThan(scrollView.contentSize.height, ToolOutputBox.maxHeight, "내용은 상자보다 커서 세로 스크롤된다")
        XCTAssertGreaterThan(scrollView.contentSize.width, scrollView.frame.width, "긴 줄은 가로 스크롤")
    }

    func testShortOutputShrinksToContent() async throws {
        let (window, scrollView) = try await host(ToolOutputBox(output: "ok\ndone"))
        defer { window.isHidden = true }

        XCTAssertLessThan(scrollView.frame.height, 100, "짧은 출력은 내용만큼만")
        XCTAssertGreaterThan(scrollView.frame.height, 20)
        XCTAssertLessThanOrEqual(scrollView.contentSize.height, scrollView.frame.height + 1, "짧으면 세로 스크롤 없음")
    }
}
