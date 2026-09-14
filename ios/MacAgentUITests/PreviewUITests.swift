import XCTest

/// IOS.md 12절(미리보기)의 UI 테스트. `MAM_UI_TEST_SERVER`(예: `bash scripts/dev-smoke.sh --keep` 의 http://127.0.0.1:7777) 가 없으면 건너뛴다.
///
/// 새 세션 → "serve 3456"(Fake 어댑터가 답변에 `http://localhost:3456/` 링크를 넣는다) → 승인 허용 →
/// 답변 카드의 링크 탭 → 앱 안 브라우저(`SFSafariViewController`: `OpenInSafariButton` + 닫기 버튼) → 닫기 →
/// 툴바 `timeline.preview` → 미리보기 시트의 "열린 포트" 섹션(행이 있으면 행, 없으면 빈 문구) → 완료.
/// 링크가 실제로 열리는지(3456 에 서버가 있는지)는 보지 않는다 — Fake 는 서버를 띄우지 않는다.
final class PreviewUITests: XCTestCase {
    /// Fake 어댑터가 답변에 넣는 링크(`serve <포트>`).
    private let servePort = 3456

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testServeLinkOpensInAppBrowserAndPreviewSheetListsPorts() throws {
        let server = ProcessInfo.processInfo.environment["MAM_UI_TEST_SERVER"] ?? ""
        try XCTSkipIf(server.isEmpty, "MAM_UI_TEST_SERVER 가 없어 건너뜁니다")

        let app = XCUIApplication()
        app.launchEnvironment["MAM_UI_TEST_SERVER"] = server
        app.launch()

        startSession(app)

        // 컴포저에 "serve 3456" → 보내기.
        let input = app.descendants(matching: .any).matching(identifier: "composer.input").firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 30), "타임라인이 열리지 않았습니다")
        input.tap()
        input.typeText("serve \(servePort)")
        let send = app.buttons["composer.send"]
        XCTAssertTrue(send.waitForExistence(timeout: 5))
        send.tap()

        // 승인 배너 "허용"(새 세션 기본 모드는 ask). 배너를 치워야 답변 카드가 가려지지 않는다.
        let allow = app.buttons.matching(NSPredicate(format: "label == %@", "허용")).firstMatch
        XCTAssertTrue(allow.waitForExistence(timeout: 30), "승인 배너의 허용 버튼이 없습니다")
        allow.tap()

        // 답변 카드의 localhost 링크. 카드 자체는 합쳐진 접근성 요소지만 마크다운 링크는 Link 로 남는다.
        let link = app.links["http://localhost:\(servePort)/"]
        XCTAssertTrue(link.waitForExistence(timeout: 30), "답변 카드에 localhost 링크가 없습니다")
        link.tap()

        // 앱 안 브라우저: `OpenInSafariButton` 은 SFSafariViewController 만 갖는 식별자다.
        XCTAssertTrue(
            app.buttons["OpenInSafariButton"].waitForExistence(timeout: 20),
            "링크를 눌러도 앱 안 브라우저(SFSafariViewController)가 뜨지 않았습니다"
        )
        let close = app.buttons.matching(NSPredicate(format: "label IN {'닫기', '완료', 'Close', 'Done'}")).firstMatch
        XCTAssertTrue(close.waitForExistence(timeout: 10), "앱 안 브라우저에 닫기 버튼이 없습니다")
        close.tap()
        XCTAssertTrue(input.waitForExistence(timeout: 10), "브라우저를 닫아도 타임라인으로 돌아오지 않았습니다")

        // 툴바 "미리보기" → 열린 포트 시트.
        let preview = app.buttons["timeline.preview"]
        XCTAssertTrue(preview.waitForExistence(timeout: 20), "타임라인 툴바에 미리보기 버튼이 없습니다")
        preview.tap()
        XCTAssertTrue(app.staticTexts["열린 포트"].waitForExistence(timeout: 10), "미리보기 시트에 '열린 포트' 섹션이 없습니다")

        // 서버(내 macOS 계정)가 띄운 포트가 있으면 행이, 없으면 빈 문구가 있어야 한다.
        // "직접 입력"·"최근" 섹션은 목록이 길면 화면 밖이라(List 는 지연 생성) 여기서 보지 않는다 — PreviewPortsSheetStateTests 가 규칙을 검증한다.
        let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'preview.port.'")).firstMatch
        let empty = app.staticTexts["preview.empty"]
        XCTAssertTrue(
            row.waitForExistence(timeout: 15) || empty.exists,
            "열린 포트 섹션에 행도 빈 문구도 없습니다"
        )

        let done = app.buttons.matching(NSPredicate(format: "label == %@", "완료")).firstMatch
        XCTAssertTrue(done.waitForExistence(timeout: 5), "미리보기 시트에 완료 버튼이 없습니다")
        done.tap()
        XCTAssertTrue(input.waitForExistence(timeout: 10), "시트를 닫아도 타임라인으로 돌아오지 않았습니다")
    }

    // MARK: - 도우미

    /// 세션 홈 → "+" → 새 세션 → Claude → `~/.mam` → 세션 시작. ApprovalFlowUITests 와 같은 절차다.
    private func startSession(_ app: XCUIApplication) {
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

        // 디렉토리는 "직접 입력" 에 `~/.mam`. 미리 채워진 긴 경로는 끝을 다시 탭하며 비운다(ApprovalFlowUITests 와 같은 이유).
        let pathField = app.textFields["newSession.customPath"]
        if !pathField.waitForExistence(timeout: 2) {
            let toggle = app.buttons["newSession.customToggle"]
            XCTAssertTrue(toggle.waitForExistence(timeout: 5), "'직접 입력' 버튼이 없습니다")
            toggle.tap()
        }
        XCTAssertTrue(pathField.waitForExistence(timeout: 5))
        for _ in 0..<6 {
            pathField.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
            guard let existing = pathField.value as? String, !existing.isEmpty, existing != "~/work/my-app" else { break }
            pathField.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing.count + 4))
        }
        pathField.typeText("~/.mam")

        let start = app.buttons["세션 시작"]
        if !start.waitForExistence(timeout: 2) {
            app.swipeUp()
        }
        XCTAssertTrue(start.waitForExistence(timeout: 10), "'세션 시작' 버튼이 없습니다")
        if !start.isHittable {
            app.swipeUp()
        }
        start.tap()
    }
}
