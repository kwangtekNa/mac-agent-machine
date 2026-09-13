import XCTest

/// IOS.md 10.7(Phase `5-git-init`)의 UI 테스트. `MAM_UI_TEST_SERVER` 가 없으면 건너뛴다(다른 세 UI 테스트와 같은 규칙).
///
/// 1) `testInitRepoFromPickerThenCreateTeam`: 홈 `+` → 새 팀 → 이름 → "찾아보기" → 새 폴더 `ui-git-<ts>` → 그 폴더에서 툴바
///    "저장소 초기화"(`directoryPicker.gitInit`) → 확인 다이얼로그(빈 폴더라 "빈 저장소") → "초기화" → 목록 위 "git 저장소를 만들었습니다"
///    안내 + 버튼 사라짐 → "이 폴더 선택" → 시트가 저장소로 받아들여 `newTeam.gitInit` 이 없음 → 팀장 민수(프리셋 팀장) → 팀 만들기
///    → 방 목록 `rooms.group`. 피커에서 초기화한 폴더는 시트에서 보통 저장소와 같이 취급되므로 "git 저장소 (main)" 캡션은 2) 가 확인한다.
/// 2) `testTypedPathShowsInitButtonThenReadyCaption`: 새 팀 시트의 "직접 입력" 에 새 빈 폴더 경로 → `newTeam.gitInit` 이 보임 → 확인 → 초기화
///    → "git 저장소 (main)"(`newTeam.gitReady`) 로 바뀌고 버튼이 사라진다. 폴더는 `MAM_UI_TEST_REPO` 의 부모(스모크 임시 디렉토리)에
///    `FileManager` 로 만든다(시뮬레이터 프로세스는 호스트 파일시스템을 쓴다). `MAM_UI_TEST_REPO` 가 없으면 건너뛴다.
///
/// 정리: REST 로 팀 삭제(보통 삭제, 409 면 `keepWorktrees=true`) + 만든 폴더 삭제. `MAM_UI_TEST_SHOTS` 가 없으면 스크린샷을 xcresult 첨부로 남긴다.
final class GitInitUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testInitRepoFromPickerThenCreateTeam() throws {
        let server = env("MAM_UI_TEST_SERVER")
        try XCTSkipIf(server.isEmpty, "MAM_UI_TEST_SERVER 가 없어 건너뜁니다")
        let shots = env("MAM_UI_TEST_SHOTS")
        let stamp = Int(Date().timeIntervalSince1970)
        let folderName = "ui-git-\(stamp)"
        let teamName = "ui-git-\(stamp)"

        let app = launch(server)
        openNewTeamSheet(app)
        typeTeamName(app, teamName)

        // 직접 입력을 "~" 로 바꿔 찾아보기가 항상 홈에서 시작하게 한다(미리 선택된 프로젝트가 저장소면 그 안에서는 초기화 버튼이 없다).
        let pathField = showCustomPathField(app)
        replaceText(in: pathField, placeholder: "~/work/my-app", with: "~")

        let browse = app.buttons["newTeam.browse"]
        XCTAssertTrue(browse.waitForExistence(timeout: 5), "'찾아보기' 버튼이 없습니다\n\(tree(app))")
        browse.tap()
        let newFolder = app.buttons["directoryPicker.newFolder"].firstMatch
        XCTAssertTrue(newFolder.waitForExistence(timeout: 30), "디렉토리 피커가 열리지 않았습니다")
        XCTAssertTrue(waitUntil(timeout: 15) { newFolder.isEnabled }, "홈 목록이 로드되지 않았습니다")
        let currentPath = app.staticTexts["directoryPicker.currentPath"].firstMatch
        XCTAssertTrue(currentPath.waitForExistence(timeout: 10), "피커 하단 경로 캡션이 없습니다")

