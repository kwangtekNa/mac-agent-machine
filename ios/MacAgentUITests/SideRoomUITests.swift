import XCTest

/// IOS.md 10.11(Phase `9-side-rooms`)의 곁방 UI 테스트. `MAM_UI_TEST_SERVER` 와 `MAM_UI_TEST_REPO`(`bash scripts/dev-smoke.sh --keep`
/// 이 마지막에 출력하는 git 저장소)가 없으면 건너뛴다(다른 UI 테스트와 같은 규칙).
/// 팀은 REST 로 만든다(팀 만들기 화면은 `TeamRoomUITests` 가 누른다). 팀장 민수(Claude) + 개발자 지연(Codex)이고 둘 다 `full-auto` 라
/// 승인 배너가 끼어들지 않는다(ADR-015).
/// 홈의 팀 행 → `#전체` → **팀장이 개발자를 부르게 하는 메시지** 전송 → 그룹방의 연결 카드(`room.sideRoom.*`) 탭
/// → 곁방 화면(제목 `↔`, 부제 "에이전트 간") → 메시지 확인 → 뒤로 → 방 목록의 "에이전트 간" 섹션 + `rooms.side.*` 행
/// → 곁방에 사람이 직접 한 줄(캡션 "참가자 전원에게 전달됩니다") → 보낸 메시지 확인. PROTOCOL.md 6.6 흐름을 그대로 누른다.
/// 끝나면 REST 로 `DELETE /api/v1/teams/<id>?keepWorktrees=true`. 실패해도 결과에는 영향 없음.
/// `MAM_UI_TEST_SHOTS` 가 없으면 스크린샷을 xcresult 첨부로 남긴다.
final class SideRoomUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testAgentToAgentChatMovesToSideRoomAndUserCanJoin() throws {
        let server = ProcessInfo.processInfo.environment["MAM_UI_TEST_SERVER"] ?? ""
        try XCTSkipIf(server.isEmpty, "MAM_UI_TEST_SERVER 가 없어 건너뜁니다")
        let repo = ProcessInfo.processInfo.environment["MAM_UI_TEST_REPO"] ?? ""
        try XCTSkipIf(repo.isEmpty, "MAM_UI_TEST_REPO 가 없어 건너뜁니다")
        let shots = ProcessInfo.processInfo.environment["MAM_UI_TEST_SHOTS"] ?? ""
        let teamName = "side-\(Int(Date().timeIntervalSince1970))"

        let teamId = try XCTUnwrap(Self.createTeam(named: teamName, cwd: repo, server: server), "REST 로 팀을 만들지 못했습니다")
        addTeardownBlock {
            await Self.deleteTeam(id: teamId, server: server)
        }

        let app = XCUIApplication()
        app.launchEnvironment["MAM_UI_TEST_SERVER"] = server
        if let size = ProcessInfo.processInfo.environment["MAM_UI_TEST_CONTENT_SIZE"], !size.isEmpty {
            app.launchArguments += ["-UIPreferredContentSizeCategoryName", size]
        }
        app.launch()

        // 1. 홈의 "팀" 섹션에서 이 팀 → 방 목록 → `#전체`.
        let teamRow = app.descendants(matching: .any).matching(identifier: "teams.row.\(teamId)").firstMatch
        XCTAssertTrue(waitScrolling(app, for: teamRow, timeout: 60), "홈에 팀 행이 없습니다\n\(tree(app))")
        teamRow.tap()
        let groupRow = app.descendants(matching: .any).matching(identifier: "rooms.group").firstMatch
        XCTAssertTrue(groupRow.waitForExistence(timeout: 30), "방 목록이 열리지 않았습니다\n\(tree(app))")
        groupRow.tap()

