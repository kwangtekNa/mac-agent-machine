import XCTest

/// IOS.md 9절(Phase `2-usage-and-files`)의 UI 테스트. `MAM_UI_TEST_SERVER` 가 없으면 건너뛴다(ApprovalFlowUITests 와 같은 규칙).
/// 새 세션 → "찾아보기"(홈에서 시작) → 새 폴더 `ui-<timestamp>` → "이 폴더 선택" → 세션 시작
/// → "파일" 탭이 빈 폴더를 보여줌 → "대화" 로 돌아와 "hello" → 허용 → 제목 아래 "컨텍스트 …" 부제
/// → 세션 정보 시트의 "사용량" 섹션에 "턴" 행.
/// 새 폴더는 테스트가 끝나면 지운다(시뮬레이터 프로세스는 호스트 파일시스템을 쓴다). `MAM_UI_TEST_SHOTS` 가 없으면 스크린샷을 xcresult 첨부로 남긴다.
final class UsageAndFilesUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testBrowseNewFolderThenUsageGaugeAndSheet() throws {
        let server = ProcessInfo.processInfo.environment["MAM_UI_TEST_SERVER"] ?? ""
        try XCTSkipIf(server.isEmpty, "MAM_UI_TEST_SERVER 가 없어 건너뜁니다")
        let shots = ProcessInfo.processInfo.environment["MAM_UI_TEST_SHOTS"] ?? ""
        let folderName = "ui-\(Int(Date().timeIntervalSince1970))"

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

        let claude = app.buttons["Claude"]
        if claude.waitForExistence(timeout: 5) {
            claude.tap()
        }

        // 직접 입력에 "~" 를 넣어 찾아보기가 항상 홈에서 시작하게 한다(미리 선택된 프로젝트가 지워진 스모크 임시 디렉토리일 수 있다).
        let pathField = app.textFields["newSession.customPath"]
        if !pathField.waitForExistence(timeout: 2) {
            let toggle = app.buttons["newSession.customToggle"]
            XCTAssertTrue(toggle.waitForExistence(timeout: 5), "'직접 입력' 버튼이 없습니다")
            toggle.tap()
        }
        XCTAssertTrue(pathField.waitForExistence(timeout: 5))
        pathField.tap()
        pathField.typeText("~")

        // 찾아보기 → 디렉토리 피커(홈 루트).
        let browse = app.buttons["newSession.browse"]
        XCTAssertTrue(browse.waitForExistence(timeout: 5), "'찾아보기' 버튼이 없습니다")
        browse.tap()
        let newFolder = app.buttons["directoryPicker.newFolder"].firstMatch
        XCTAssertTrue(newFolder.waitForExistence(timeout: 30), "디렉토리 피커가 열리지 않았습니다")
        XCTAssertTrue(waitUntil(timeout: 15) { newFolder.isEnabled }, "홈 목록이 로드되지 않았습니다")

        let currentPath = app.staticTexts["directoryPicker.currentPath"].firstMatch
        XCTAssertTrue(currentPath.waitForExistence(timeout: 10), "피커 하단 경로 캡션이 없습니다")
        capture(app, shots, "1-picker")

        // 새 폴더 → 이름 입력 → 만들기 → 만든 폴더로 들어간다.
        newFolder.tap()
        let alert = app.alerts["새 폴더"]
        XCTAssertTrue(alert.waitForExistence(timeout: 5), "새 폴더 알림이 없습니다")
        let nameField = alert.textFields.firstMatch.exists ? alert.textFields.firstMatch : app.textFields.firstMatch
        XCTAssertTrue(nameField.waitForExistence(timeout: 5), "새 폴더 이름 필드가 없습니다")
        nameField.tap()
        nameField.typeText(folderName)
        alert.buttons["만들기"].tap()
        XCTAssertTrue(waitUntil(timeout: 15) { currentPath.label.hasSuffix("/\(folderName)") }, "새 폴더로 들어가지 않았습니다: \(currentPath.label)")
        let createdPath = currentPath.label
        addTeardownBlock {
            // 시뮬레이터 프로세스는 호스트 파일시스템에 접근한다. 실패해도 테스트 결과에는 영향 없음.
            try? FileManager.default.removeItem(atPath: createdPath)
        }
        XCTAssertTrue(app.staticTexts["하위 폴더 없음"].firstMatch.waitForExistence(timeout: 10), "새 폴더가 비어 있지 않습니다")

