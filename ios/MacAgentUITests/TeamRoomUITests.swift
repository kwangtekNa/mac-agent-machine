import XCTest

/// IOS.md 10절(Phase `4-teams-ios`)의 UI 테스트. `MAM_UI_TEST_SERVER` 와 `MAM_UI_TEST_REPO`(`bash scripts/dev-smoke.sh --keep` 이
/// 마지막에 출력하는 git 저장소) 가 없으면 건너뛴다(다른 두 UI 테스트와 같은 규칙).
/// 홈 `+` → 새 팀(이름 `ui-<timestamp>`, 직접 입력 = 저장소, 팀장 민수 Claude + 개발자 지연 Codex) → 방 목록(#전체 + DM 2개) → #전체
/// → 팀원 시트에서 지연의 모델·사고 수준(low)·권한(full-auto, 확인 다이얼로그) 변경(10.8)
/// → `@지` 제안 칩 → `write file ui.txt` 보내기 → (full-auto 라 승인 배너 없음, 뜨면 "허용") → 답변 + 작업 요약("도구") → 작업 요약 탭 → 팀원 타임라인 완료 행 → 뒤로
/// → 변경 준비됨 카드 "main에 병합" → 확인 → "병합됨". PROTOCOL.md 6절 흐름(생성 → 멘션 → 승인 → 답변 → 변경 → 머지)을 그대로 누른다.
/// 끝나면 REST(`URLSession`)로 `DELETE /api/v1/teams/<id>?keepWorktrees=true`(팀 id 는 `GET /teams?cwd=`). 실패해도 결과에는 영향 없음.
/// 같은 저장소에 두 번 돌리면 `ui.txt` 가 이미 main 에 있어 변경 카드가 안 올라온다. 서버를 다시 띄워 새 저장소로 돌린다.
/// `MAM_UI_TEST_SHOTS` 가 없으면 스크린샷을 xcresult 첨부로 남긴다.
final class TeamRoomUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testCreateTeamMentionApproveAndMerge() throws {
        let server = ProcessInfo.processInfo.environment["MAM_UI_TEST_SERVER"] ?? ""
        try XCTSkipIf(server.isEmpty, "MAM_UI_TEST_SERVER 가 없어 건너뜁니다")
        let repo = ProcessInfo.processInfo.environment["MAM_UI_TEST_REPO"] ?? ""
        try XCTSkipIf(repo.isEmpty, "MAM_UI_TEST_REPO 가 없어 건너뜁니다")
        let shots = ProcessInfo.processInfo.environment["MAM_UI_TEST_SHOTS"] ?? ""
        let teamName = "ui-\(Int(Date().timeIntervalSince1970))"

        // 정리: 어디서 끝나든 만든 팀은 REST 로 지운다(worktree 는 남긴다). 실패해도 테스트 결과에는 영향 없음.
        addTeardownBlock {
            await Self.deleteTeam(named: teamName, cwd: repo, server: server)
        }

        let app = XCUIApplication()
        app.launchEnvironment["MAM_UI_TEST_SERVER"] = server
        if let size = ProcessInfo.processInfo.environment["MAM_UI_TEST_CONTENT_SIZE"], !size.isEmpty {
            app.launchArguments += ["-UIPreferredContentSizeCategoryName", size]
        }
        app.launch()

        // 1. 연결됨 → 세션 홈의 "+" 메뉴 → "새 팀".
        let add = app.buttons.matching(NSPredicate(format: "identifier == 'home.add' OR label == '추가'")).firstMatch
        XCTAssertTrue(add.waitForExistence(timeout: 30), "세션 홈이 열리지 않았습니다")
        add.tap()
        let newTeam = app.buttons.matching(NSPredicate(format: "identifier == 'home.newTeam' OR label == '새 팀'")).firstMatch
        XCTAssertTrue(newTeam.waitForExistence(timeout: 10), "+ 메뉴에 새 팀 항목이 없습니다")
        newTeam.tap()

        // 2. 이름 → 디렉토리 "직접 입력" 에 저장소 경로 → 팀원 2명 → 팀 만들기.
        let nameField = app.textFields["newTeam.name"]
        XCTAssertTrue(nameField.waitForExistence(timeout: 10), "새 팀 시트가 열리지 않았습니다")
        nameField.tap()
        nameField.typeText(teamName + "\n")