        // 2. 팀장이 개발자를 부르게 한다. Fake 는 턴 텍스트의 `ask @<핸들>` 을 보고 답변에 `@<핸들> 확인 부탁해요.` 를 붙인다
        //    (agents/fake/script.ts). 사용자가 `@jiyeon` 을 그대로 쓰면 이 메시지 자체가 지연을 멘션해 그룹방에서 바로 디스패치되므로
        //    조사를 붙여(`@jiyeon에게`) 멘션 파서는 모르는 토큰으로 흘리고 Fake 의 `ask @jiyeon` 만 걸리게 한다.
        let input = app.descendants(matching: .any).matching(identifier: "room.composer.input").firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 30), "방 화면이 열리지 않았습니다\n\(tree(app))")
        input.tap()
        input.typeText("@minsu ask @jiyeon에게 확인 좀 부탁해")
        let send = app.buttons["room.composer.send"]
        XCTAssertTrue(send.waitForExistence(timeout: 5), "보내기 버튼이 없습니다")
        XCTAssertTrue(waitUntil(timeout: 5) { send.isEnabled }, "보내기 버튼이 비활성입니다")
        send.tap()

        // 3. 그룹방에 곁방 연결 카드가 올라온다(PROTOCOL 6.6). 탭하면 그 곁방으로 들어간다.
        let card = app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier BEGINSWITH 'room.sideRoom.'")
        ).firstMatch
        XCTAssertTrue(waitScrolling(app, for: card, timeout: 90), "그룹방에 곁방 연결 카드가 없습니다\n\(tree(app))")
        capture(app, shots, "1-side-room-card")
        card.tap()

        // 4. 곁방 화면: 제목은 서버가 만든 이름(`민수 ↔ 지연`), 부제는 "에이전트 간 · 참가자 N명".
        let title = app.descendants(matching: .any).matching(identifier: "room.title").firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: 30), "곁방 화면이 열리지 않았습니다\n\(tree(app))")
        XCTAssertTrue(title.label.contains("↔"), "곁방 제목에 ↔ 가 없습니다: \(title.label)")
        XCTAssertTrue(title.label.contains("에이전트 간"), "곁방 부제가 다릅니다: \(title.label)")
        let reply = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "확인 부탁해요")).firstMatch
        XCTAssertTrue(waitScrolling(app, for: reply, timeout: 60), "곁방에 메시지가 없습니다\n\(tree(app))")
        capture(app, shots, "2-side-room")

        // 5. 뒤로(곁방 → #전체 → 방 목록): "에이전트 간" 섹션과 곁방 행이 보인다.
        back(app)
        XCTAssertTrue(input.waitForExistence(timeout: 15), "#전체 로 돌아오지 않았습니다\n\(tree(app))")
        back(app)
        let sideRow = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'rooms.side.'")).firstMatch
        XCTAssertTrue(waitScrolling(app, for: sideRow, timeout: 30), "방 목록에 곁방 행이 없습니다\n\(tree(app))")
        let header = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "에이전트 간")).firstMatch
        XCTAssertTrue(header.waitForExistence(timeout: 10), "방 목록에 '에이전트 간' 섹션이 없습니다\n\(tree(app))")
        capture(app, shots, "3-rooms-with-side")

        // 6. 사람이 곁방에 직접 끼어든다: 멘션이 없으면 캡션이 "참가자 전원에게 전달됩니다"(PROTOCOL 6.4).
        sideRow.tap()
        let sideInput = app.descendants(matching: .any).matching(identifier: "room.composer.input").firstMatch
        XCTAssertTrue(sideInput.waitForExistence(timeout: 30), "곁방 화면이 열리지 않았습니다\n\(tree(app))")
        sideInput.tap()
        sideInput.typeText("정리해줘")
        let caption = app.descendants(matching: .any).matching(identifier: "room.composer.caption").firstMatch
        XCTAssertTrue(caption.waitForExistence(timeout: 10), "컴포저 캡션이 없습니다\n\(tree(app))")
        XCTAssertEqual(caption.label, "참가자 전원에게 전달됩니다")
        capture(app, shots, "4-side-composer-caption")
        let sideSend = app.buttons["room.composer.send"]
        XCTAssertTrue(waitUntil(timeout: 5) { sideSend.isEnabled }, "보내기 버튼이 비활성입니다")
        sideSend.tap()
        let sent = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "정리해줘")).firstMatch
        XCTAssertTrue(waitScrolling(app, for: sent, timeout: 60), "보낸 메시지가 곁방에 없습니다\n\(tree(app))")
        capture(app, shots, "5-side-room-joined")
    }

    // MARK: - 팀 만들기·지우기 (REST, PROTOCOL.md 6.2)

    /// `POST /api/v1/teams` 로 팀장 + 개발자(둘 다 `full-auto`) 팀을 만들고 id 를 돌려준다. 실패하면 nil.
    private static func createTeam(named name: String, cwd: String, server: String) -> String? {
        let body: [String: Any] = [
            "cwd": cwd,
            "name": name,
            "members": [
                ["name": "민수", "handle": "minsu", "role": "team-lead", "agent": "claude", "isLead": true, "mode": "full-auto"],
                ["name": "지연", "handle": "jiyeon", "role": "developer", "agent": "codex", "mode": "full-auto"],
            ],
        ]
        guard let url = URL(string: "\(server)/api/v1/teams"),
              let payload = try? JSONSerialization.data(withJSONObject: body)
        else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = payload
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("1", forHTTPHeaderField: "X-MAM-Protocol")
        guard let (data, response) = send(request), response.statusCode == 201,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return json["id"] as? String
    }

    /// `DELETE /api/v1/teams/<id>?keepWorktrees=true`. 오류는 삼킨다.
    private static func deleteTeam(id: String, server: String) async {
        guard var components = URLComponents(string: server) else { return }
        components.path = "/api/v1/teams/\(id)"
        components.queryItems = [URLQueryItem(name: "keepWorktrees", value: "true")]
        guard let url = components.url else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        request.setValue("1", forHTTPHeaderField: "X-MAM-Protocol")
        _ = try? await URLSession(configuration: .ephemeral).data(for: request)
    }

    /// 완료 핸들러(`@Sendable`)와 테스트 본문이 함께 쓰는 결과 칸. 세마포어로 순서를 강제하므로 동시 접근은 없다.
    private final class ResponseBox: @unchecked Sendable {
        var value: (Data, HTTPURLResponse)?
    }

    /// 테스트 본문에서 부르는 동기 요청(팀 생성은 앱을 띄우기 전에 끝나야 한다).
    private static func send(_ request: URLRequest) -> (Data, HTTPURLResponse)? {
        let box = ResponseBox()
        let semaphore = DispatchSemaphore(value: 0)
        URLSession(configuration: .ephemeral).dataTask(with: request) { data, response, _ in
            if let data, let http = response as? HTTPURLResponse { box.value = (data, http) }
            semaphore.signal()
        }.resume()
        _ = semaphore.wait(timeout: .now() + 30)
        return box.value
    }

    // MARK: - 공용 (TeamRoomUITests 와 같은 패턴)

    private func back(_ app: XCUIApplication) {
        let button = app.navigationBars.firstMatch.buttons.element(boundBy: 0)
        XCTAssertTrue(button.waitForExistence(timeout: 10), "뒤로 버튼이 없습니다")
        button.tap()
    }

    /// LazyVStack·List 는 화면 밖 행을 트리에 두지 않는다. 기다리다 없으면 아래·위로 스크롤하며 다시 찾는다.
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

    private func waitUntil(timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        return condition()
    }

    /// 실패 메시지용 요소 트리 요약(버튼·텍스트·셀만). 시트는 트리 뒤쪽에 오므로 뒷부분을 남긴다.
    private func tree(_ app: XCUIApplication) -> String {
        let lines = app.debugDescription.split(separator: "\n").filter {
            $0.contains("Button") || $0.contains("StaticText") || $0.contains("Cell") || $0.contains("TextField")
        }
        return lines.suffix(80).joined(separator: "\n")
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