        // 이 폴더 선택 → 새 세션 시트의 선택 경로에 반영.
        let pick = app.buttons["directoryPicker.pick"].firstMatch
        XCTAssertTrue(waitUntil(timeout: 10) { pick.isEnabled }, "'이 폴더 선택' 이 활성화되지 않았습니다")
        pick.tap()
        let selected = app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier == %@ AND label CONTAINS %@", "newSession.selectedPath", folderName)
        ).firstMatch
        XCTAssertTrue(selected.waitForExistence(timeout: 10), "선택한 경로가 시트에 반영되지 않았습니다")
        capture(app, shots, "2-new-session")

        // Form 은 지연 생성이라 화면 밖의 "세션 시작" 행은 트리에 없다. 아래로 스크롤해 드러낸다.
        let start = app.buttons["세션 시작"]
        if !start.waitForExistence(timeout: 2) {
            app.swipeUp()
        }
        XCTAssertTrue(start.waitForExistence(timeout: 10), "'세션 시작' 버튼이 없습니다\n\(tree(app))")
        if !start.isHittable {
            app.swipeUp()
        }
        start.tap()

        // 타임라인 → "파일" 탭: 세션 cwd(방금 만든 빈 폴더).
        let input = app.descendants(matching: .any).matching(identifier: "composer.input").firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 30), "타임라인이 열리지 않았습니다")
        let filesTab = segment(app, identifier: "timeline.tab.files", labelPrefix: "파일")
        XCTAssertTrue(filesTab.waitForExistence(timeout: 10), "'파일' 세그먼트가 없습니다\n\(tree(app))")
        filesTab.tap()
        // 파일 탭은 바깥 NavigationStack 안에서 제자리 탐색이라 세션 화면이 그대로 남아야 한다(컴포저가 계속 보인다).
        XCTAssertTrue(app.staticTexts["비어 있는 폴더"].firstMatch.waitForExistence(timeout: 20), "파일 탭이 빈 폴더를 보여주지 않습니다\n\(tree(app))")
        XCTAssertTrue(input.exists, "파일 탭에서도 컴포저가 남아 있어야 합니다")
        capture(app, shots, "3-files-tab")

        // "대화" 로 돌아와 hello → 허용 → 완료.
        let chatTab = segment(app, identifier: "timeline.tab.chat", labelPrefix: "대화")
        XCTAssertTrue(chatTab.waitForExistence(timeout: 5), "'대화' 세그먼트가 없습니다")
        chatTab.tap()
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        input.tap()
        input.typeText("hello")
        let send = app.buttons["composer.send"]
        XCTAssertTrue(send.waitForExistence(timeout: 5))
        send.tap()
        let allow = app.buttons.matching(NSPredicate(format: "label == %@", "허용")).firstMatch
        XCTAssertTrue(allow.waitForExistence(timeout: 30), "승인 배너의 허용 버튼이 없습니다")
        allow.tap()
        let summary = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "초 ·")).firstMatch
        XCTAssertTrue(summary.waitForExistence(timeout: 30), "완료 행(turn_summary)이 없습니다")

        // 제목 아래 부제가 "컨텍스트 N% · a/b" 로 바뀐다(IOS.md 9.3). 게이지는 접근성 요소 하나로 합쳐져 라벨에 부제가 들어간다.
        let gauge = app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier == %@ AND label CONTAINS %@", "timeline.contextGauge", "컨텍스트")
        ).firstMatch
        XCTAssertTrue(gauge.waitForExistence(timeout: 30), "제목 아래 '컨텍스트' 부제가 없습니다\n\(tree(app))")
        capture(app, shots, "4-context-gauge")

        // 게이지 탭 → 세션 정보 시트 → "사용량" 섹션의 "턴" 행.
        gauge.tap()
        XCTAssertTrue(app.staticTexts["사용량"].firstMatch.waitForExistence(timeout: 15), "세션 정보 시트의 '사용량' 섹션이 없습니다")
        let turns = app.descendants(matching: .any).matching(
            NSPredicate(format: "label == %@ OR label BEGINSWITH %@", "턴", "턴,")
        ).firstMatch
        XCTAssertTrue(turns.waitForExistence(timeout: 15), "'사용량' 섹션에 '턴' 행이 없습니다\n\(tree(app))")
        capture(app, shots, "5-session-info")
    }

    /// 세그먼트 피커의 한 칸. 식별자가 세그먼트에 전달되지 않는 iOS 버전도 있어 라벨("파일", "파일 3")로도 찾는다.
    private func segment(_ app: XCUIApplication, identifier: String, labelPrefix: String) -> XCUIElement {
        let byId = app.buttons[identifier].firstMatch
        if byId.exists { return byId }
        return app.segmentedControls.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", labelPrefix)).firstMatch
    }

    /// 실패 메시지용 요소 트리 요약(버튼·텍스트·셀만, 앞부분).
    private func tree(_ app: XCUIApplication) -> String {
        let lines = app.debugDescription.split(separator: "\n").filter { $0.contains("Button") || $0.contains("StaticText") || $0.contains("Cell") || $0.contains("Segmented") }
        return lines.prefix(60).joined(separator: "\n")
    }

    private func waitUntil(timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        return condition()
    }

    private func capture(_ app: XCUIApplication, _ dir: String, _ name: String) {
        let screenshot = app.screenshot()
        guard !dir.isEmpty else {
            let attachment = XCTAttachment(screenshot: screenshot)
            attachment.name = name
            attachment.lifetime = .keepAlways
            add(attachment)
            return
        }
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: "\(dir)/\(name).png", contents: screenshot.pngRepresentation)
    }
}