        let pathField = app.textFields["newTeam.customPath"]
        if !pathField.waitForExistence(timeout: 2) {
            let toggle = app.buttons["newTeam.customToggle"]
            XCTAssertTrue(toggle.waitForExistence(timeout: 5), "'직접 입력' 버튼이 없습니다\n\(tree(app))")
            toggle.tap()
        }
        XCTAssertTrue(pathField.waitForExistence(timeout: 5), "직접 입력 필드가 없습니다")
        replaceText(in: pathField, placeholder: "~/work/my-app", with: repo + "\n")
        let selected = app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier == %@ AND label CONTAINS %@", "newTeam.selectedPath", repo)
        ).firstMatch
        XCTAssertTrue(selected.waitForExistence(timeout: 10), "저장소 경로가 시트에 반영되지 않았습니다\n\(tree(app))")

        addMember(app, name: "민수", agent: "Claude Code", rolePreset: "팀장", lead: true)
        addMember(app, name: "지연", agent: "Codex", rolePreset: "개발자", lead: false)
        capture(app, shots, "1-new-team")

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

        // 3. 방 목록: #전체 + DM 행 2개 → #전체 진입.
        let groupRow = app.descendants(matching: .any).matching(identifier: "rooms.group").firstMatch
        XCTAssertTrue(groupRow.waitForExistence(timeout: 60), "방 목록이 열리지 않았습니다\n\(tree(app))")
        let dmRows = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'rooms.dm.'"))
        XCTAssertTrue(waitUntil(timeout: 10) { dmRows.count >= 2 }, "DM 행이 2개가 아닙니다: \(dmRows.count)\n\(tree(app))")
        capture(app, shots, "2-rooms")
        groupRow.tap()

        // 4. 컴포저에 "@지" → 제안 칩(지연) 탭 → "write file ui.txt" → 보내기.
        let input = app.descendants(matching: .any).matching(identifier: "room.composer.input").firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 30), "방 화면이 열리지 않았습니다\n\(tree(app))")

        // 4-1. 팀원 시트 → 지연 행 → 모델·사고 수준(low)·권한(full-auto, 확인 다이얼로그) (IOS.md 10.8).
        setMemberControls(app, memberName: "지연", shots: shots)
        XCTAssertTrue(input.waitForExistence(timeout: 10), "팀원 시트를 닫고 방 화면으로 돌아오지 않았습니다\n\(tree(app))")

        input.tap()
        input.typeText("@지")
        let chip = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'room.mention.'")).firstMatch
        XCTAssertTrue(chip.waitForExistence(timeout: 10), "멘션 제안 칩이 없습니다\n\(tree(app))")
        capture(app, shots, "3-mention-chip")
        chip.tap()
        XCTAssertTrue(waitUntil(timeout: 5) { (input.value as? String)?.hasPrefix("@지연") == true }, "제안 적용 후 텍스트: \(String(describing: input.value))")
        input.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
        input.typeText("write file ui.txt")
        let send = app.buttons["room.composer.send"]
        XCTAssertTrue(send.waitForExistence(timeout: 5))
        XCTAssertTrue(waitUntil(timeout: 5) { send.isEnabled }, "보내기 버튼이 비활성입니다")
        send.tap()

        // 5. 답변 + 작업 요약 → 팀원 타임라인 → 뒤로. 지연이 full-auto 라 Fake 도 승인을 요청하지 않지만(ADR-015),
        //    배너가 뜨면(모드가 반영되기 전 등) 허용을 눌러 계속한다.
        let allow = app.buttons.matching(NSPredicate(format: "identifier == 'approval.option.allow' OR label == '허용'")).firstMatch
        let work = app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier BEGINSWITH 'room.workSummary.' AND label CONTAINS '도구'")
        ).firstMatch
        let approvalDeadline = Date().addingTimeInterval(60)
        while Date() < approvalDeadline {
            if work.exists { break }
            if allow.exists {
                capture(app, shots, "4-approval-banner")
                allow.tap()
                break
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        }
        XCTAssertTrue(waitScrolling(app, for: work, timeout: 60), "작업 요약 카드가 없습니다\n\(tree(app))")
        capture(app, shots, "5-reply-and-work")
        work.tap()
        // 완료 행(turn_summary)은 `<시간> · <토큰> 토큰 · <비용>`. full-auto 턴은 1초 안에 끝나 시간이 "0ms" 로 찍히므로
        // "토큰" 으로 찾는다. 화면 밖이면 스크롤하며 찾는다.
        let summary = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "토큰")).firstMatch
        XCTAssertTrue(waitScrolling(app, for: summary, timeout: 60), "팀원 타임라인에 완료 행(turn_summary)이 없습니다\n\(tree(app))")
        capture(app, shots, "6-member-timeline")
        let back = app.navigationBars.firstMatch.buttons.element(boundBy: 0)
        XCTAssertTrue(back.waitForExistence(timeout: 5), "뒤로 버튼이 없습니다")
        back.tap()
        XCTAssertTrue(input.waitForExistence(timeout: 10), "방 화면으로 돌아오지 않았습니다")

        // 6. 변경 준비됨 카드 → "main에 병합" → 확인 → "병합됨".
        let merge = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'room.merge.'")).firstMatch
        XCTAssertTrue(waitScrolling(app, for: merge, timeout: 60), "변경 준비됨 카드의 병합 버튼이 없습니다\n\(tree(app))")
        XCTAssertEqual(merge.label, "main에 병합")
        capture(app, shots, "7-changes-ready")
        merge.tap()
        let confirm = app.sheets.firstMatch.buttons["main에 병합"]
        let confirmFallback = app.buttons.matching(NSPredicate(format: "label == 'main에 병합'"))
        if !confirm.waitForExistence(timeout: 5) {
            XCTAssertTrue(waitUntil(timeout: 5) { confirmFallback.count >= 2 }, "병합 확인 대화상자가 없습니다\n\(tree(app))")
            confirmFallback.element(boundBy: confirmFallback.count - 1).tap()
        } else {
            confirm.tap()
        }
        let merged = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "병합됨")).firstMatch
        XCTAssertTrue(waitScrolling(app, for: merged, timeout: 60), "카드에 '병합됨' 이 없습니다\n\(tree(app))")
        capture(app, shots, "8-merged")
    }

    // MARK: - 단계 헬퍼

    /// 방 툴바 `room.members` → `room.member.<id>` 탭 → `MemberControlSheet`(IOS.md 10.8): 모델 → 사고 수준 low → 권한 full-auto.
    /// 새 팀원은 `model` 이 null 이라 사고 수준 목록(선택 모델의 `efforts`)이 비어 있다. 모델을 먼저 고르면 `memberControl.effort` 가 나온다.
    /// `full-auto` 는 확인 다이얼로그("full-auto로 전환") 뒤에만 적용된다(ADR-015). 값 확정은 서버 응답이라 표시가 바뀔 때까지 기다린다.
    private func setMemberControls(_ app: XCUIApplication, memberName: String, shots: String) {
        let membersButton = app.buttons["room.members"]
        XCTAssertTrue(membersButton.waitForExistence(timeout: 10), "팀원 툴바 버튼이 없습니다\n\(tree(app))")
        membersButton.tap()
        let row = app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier BEGINSWITH 'room.member.' AND label CONTAINS %@", memberName)
        ).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15), "팀원 행(\(memberName))이 없습니다\n\(tree(app))")
        row.tap()

        let modelPicker = app.descendants(matching: .any).matching(identifier: "memberControl.model").firstMatch
        XCTAssertTrue(modelPicker.waitForExistence(timeout: 30), "모델 피커가 없습니다(GET /models)\n\(tree(app))")
        if !pickerText(modelPicker).contains("Fake 1") {
            selectPickerOption(app, picker: modelPicker, option: "Fake 1")
            XCTAssertTrue(waitUntil(timeout: 20) { pickerText(modelPicker).contains("Fake 1") }, "모델이 바뀌지 않았습니다: \(pickerText(modelPicker))")
        }

        let effortPicker = app.descendants(matching: .any).matching(identifier: "memberControl.effort").firstMatch
        XCTAssertTrue(effortPicker.waitForExistence(timeout: 20), "사고 수준 피커가 없습니다\n\(tree(app))")
        selectPickerOption(app, picker: effortPicker, option: "low")
        XCTAssertTrue(waitUntil(timeout: 20) { pickerText(effortPicker).contains("low") }, "사고 수준이 low 로 바뀌지 않았습니다: \(pickerText(effortPicker))")

        let modePicker = app.descendants(matching: .any).matching(identifier: "memberControl.mode").firstMatch
        XCTAssertTrue(modePicker.waitForExistence(timeout: 10), "권한 피커가 없습니다\n\(tree(app))")
        selectPickerOption(app, picker: modePicker, option: "full-auto")
        let confirm = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "full-auto로 전환")).firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 10), "full-auto 확인 다이얼로그가 없습니다\n\(tree(app))")
        confirm.tap()
        // 권한 피커는 항목이 `Label`(아이콘+글자)이라 선택값이 피커 라벨이 아니라 옆 텍스트로 그려질 수 있다. 둘 다 본다.
        let modeValue = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "full-auto")).firstMatch
        XCTAssertTrue(
            waitUntil(timeout: 20) { pickerText(modePicker).contains("full-auto") || modeValue.exists },
            "권한이 full-auto 로 바뀌지 않았습니다: \(pickerText(modePicker))\n\(tree(app))"
        )
        capture(app, shots, "3-member-control")

        let done = app.buttons["완료"].firstMatch
        XCTAssertTrue(done.waitForExistence(timeout: 5), "팀원 시트의 '완료' 가 없습니다\n\(tree(app))")
        done.tap()
        let close = app.buttons["닫기"].firstMatch
        XCTAssertTrue(close.waitForExistence(timeout: 10), "팀원 목록 시트의 '닫기' 가 없습니다\n\(tree(app))")
        close.tap()
    }

    /// Form 피커(메뉴 스타일)를 열고 라벨이 일치하는 항목을 누른다. 피커 자신은 identifier 로 걸러낸다.
    private func selectPickerOption(_ app: XCUIApplication, picker: XCUIElement, option: String) {
        picker.tap()
        let item = app.descendants(matching: .any).matching(
            NSPredicate(format: "label == %@ AND identifier != %@", option, picker.identifier)
        ).firstMatch
        XCTAssertTrue(item.waitForExistence(timeout: 10), "피커 항목 '\(option)' 이 없습니다\n\(tree(app))")
        item.tap()
    }

    /// 메뉴 피커의 현재 값은 라벨("모델, Fake 1") 또는 value 에 들어온다. 둘을 합쳐서 본다.
    private func pickerText(_ element: XCUIElement) -> String {
        let value = (element.value as? String) ?? ""
        return "\(element.label) \(value)"
    }

    /// "팀원 추가" → 편집기: 역할 프리셋(메뉴 피커) · 이름 · 에이전트(세그먼트, `agent` 는 라벨 "Claude Code"/"Codex") · 팀장 토글 → 완료.
    private func addMember(_ app: XCUIApplication, name: String, agent: String, rolePreset: String, lead: Bool) {
        let addMember = app.buttons["newTeam.addMember"]
        if !addMember.waitForExistence(timeout: 2) {
            app.swipeUp()
        }
        XCTAssertTrue(addMember.waitForExistence(timeout: 10), "'팀원 추가' 버튼이 없습니다\n\(tree(app))")
        addMember.tap()

        let nameField = app.textFields["memberEditor.name"]
        XCTAssertTrue(nameField.waitForExistence(timeout: 10), "팀원 편집기가 열리지 않았습니다\n\(tree(app))")

        // 역할 피커(메뉴): 항목 라벨은 "<이모지> <역할명>". 이미 그 프리셋이면 건너뛴다(기본은 개발자).
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

        // 에이전트 세그먼트. 라벨은 `AgentKind.displayName`("Claude Code" / "Codex")이고 식별자는 세그먼트에 전달되지 않으므로
        // UsageAndFilesUITests.segment() 처럼 세그먼트 컨트롤 안에서 라벨 접두어로 찾는다(선택된 칸은 "Codex, 선택됨" 일 수 있다).
        let agentButton = segment(app, labelPrefix: agent)
        XCTAssertTrue(agentButton.waitForExistence(timeout: 5), "에이전트 '\(agent)' 세그먼트가 없습니다\n\(tree(app))")
        if !agentButton.isSelected {
            agentButton.tap()
        }

        // 팀장 토글은 지시문 아래라 키보드가 떠 있으면 Form 이 그 행을 만들지 않는다(트리에 없다). 위로 밀어 키보드를 내리고 드러낸다.
        let leadToggle = app.descendants(matching: .any).matching(identifier: "memberEditor.lead").firstMatch
        if !leadToggle.waitForExistence(timeout: 2) {
            app.swipeUp()
        }
        XCTAssertTrue(leadToggle.waitForExistence(timeout: 5), "팀장 토글이 없습니다\n\(tree(app))")
        if isOn(leadToggle) != lead {
            // SwiftUI Toggle 은 라벨이 아니라 오른쪽 스위치를 눌러야 바뀐다. 행의 오른쪽 끝을 탭한다.
            leadToggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
            XCTAssertTrue(waitUntil(timeout: 5) { isOn(leadToggle) == lead }, "팀장 토글이 바뀌지 않았습니다: \(String(describing: leadToggle.value))")
        }

        let done = app.buttons["memberEditor.save"]
        XCTAssertTrue(done.waitForExistence(timeout: 5), "'완료' 버튼이 없습니다")
        XCTAssertTrue(waitUntil(timeout: 5) { done.isEnabled }, "'완료' 가 활성화되지 않았습니다(검증 오류)\n\(tree(app))")
        done.tap()
        XCTAssertTrue(waitUntil(timeout: 10) { !nameField.exists }, "팀원 편집기가 닫히지 않았습니다")
    }

    /// 세그먼트 피커의 한 칸(UsageAndFilesUITests 와 같은 패턴). 세그먼트 컨트롤 안에서 못 찾으면 어떤 요소든 라벨 접두어로 찾는다.
    private func segment(_ app: XCUIApplication, labelPrefix: String) -> XCUIElement {
        let inControl = app.segmentedControls.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", labelPrefix)).firstMatch
        if inControl.exists { return inControl }
        return app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", labelPrefix)).firstMatch
    }

    /// 스위치 값은 "1"/"0"(또는 true/false).
    private func isOn(_ toggle: XCUIElement) -> Bool {
        if let s = toggle.value as? String { return s == "1" || s == "true" }
        if let n = toggle.value as? NSNumber { return n.boolValue }
        return false
    }

    /// 미리 채워진 텍스트를 지우고 새 값을 넣는다. 긴 경로는 첫 탭의 커서가 중간에 놓일 수 있어 끝을 다시 탭하며 비워질 때까지 반복한다.
    private func replaceText(in field: XCUIElement, placeholder: String, with text: String) {
        for _ in 0..<6 {
            field.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
            guard let existing = field.value as? String, !existing.isEmpty, existing != placeholder else { break }
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing.count + 2))
        }
        field.typeText(text)
    }

    /// LazyVStack 은 화면 밖 카드를 트리에 두지 않는다. 기다리다 없으면 아래·위로 스크롤하며 다시 찾는다.
    private func waitScrolling(_ app: XCUIApplication, for element: XCUIElement, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        var swipes = 0
        while Date() < deadline {
            if element.waitForExistence(timeout: 5) { return true }
            if swipes % 4 < 2 { app.swipeUp() } else { app.swipeDown() }
            swipes += 1
        }
        return element.exists
    }

    // MARK: - 정리 (REST, PROTOCOL.md 6.2)

    /// `GET /api/v1/teams?cwd=` 로 팀 id 를 찾아 `DELETE /api/v1/teams/<id>?keepWorktrees=true`. 오류는 삼킨다.
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
        components.path = "/api/v1/teams/\(id)"
        components.queryItems = [URLQueryItem(name: "keepWorktrees", value: "true")]
        guard let deleteURL = components.url else { return }
        var delete = URLRequest(url: deleteURL)
        delete.httpMethod = "DELETE"
        delete.setValue("1", forHTTPHeaderField: "X-MAM-Protocol")
        _ = try? await session.data(for: delete)
    }

    // MARK: - 공용 (UsageAndFilesUITests 와 같은 패턴)

    /// 실패 메시지용 요소 트리 요약(버튼·텍스트·셀·스위치·세그먼트만). 시트는 트리 뒤쪽에 오므로 뒷부분을 남긴다.
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
