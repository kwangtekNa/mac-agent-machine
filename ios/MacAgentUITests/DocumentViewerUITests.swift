import XCTest

/// IOS.md 10.10(Phase `8-document-viewer`)의 UI 테스트. `MAM_UI_TEST_SERVER` 와 `MAM_UI_TEST_REPO`
/// (`bash scripts/dev-smoke.sh --keep` 이 출력하는 git 저장소. 24단계가 그 안에 `sample.pdf`·`sample.hwpx` 를 만든다)
/// 가 없으면 `XCTSkip`. 흐름: 새 세션(cwd = 저장소) → "파일" 탭 → `sample.pdf` 탭 → QuickLook 문서 뷰
/// → "닫기" → `sample.hwpx` 탭 → 웹 뷰에 "안녕하세요" → "닫기".
/// `MAM_UI_TEST_SHOTS` 가 없으면 스크린샷을 xcresult 첨부로 남긴다.
final class DocumentViewerUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testOpensPdfInQuickLookAndHwpxAsHtml() throws {
        let server = ProcessInfo.processInfo.environment["MAM_UI_TEST_SERVER"] ?? ""
        try XCTSkipIf(server.isEmpty, "MAM_UI_TEST_SERVER 가 없어 건너뜁니다")
        let repo = ProcessInfo.processInfo.environment["MAM_UI_TEST_REPO"] ?? ""
        try XCTSkipIf(repo.isEmpty, "MAM_UI_TEST_REPO 가 없어 건너뜁니다")
        let shots = ProcessInfo.processInfo.environment["MAM_UI_TEST_SHOTS"] ?? ""
        // 스모크 24단계가 저장소 안에 만들어 커밋한다(없으면 서버가 오래된 것이다).
        for name in ["sample.pdf", "sample.hwpx"] {
            XCTAssertTrue(
                FileManager.default.fileExists(atPath: "\(repo)/\(name)"),
                "\(repo)/\(name) 가 없습니다. dev-smoke.sh --keep 을 다시 띄우세요"
            )
        }

        let app = XCUIApplication()
        app.launchEnvironment["MAM_UI_TEST_SERVER"] = server
        app.launch()

        // 세션 홈 "+" → "새 세션" → Claude → 직접 입력에 저장소 경로.
        let add = app.buttons.matching(NSPredicate(format: "identifier == 'home.add' OR label == '추가'")).firstMatch
        XCTAssertTrue(add.waitForExistence(timeout: 30), "세션 홈이 열리지 않았습니다")
        add.tap()
        let newSession = app.buttons["새 세션"]
        XCTAssertTrue(newSession.waitForExistence(timeout: 10), "+ 메뉴에 새 세션 항목이 없습니다")
        newSession.tap()

        let claude = app.buttons["Claude"]
        if claude.waitForExistence(timeout: 5) {
            claude.tap()
        }

        let pathField = app.textFields["newSession.customPath"]
        if !pathField.waitForExistence(timeout: 2) {
            let toggle = app.buttons["newSession.customToggle"]
            XCTAssertTrue(toggle.waitForExistence(timeout: 5), "'직접 입력' 버튼이 없습니다")
            toggle.tap()
        }
        XCTAssertTrue(pathField.waitForExistence(timeout: 5))
        // "직접 입력" 을 펼치면 이미 고른 경로가 들어 있다(NewSessionForm.setShowsCustomInput). 지우고 저장소 경로만 남긴다.
        pathField.tap()
        clear(pathField)
        pathField.typeText(repo)
        XCTAssertEqual(pathField.value as? String, repo, "직접 입력에 저장소 경로가 그대로 들어가지 않았습니다")

        // Form 은 지연 생성이라 화면 밖의 "세션 시작" 행은 트리에 없다.
        let start = app.buttons["세션 시작"]
        if !start.waitForExistence(timeout: 2) {
            app.swipeUp()
        }
        XCTAssertTrue(start.waitForExistence(timeout: 10), "'세션 시작' 버튼이 없습니다\n\(tree(app))")
        if !start.isHittable {
            app.swipeUp()
        }
        start.tap()