        // 새 폴더 → 이름 → 만들기 → 만든 폴더로 들어간다(UsageAndFilesUITests 와 같은 패턴).
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
            // 팀을 먼저 지우고(worktree 가 저장소를 참조한다) 폴더를 지운다. 실패해도 테스트 결과에는 영향 없음.
            await Self.deleteTeam(named: teamName, cwd: createdPath, server: server)
            try? FileManager.default.removeItem(atPath: createdPath)
        }
        XCTAssertTrue(app.staticTexts["하위 폴더 없음"].firstMatch.waitForExistence(timeout: 10), "새 폴더가 비어 있지 않습니다")
        capture(app, shots, "1-picker-new-folder")

        // 툴바 "저장소 초기화" → 확인("빈 저장소") → 초기화 → 안내가 뜨고 버튼은 사라진다(목록을 다시 읽어 isGitRepo 가 true).
        let gitInit = app.buttons["directoryPicker.gitInit"].firstMatch
        XCTAssertTrue(gitInit.waitForExistence(timeout: 10), "피커 툴바에 '저장소 초기화' 버튼이 없습니다\n\(tree(app))")
        XCTAssertTrue(waitUntil(timeout: 5) { gitInit.isEnabled }, "'저장소 초기화' 가 활성화되지 않았습니다")
        gitInit.tap()
        confirmInit(app, shots: shots, shot: "2-picker-confirm")
        let notice = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "git 저장소를 만들었습니다")).firstMatch
        XCTAssertTrue(notice.waitForExistence(timeout: 30), "초기화 완료 안내가 목록에 없습니다\n\(tree(app))")
        XCTAssertTrue(waitUntil(timeout: 10) { !gitInit.exists }, "초기화 뒤에도 '저장소 초기화' 버튼이 남아 있습니다")
        capture(app, shots, "3-picker-initialized")

        // 이 폴더 선택 → 시트에 경로 반영. 시트는 GET /git/status 로 확인하고 저장소이므로 초기화 행을 띄우지 않는다.
        let pick = app.buttons["directoryPicker.pick"].firstMatch
        XCTAssertTrue(waitUntil(timeout: 10) { pick.isEnabled }, "'이 폴더 선택' 이 활성화되지 않았습니다")
        pick.tap()
        let selected = app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier == %@ AND label CONTAINS %@", "newTeam.selectedPath", folderName)
        ).firstMatch
        XCTAssertTrue(selected.waitForExistence(timeout: 10), "선택한 경로가 시트에 반영되지 않았습니다\n\(tree(app))")
        let sheetInit = app.buttons["newTeam.gitInit"]
        XCTAssertTrue(waitUntil(timeout: 10) { !sheetInit.exists }, "초기화한 폴더인데 시트가 '저장소 초기화' 를 보여줍니다\n\(tree(app))")
        XCTAssertFalse(waitUntil(timeout: 3) { sheetInit.exists }, "저장소 확인 뒤 '저장소 초기화' 행이 다시 나타났습니다\n\(tree(app))")

        addMember(app, name: "민수", agent: "Claude Code", rolePreset: "팀장", lead: true)
        capture(app, shots, "4-new-team")
        submitTeam(app)
        let groupRow = app.descendants(matching: .any).matching(identifier: "rooms.group").firstMatch
        XCTAssertTrue(groupRow.waitForExistence(timeout: 60), "방 목록이 열리지 않았습니다(초기화한 저장소로 팀 생성 실패)\n\(tree(app))")
        capture(app, shots, "5-rooms")
    }

    func testTypedPathShowsInitButtonThenReadyCaption() throws {
        let server = env("MAM_UI_TEST_SERVER")
        try XCTSkipIf(server.isEmpty, "MAM_UI_TEST_SERVER 가 없어 건너뜁니다")
        let repo = env("MAM_UI_TEST_REPO")
        try XCTSkipIf(repo.isEmpty, "MAM_UI_TEST_REPO 가 없어 건너뜁니다(새 폴더를 만들 호스트 경로를 모릅니다)")
        let shots = env("MAM_UI_TEST_SHOTS")
        // 스모크 임시 디렉토리(저장소 밖·홈 안)에 빈 폴더를 만든다.
        let folder = (repo as NSString).deletingLastPathComponent + "/ui-git-typed-\(Int(Date().timeIntervalSince1970))"
        try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
        addTeardownBlock {
            try? FileManager.default.removeItem(atPath: folder)
        }

        let app = launch(server)
        openNewTeamSheet(app)
        typeTeamName(app, "ui-git-typed")
        let pathField = showCustomPathField(app)
        replaceText(in: pathField, placeholder: "~/work/my-app", with: folder + "\n")

        // 입력이 멈추면(600ms) 저장소 여부를 확인하고 "저장소 초기화" 행이 나온다.
        let sheetInit = app.buttons["newTeam.gitInit"]
        XCTAssertTrue(sheetInit.waitForExistence(timeout: 20), "직접 입력한 빈 폴더에 '저장소 초기화' 행이 없습니다\n\(tree(app))")
        capture(app, shots, "typed-1-not-repo")
        XCTAssertTrue(waitUntil(timeout: 5) { sheetInit.isEnabled }, "'저장소 초기화' 가 활성화되지 않았습니다")
        sheetInit.tap()
        confirmInit(app, shots: shots, shot: "typed-2-confirm")
        let ready = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "git 저장소 (main)")).firstMatch
        XCTAssertTrue(ready.waitForExistence(timeout: 30), "초기화 뒤 'git 저장소 (main)' 캡션이 없습니다\n\(tree(app))")
        XCTAssertTrue(waitUntil(timeout: 5) { !sheetInit.exists }, "초기화 뒤에도 '저장소 초기화' 행이 남아 있습니다\n\(tree(app))")
        capture(app, shots, "typed-3-ready")
    }

    // MARK: - 단계 헬퍼

    private func env(_ name: String) -> String {
        ProcessInfo.processInfo.environment[name] ?? ""
    }

    private func launch(_ server: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["MAM_UI_TEST_SERVER"] = server
        if let size = ProcessInfo.processInfo.environment["MAM_UI_TEST_CONTENT_SIZE"], !size.isEmpty {
            app.launchArguments += ["-UIPreferredContentSizeCategoryName", size]
        }
        app.launch()
        return app
    }

    /// 연결됨 → 세션 홈의 "+" 메뉴 → "새 팀".
    private func openNewTeamSheet(_ app: XCUIApplication) {
        let add = app.buttons.matching(NSPredicate(format: "identifier == 'home.add' OR label == '추가'")).firstMatch
        XCTAssertTrue(add.waitForExistence(timeout: 30), "세션 홈이 열리지 않았습니다")
        add.tap()
        let newTeam = app.buttons.matching(NSPredicate(format: "identifier == 'home.newTeam' OR label == '새 팀'")).firstMatch
        XCTAssertTrue(newTeam.waitForExistence(timeout: 10), "+ 메뉴에 새 팀 항목이 없습니다")
        newTeam.tap()
    }

    private func typeTeamName(_ app: XCUIApplication, _ name: String) {
        let nameField = app.textFields["newTeam.name"]
        XCTAssertTrue(nameField.waitForExistence(timeout: 10), "새 팀 시트가 열리지 않았습니다")
        nameField.tap()
        nameField.typeText(name + "\n")
    }

    /// 새 팀 시트의 "직접 입력" 필드를 연다(프로젝트가 없으면 이미 열려 있다).
    private func showCustomPathField(_ app: XCUIApplication) -> XCUIElement {
        let pathField = app.textFields["newTeam.customPath"]
        if !pathField.waitForExistence(timeout: 2) {
            let toggle = app.buttons["newTeam.customToggle"]
            XCTAssertTrue(toggle.waitForExistence(timeout: 5), "'직접 입력' 버튼이 없습니다\n\(tree(app))")
            toggle.tap()
        }
        XCTAssertTrue(pathField.waitForExistence(timeout: 5), "직접 입력 필드가 없습니다")
        return pathField
    }

    /// 확인 다이얼로그(`confirmationDialog` "git 저장소를 만들까요?"): 빈 폴더라 본문에 "빈 저장소"(`GitInitFlow.confirmMessage`) → "초기화".
    private func confirmInit(_ app: XCUIApplication, shots: String, shot: String) {
        let message = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "빈 저장소")).firstMatch
        XCTAssertTrue(message.waitForExistence(timeout: 15), "확인 다이얼로그에 '빈 저장소' 문구가 없습니다\n\(tree(app))")
        capture(app, shots, shot)
        let confirm = app.sheets.firstMatch.buttons["초기화"]
        if confirm.waitForExistence(timeout: 3) {
            confirm.tap()
        } else {
            let fallback = app.buttons.matching(NSPredicate(format: "label == %@", "초기화")).firstMatch
            XCTAssertTrue(fallback.waitForExistence(timeout: 5), "확인 다이얼로그의 '초기화' 버튼이 없습니다\n\(tree(app))")
            fallback.tap()
        }
    }

    /// "팀 만들기" 를 드러내고 활성화될 때까지 기다린 뒤 누른다(TeamRoomUITests 와 같은 패턴).
    private func submitTeam(_ app: XCUIApplication) {
        let submit = app.buttons["newTeam.submit"]
        if !submit.waitForExistence(timeout: 2) {
            app.swipeUp()
        }
        XCTAssertTrue(submit.waitForExistence(timeout: 10), "'팀 만들기' 버튼이 없습니다\n\(tree(app))")
        XCTAssertTrue(waitUntil(timeout: 10) { submit.isEnabled }, "'팀 만들기' 가 활성화되지 않았습니다\n\(tree(app))")
        if !submit.isHittable {
            app.swipeUp()
        }
        submit.tap()
    }

    /// "팀원 추가" → 편집기: 역할 프리셋(메뉴 피커) · 이름 · 에이전트(세그먼트) · 팀장 토글 → 완료(TeamRoomUITests 와 같은 패턴).
    private func addMember(_ app: XCUIApplication, name: String, agent: String, rolePreset: String, lead: Bool) {
        let addMember = app.buttons["newTeam.addMember"]
        if !addMember.waitForExistence(timeout: 2) {
            app.swipeUp()
        }
        XCTAssertTrue(addMember.waitForExistence(timeout: 10), "'팀원 추가' 버튼이 없습니다\n\(tree(app))")
        addMember.tap()

        let nameField = app.textFields["memberEditor.name"]
        XCTAssertTrue(nameField.waitForExistence(timeout: 10), "팀원 편집기가 열리지 않았습니다\n\(tree(app))")

        let role = app.buttons["memberEditor.role"].firstMatch
        XCTAssertTrue(role.waitForExistence(timeout: 5), "역할 피커가 없습니다\n\(tree(app))")
        if !role.label.contains(rolePreset) {
            role.tap()
            let item = app.descendants(matching: .any).matching(
                NSPredicate(format: "label ENDSWITH %@ AND identifier != %@", " \(rolePreset)", "memberEditor.role")
            ).firstMatch
            XCTAssertTrue(item.waitForExistence(timeout: 5), "역할 프리셋 '\(rolePreset)' 항목이 없습니다\n\(tree(app))")
            item.tap()
            XCTAssertTrue(waitUntil(timeout: 5) { role.label.contains(rolePreset) }, "역할이 '\(rolePreset)' 로 바뀌지 않았습니다: \(role.label)")
        }

        nameField.tap()
        nameField.typeText(name + "\n")
        XCTAssertTrue(waitUntil(timeout: 5) { (nameField.value as? String) == name }, "이름 입력 결과: \(String(describing: nameField.value))")

        let agentButton = segment(app, labelPrefix: agent)
        XCTAssertTrue(agentButton.waitForExistence(timeout: 5), "에이전트 '\(agent)' 세그먼트가 없습니다\n\(tree(app))")
        if !agentButton.isSelected {
            agentButton.tap()
        }

        let leadToggle = app.descendants(matching: .any).matching(identifier: "memberEditor.lead").firstMatch
        if !leadToggle.waitForExistence(timeout: 2) {
            app.swipeUp()
        }
        XCTAssertTrue(leadToggle.waitForExistence(timeout: 5), "팀장 토글이 없습니다\n\(tree(app))")
        if isOn(leadToggle) != lead {
            leadToggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
            XCTAssertTrue(waitUntil(timeout: 5) { isOn(leadToggle) == lead }, "팀장 토글이 바뀌지 않았습니다: \(String(describing: leadToggle.value))")
        }

        let done = app.buttons["memberEditor.save"]
        XCTAssertTrue(done.waitForExistence(timeout: 5), "'완료' 버튼이 없습니다")
        XCTAssertTrue(waitUntil(timeout: 5) { done.isEnabled }, "'완료' 가 활성화되지 않았습니다(검증 오류)\n\(tree(app))")
        done.tap()
        XCTAssertTrue(waitUntil(timeout: 10) { !nameField.exists }, "팀원 편집기가 닫히지 않았습니다")
    }

    private func segment(_ app: XCUIApplication, labelPrefix: String) -> XCUIElement {
        let inControl = app.segmentedControls.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", labelPrefix)).firstMatch
        if inControl.exists { return inControl }
        return app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", labelPrefix)).firstMatch
    }

    private func isOn(_ toggle: XCUIElement) -> Bool {
        if let s = toggle.value as? String { return s == "1" || s == "true" }
        if let n = toggle.value as? NSNumber { return n.boolValue }
        return false
    }

    /// 미리 채워진 텍스트를 지우고 새 값을 넣는다(TeamRoomUITests 와 같은 패턴).
    private func replaceText(in field: XCUIElement, placeholder: String, with text: String) {
        for _ in 0..<6 {
            field.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
            guard let existing = field.value as? String, !existing.isEmpty, existing != placeholder else { break }
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing.count + 2))
        }
        field.typeText(text)
    }

    // MARK: - 정리 (REST, PROTOCOL.md 6.2)

    /// `GET /api/v1/teams?cwd=` 로 팀 id 를 찾아 `DELETE /api/v1/teams/<id>`. 턴을 돌리지 않아 worktree 가 깨끗하므로 보통 삭제가 되고,
    /// 409 면 `keepWorktrees=true` 로 등록만 해제한다. 오류는 삼킨다.
    private static func deleteTeam(named name: String, cwd: String, server: String) async {
        guard var components = URLComponents(string: server) else { return }
        let session = URLSession(configuration: .ephemeral)
        components.path = "/api/v1/teams"
        components.queryItems = [URLQueryItem(name: "cwd", value: cwd)]
        guard let listURL = components.url else { return }
        var list = URLRequest(url: listURL)
        list.setValue("1", forHTTPHeaderField: "X-MAM-Protocol")
        guard let (data, _) = try? await session.data(for: list),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let teams = json["teams"] as? [[String: Any]],
              let team = teams.first(where: { ($0["name"] as? String) == name }),
              let id = team["id"] as? String
        else { return }
        for keepWorktrees in [false, true] {
            components.path = "/api/v1/teams/\(id)"
            components.queryItems = keepWorktrees ? [URLQueryItem(name: "keepWorktrees", value: "true")] : nil
            guard let deleteURL = components.url else { return }
            var delete = URLRequest(url: deleteURL)
            delete.httpMethod = "DELETE"
            delete.setValue("1", forHTTPHeaderField: "X-MAM-Protocol")
            guard let (_, response) = try? await session.data(for: delete) else { return }
            if (response as? HTTPURLResponse)?.statusCode == 200 { return }
        }
    }

    // MARK: - 공용 (TeamRoomUITests 와 같은 패턴)

    private func tree(_ app: XCUIApplication) -> String {
        let lines = app.debugDescription.split(separator: "\n").filter {
            $0.contains("Button") || $0.contains("StaticText") || $0.contains("Cell") || $0.contains("Switch") || $0.contains("TextField")
                || $0.contains("Segmented")
        }
        return lines.suffix(80).joined(separator: "\n")
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
