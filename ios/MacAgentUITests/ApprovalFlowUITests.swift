import XCTest

/// IOS.md 8절의 UI 테스트 1개. `MAM_UI_TEST_SERVER`(예: `bash scripts/dev-smoke.sh --keep` 의 http://127.0.0.1:7777) 가 없으면 건너뛴다.
/// 연결 → 새 세션(Claude, `~/.mam`) → "hello" 전송 → 승인 배너 "허용" → "허용됨" → 완료 행("초 ·").
/// `MAM_UI_TEST_SHOTS` 에 디렉토리를 주면 단계별 스크린샷 PNG 를 남긴다(다크모드·Dynamic Type 점검용).
final class ApprovalFlowUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testHelloTurnIsApprovedFromBanner() throws {
        let server = ProcessInfo.processInfo.environment["MAM_UI_TEST_SERVER"] ?? ""
        try XCTSkipIf(server.isEmpty, "MAM_UI_TEST_SERVER 가 없어 건너뜁니다")
        let shots = ProcessInfo.processInfo.environment["MAM_UI_TEST_SHOTS"] ?? ""

        let app = XCUIApplication()
        app.launchEnvironment["MAM_UI_TEST_SERVER"] = server
        if let size = ProcessInfo.processInfo.environment["MAM_UI_TEST_CONTENT_SIZE"], !size.isEmpty {
            app.launchArguments += ["-UIPreferredContentSizeCategoryName", size]
        }
        app.launch()

        // 연결됨 → 세션 홈의 "+" (accessibilityLabel "새 세션").
        let newSession = app.buttons["새 세션"]
        XCTAssertTrue(newSession.waitForExistence(timeout: 30), "세션 홈이 열리지 않았습니다")
        newSession.tap()

        // 에이전트 Claude.
        let claude = app.buttons["Claude"]
        if claude.waitForExistence(timeout: 5) {
            claude.tap()
        }

        // 디렉토리: "직접 입력" 에 ~/.mam (agent-host 가 시작 시 만드는 디렉토리). 프로젝트가 없으면 입력 필드가 바로 열려 있다.
        let pathField = app.textFields["newSession.customPath"]
        if !pathField.waitForExistence(timeout: 2) {
            let toggle = app.buttons["newSession.customToggle"]
            XCTAssertTrue(toggle.waitForExistence(timeout: 5), "'직접 입력' 버튼이 없습니다")
            toggle.tap()
        }
        XCTAssertTrue(pathField.waitForExistence(timeout: 5))
        pathField.tap()
        pathField.typeText("~/.mam")
        capture(app, shots, "1-new-session")

        app.buttons["세션 시작"].tap()

        // 컴포저에 hello → 보내기.
        let input = app.descendants(matching: .any).matching(identifier: "composer.input").firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 30), "타임라인이 열리지 않았습니다")
        input.tap()
        input.typeText("hello")
        let send = app.buttons["composer.send"]
        XCTAssertTrue(send.waitForExistence(timeout: 5))
        send.tap()

        // 승인 배너 "허용".
        let allow = app.buttons.matching(NSPredicate(format: "label == %@", "허용")).firstMatch
        XCTAssertTrue(allow.waitForExistence(timeout: 30), "승인 배너의 허용 버튼이 없습니다")
        capture(app, shots, "2-approval-banner")
        allow.tap()

        let resolved = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "허용됨")).firstMatch
        XCTAssertTrue(resolved.waitForExistence(timeout: 30), "허용됨 표시가 없습니다")
        let summary = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "초 ·")).firstMatch
        XCTAssertTrue(summary.waitForExistence(timeout: 30), "완료 행(turn_summary)이 없습니다")
        capture(app, shots, "3-completed")
    }

    private func capture(_ app: XCUIApplication, _ dir: String, _ name: String) {
        guard !dir.isEmpty else { return }
        let data = app.screenshot().pngRepresentation
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: "\(dir)/\(name).png", contents: data)
    }
}