        // 타임라인 → "파일" 탭(세션 cwd = 저장소).
        let input = app.descendants(matching: .any).matching(identifier: "composer.input").firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 30), "타임라인이 열리지 않았습니다\n\(tree(app))")
        let filesTab = segment(app, identifier: "timeline.tab.files", labelPrefix: "파일")
        XCTAssertTrue(filesTab.waitForExistence(timeout: 10), "'파일' 세그먼트가 없습니다\n\(tree(app))")
        filesTab.tap()

        // sample.pdf → 원본을 내려받아 QuickLook.
        let pdfRow = fileRow(app, name: "sample.pdf")
        XCTAssertTrue(pdfRow.waitForExistence(timeout: 20), "파일 목록에 sample.pdf 가 없습니다\n\(tree(app))")
        pdfRow.tap()
        // 원본을 내려받아 QLPreviewController 가 그린다(시스템 뷰의 식별자).
        XCTAssertTrue(
            app.otherElements["QLPreviewControllerView"].waitForExistence(timeout: 60),
            "QuickLook 문서 뷰가 열리지 않았습니다\n\(tree(app))"
        )
        // 스모크 24단계가 PDF 1페이지에 그려 넣은 본문(minimalPdf("MacAgent PDF")).
        XCTAssertTrue(
            app.staticTexts["MacAgent PDF"].firstMatch.waitForExistence(timeout: 30),
            "PDF 페이지 본문이 보이지 않습니다\n\(tree(app))"
        )
        capture(app, shots, "1-quicklook-pdf")

        // 파일 탭은 파일을 시트로 연다(IOS.md 9.1) — 닫기로 목록으로 돌아온다.
        close(app)
        XCTAssertTrue(pdfRow.waitForExistence(timeout: 10), "파일 목록으로 돌아오지 않았습니다\n\(tree(app))")

        // sample.hwpx → 서버가 변환한 HTML 을 웹 뷰로.
        let hwpxRow = fileRow(app, name: "sample.hwpx")
        XCTAssertTrue(hwpxRow.waitForExistence(timeout: 10), "파일 목록에 sample.hwpx 가 없습니다\n\(tree(app))")
        hwpxRow.tap()
        let greeting = app.webViews.staticTexts["안녕하세요"].firstMatch
        XCTAssertTrue(greeting.waitForExistence(timeout: 30), "한글 문서 웹 뷰에 '안녕하세요' 가 없습니다\n\(tree(app))")
        capture(app, shots, "2-hwpx-html")

        close(app)
        XCTAssertTrue(hwpxRow.waitForExistence(timeout: 10), "파일 목록으로 돌아오지 않았습니다\n\(tree(app))")
    }

    /// 텍스트 필드를 비운다. 긴 경로는 필드 밖으로 넘쳐 커서가 중간에 놓이므로,
    /// 오른쪽 끝을 눌러 커서를 뒤로 보내고 지우기를 값이 빌 때까지 되풀이한다(플레이스홀더면 빈 값).
    private func clear(_ field: XCUIElement, placeholder: String = "~/work/my-app") {
        for _ in 0..<12 {
            guard let current = field.value as? String, !current.isEmpty, current != placeholder else { return }
            field.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: min(current.count, 40)))
        }
    }

    /// 파일 브라우저의 한 행. 행 전체가 버튼이지만 iOS 버전에 따라 셀·정적 텍스트로 노출되기도 한다.
    /// `NSPredicate` 는 Sendable 이 아니라 호출마다 새로 만든다(Swift 6 strict concurrency).
    private func fileRow(_ app: XCUIApplication, name: String) -> XCUIElement {
        let button = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", name)).firstMatch
        if button.exists { return button }
        let cell = app.cells.matching(NSPredicate(format: "label CONTAINS %@", name)).firstMatch
        if cell.exists { return cell }
        return app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", name)).firstMatch
    }

    /// 파일 뷰어 시트의 "닫기".
    private func close(_ app: XCUIApplication) {
        let button = app.buttons["닫기"].firstMatch
        XCTAssertTrue(button.waitForExistence(timeout: 10), "'닫기' 버튼이 없습니다\n\(tree(app))")
        button.tap()
    }

    /// 세그먼트 피커의 한 칸. 식별자가 세그먼트에 전달되지 않는 iOS 버전도 있어 라벨("파일", "파일 3")로도 찾는다.
    private func segment(_ app: XCUIApplication, identifier: String, labelPrefix: String) -> XCUIElement {
        let byId = app.buttons[identifier].firstMatch
        if byId.exists { return byId }
        return app.segmentedControls.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", labelPrefix)).firstMatch
    }

    /// 실패 메시지용 요소 트리 요약(버튼·텍스트·셀·기타 요소, 앞부분).
    private func tree(_ app: XCUIApplication) -> String {
        let lines = app.debugDescription.split(separator: "\n").filter {
            $0.contains("Button") || $0.contains("StaticText") || $0.contains("Cell") || $0.contains("Other") || $0.contains("WebView")
        }
        return lines.prefix(60).joined(separator: "\n")
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
