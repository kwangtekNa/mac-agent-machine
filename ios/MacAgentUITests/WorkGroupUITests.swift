import XCTest

/// IOS.md 10.12(Phase `10-room-readability`)의 작업 카드 묶기 UI 테스트. `MAM_UI_TEST_SERVER` 와 `MAM_UI_TEST_REPO`(`bash scripts/dev-smoke.sh --keep`
/// 이 마지막에 출력하는 git 저장소)가 없으면 건너뛴다(다른 UI 테스트와 같은 규칙).
///
/// 팀은 REST 로 만든다(팀 만들기 화면은 `TeamRoomUITests` 가 누른다). 팀장 민수(Claude)·지연(Codex)은 `full-auto` 라 승인 없이 돌고,
/// 현우(Claude)만 `auto-edit` 이라 마지막에 **대기 중 승인**을 만든다(ADR-015).
/// 시드는 두 갈래다: 그룹방에 긴 메시지 3건(팀장 민수) → `[사용자][답변][변경]` 3벌, 이어서 지연 DM 에 2건 → **답변은 DM 에 가고 변경 카드만
/// 그룹방에 올라오므로**(PROTOCOL 6.5) 그룹방 끝에 변경 카드 3장이 연속으로 쌓인다.
///
/// 흐름: 홈의 팀 행 → `#전체` → 나갔다 다시 들어가기 → **맨 아래 작업 셀이 스크롤 없이 화면 안**(첫 메시지는 위로 밀려나 있다)
/// → 셀 라벨 "변경 3건 · 머지 대기 2건" → 탭하면 **그 자리에서** 개별 변경 카드(+ 병합 버튼)가 펼쳐짐 → 다시 탭하면 접힘
/// → `@hyunwoo` 로 대기 중 승인을 만들어 **접히지 않고 그대로 보이는지** 확인 → 배너로 허용하면 그 카드도 작업 셀로 접힌다.
/// 끝나면 REST 로 `DELETE /api/v1/teams/<id>?keepWorktrees=true`. 실패해도 결과에는 영향 없음.
/// `MAM_UI_TEST_SHOTS` 가 없으면 스크린샷을 xcresult 첨부로 남긴다.
final class WorkGroupUITests: XCTestCase {
    /// 방을 화면보다 길게 만드는 더미 본문. 방이 넘치지 않으면 "최근 메시지가 먼저 보인다" 를 확인할 수 없다.
    private static let padding = String(repeating: "이 줄은 방을 화면보다 길게 만들기 위한 더미 문장입니다. ", count: 16)

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testWorkCardsCollapseAndRoomOpensAtLatestMessage() throws {
        let server = ProcessInfo.processInfo.environment["MAM_UI_TEST_SERVER"] ?? ""
        try XCTSkipIf(server.isEmpty, "MAM_UI_TEST_SERVER 가 없어 건너뜁니다")
        let repo = ProcessInfo.processInfo.environment["MAM_UI_TEST_REPO"] ?? ""
        try XCTSkipIf(repo.isEmpty, "MAM_UI_TEST_REPO 가 없어 건너뜁니다")
        let shots = ProcessInfo.processInfo.environment["MAM_UI_TEST_SHOTS"] ?? ""
        let teamName = "work-\(Int(Date().timeIntervalSince1970))"

        let team = try XCTUnwrap(Self.createTeam(named: teamName, cwd: repo, server: server), "REST 로 팀을 만들지 못했습니다")
        let teamId = team.id
        addTeardownBlock {
            await Self.deleteTeam(id: teamId, server: server)
        }

        // 1. 그룹방 시드: 멘션이 없으면 팀장(민수, full-auto)이 받는다 → [사용자][답변][변경] 3벌.
        for i in 1...3 {
            XCTAssertTrue(
                Self.post("write file w\(i).txt\n\(Self.padding)", room: team.groupRoomId, team: team.id, server: server),
                "그룹방 시드 메시지 \(i) 를 보내지 못했습니다"
            )
            XCTAssertTrue(Self.waitForChanges(atLeast: i, team: team, server: server), "변경 카드가 \(i)장이 되지 않았습니다")
        }
        // 2. 지연 DM 시드: 답변은 DM 에 남고 변경 카드만 그룹방에 올라오므로 그룹방 끝에 변경 카드가 연속 3장(민수 1 + 지연 2)이 된다.
        for i in 1...2 {
            XCTAssertTrue(
                Self.post("write file d\(i).txt", room: team.dmRoomId, team: team.id, server: server),
                "DM 시드 메시지 \(i) 를 보내지 못했습니다"
            )
            XCTAssertTrue(Self.waitForChanges(atLeast: 3 + i, team: team, server: server), "변경 카드가 \(3 + i)장이 되지 않았습니다")
        }
        let firstUserMessageId = try XCTUnwrap(Self.firstUserMessageId(team: team, server: server), "첫 사용자 메시지를 찾지 못했습니다")

        let app = XCUIApplication()
        app.launchEnvironment["MAM_UI_TEST_SERVER"] = server
        if let size = ProcessInfo.processInfo.environment["MAM_UI_TEST_CONTENT_SIZE"], !size.isEmpty {
            app.launchArguments += ["-UIPreferredContentSizeCategoryName", size]
        }
        app.launch()

        // 3. 홈의 "팀" 섹션 → 방 목록 → `#전체`. 한 번 나갔다 다시 들어간다(10.12 "방에 들어가면 최신 메시지가 먼저 보인다").
        let teamRow = app.descendants(matching: .any).matching(identifier: "teams.row.\(team.id)").firstMatch
        XCTAssertTrue(waitScrolling(app, for: teamRow, timeout: 60), "홈에 팀 행이 없습니다\n\(tree(app))")
        teamRow.tap()
        let groupRow = app.descendants(matching: .any).matching(identifier: "rooms.group").firstMatch
        XCTAssertTrue(groupRow.waitForExistence(timeout: 30), "방 목록이 열리지 않았습니다\n\(tree(app))")
        groupRow.tap()
        let input = app.descendants(matching: .any).matching(identifier: "room.composer.input").firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 30), "방 화면이 열리지 않았습니다\n\(tree(app))")
        back(app)
        XCTAssertTrue(groupRow.waitForExistence(timeout: 15), "방 목록으로 돌아오지 않았습니다\n\(tree(app))")
        groupRow.tap()
        XCTAssertTrue(input.waitForExistence(timeout: 30), "방 화면이 다시 열리지 않았습니다\n\(tree(app))")

        // 4. 맨 아래 작업 셀이 스크롤하지 않아도 화면 안에 있고, 첫 메시지는 위로 밀려나 있다.
        let groups = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'room.workGroup.'"))
        XCTAssertTrue(waitUntil(timeout: 30) { groups.count > 0 }, "작업 셀이 없습니다\n\(tree(app))")
        let lastGroup = groups.element(boundBy: groups.count - 1)
        XCTAssertTrue(isOnScreen(lastGroup, in: app), "최신 작업 셀이 화면 밖입니다(방이 맨 아래로 열리지 않았습니다)\n\(tree(app))")
        XCTAssertTrue(lastGroup.label.contains("변경 3건"), "마지막 작업 셀 라벨이 다릅니다: \(lastGroup.label)")
        XCTAssertTrue(lastGroup.label.contains("머지 대기 2건"), "머지 대기 캡슐이 없습니다: \(lastGroup.label)")
        let firstMessage = app.descendants(matching: .any).matching(identifier: "room.message.\(firstUserMessageId)").firstMatch
        XCTAssertFalse(isOnScreen(firstMessage, in: app), "첫 메시지가 아직 화면에 있습니다(방이 맨 위에서 열렸습니다)")
        capture(app, shots, "1-room-opens-at-latest")

        // 5. 접혀 있으면 개별 변경 카드가 없다 → 셀을 탭하면 그 자리에서(같은 목록 안에서) 펼쳐진다.
        // 인덱스(`element(boundBy:)`)는 스크롤로 렌더 목록이 바뀌면 다른 셀을 가리키므로 식별자로 다시 잡는다.
        let groupIdentifier = lastGroup.identifier
        XCTAssertTrue(groupIdentifier.hasPrefix("room.workGroup."), "작업 셀 식별자가 다릅니다: \(groupIdentifier)")
        let workCell = app.descendants(matching: .any).matching(identifier: groupIdentifier).firstMatch
        let changeCards = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'room.changes.'"))
        XCTAssertEqual(changeCards.count, 0, "접힌 상태인데 개별 변경 카드가 보입니다\n\(tree(app))")
        XCTAssertTrue(makeTappable(app, workCell), "작업 셀 머리 줄을 누를 수 없습니다\n\(tree(app))")
        workCell.tap()
        XCTAssertTrue(waitUntil(timeout: 15) { changeCards.count >= 3 }, "펼친 뒤 개별 변경 카드가 3장이 아닙니다: \(changeCards.count)\n\(tree(app))")
        let mergeButton = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'room.merge.'")).firstMatch
        XCTAssertTrue(mergeButton.waitForExistence(timeout: 10), "펼친 변경 카드에 병합 버튼이 없습니다\n\(tree(app))")
        capture(app, shots, "2-work-group-expanded")

        // 6. 다시 탭하면 접힌다. 펼치면 머리 줄이 화면 끝으로 밀리므로 가운데로 올 때까지 스크롤한다.
        XCTAssertTrue(makeTappable(app, workCell), "작업 셀 머리 줄을 다시 누를 수 없습니다\n\(tree(app))")
        workCell.tap()
        XCTAssertTrue(waitUntil(timeout: 15) { changeCards.count == 0 }, "다시 탭했는데 접히지 않았습니다: \(changeCards.count)\n\(tree(app))")
        capture(app, shots, "3-work-group-collapsed")

        // 7. 대기 중 승인은 접지 않는다(사람이 눌러야 에이전트가 진행한다). auto-edit 인 현우를 부른다.
        //    새 메시지 자동 스크롤은 바닥에 있을 때만 동작하므로 스크롤을 되돌린 뒤 보낸다.
        scrollToBottom(app)
        XCTAssertTrue(input.waitForExistence(timeout: 10), "컴포저를 찾지 못했습니다\n\(tree(app))")
        input.tap()
        input.typeText("@hyunwoo write file p1.txt")
        let send = app.buttons["room.composer.send"]
        XCTAssertTrue(send.waitForExistence(timeout: 5), "보내기 버튼이 없습니다")
        XCTAssertTrue(waitUntil(timeout: 5) { send.isEnabled }, "보내기 버튼이 비활성입니다")
        send.tap()

        let approvalCards = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'room.approval.'"))
        XCTAssertTrue(waitUntil(timeout: 120) { approvalCards.count > 0 }, "대기 중 승인 카드가 없습니다\n\(tree(app))")
        let approvalIdentifier = approvalCards.element(boundBy: approvalCards.count - 1).identifier
        let approvalCard = app.descendants(matching: .any).matching(identifier: approvalIdentifier).firstMatch
        XCTAssertEqual(changeCards.count, 0, "작업 셀은 접혀 있어야 합니다(변경 카드가 보입니다)\n\(tree(app))")
        scrollToBottom(app)
        XCTAssertTrue(isOnScreen(approvalCard, in: app), "대기 중 승인 카드가 화면에 없습니다\n\(tree(app))")
        capture(app, shots, "4-pending-approval-stays-open")

        // 8. 허용하면 해결된 승인이라 작업 셀로 접힌다(그룹 id = 그 메시지 id).
        let allow = app.buttons.matching(NSPredicate(format: "identifier == 'approval.option.allow' OR label == '허용'")).firstMatch
        XCTAssertTrue(allow.waitForExistence(timeout: 30), "승인 배너가 없습니다\n\(tree(app))")
        allow.tap()
        let approvalMessageId = String(approvalIdentifier.dropFirst("room.approval.".count))
        XCTAssertFalse(approvalMessageId.isEmpty, "승인 카드 식별자가 다릅니다: \(approvalIdentifier)")
        let collapsed = app.descendants(matching: .any).matching(identifier: "room.workGroup.\(approvalMessageId)").firstMatch
        XCTAssertTrue(waitScrolling(app, for: collapsed, timeout: 90), "해결된 승인이 작업 셀로 접히지 않았습니다\n\(tree(app))")
        XCTAssertFalse(
            app.descendants(matching: .any).matching(identifier: approvalIdentifier).firstMatch.exists,
            "해결된 승인 카드가 아직 펼쳐져 있습니다\n\(tree(app))"
        )
        capture(app, shots, "5-resolved-approval-collapsed")
    }

    // MARK: - 팀 만들기·시드·지우기 (REST, PROTOCOL.md 6.2)

    /// 시드에 필요한 식별자만 담는다.
    private struct SeededTeam {
        let id: String
        let groupRoomId: String
        /// 지연의 DM 방. 여기서 돌린 턴은 답변을 DM 에 남기고 변경 카드만 그룹방에 올린다.
        let dmRoomId: String
    }

    /// `POST /api/v1/teams` 로 팀장 민수 + 지연(둘 다 `full-auto`) + 현우(`auto-edit`) 팀을 만든다. 실패하면 nil.
    private static func createTeam(named name: String, cwd: String, server: String) -> SeededTeam? {
        let body: [String: Any] = [
            "cwd": cwd,
            "name": name,
            "members": [
                ["name": "민수", "handle": "minsu", "role": "team-lead", "agent": "claude", "isLead": true, "mode": "full-auto"],
                ["name": "지연", "handle": "jiyeon", "role": "developer", "agent": "codex", "mode": "full-auto"],
                ["name": "현우", "handle": "hyunwoo", "role": "code-reviewer", "agent": "claude", "mode": "auto-edit"],
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
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = json["id"] as? String,
              let members = json["members"] as? [[String: Any]],
              let rooms = json["rooms"] as? [[String: Any]],
              let group = rooms.first(where: { ($0["kind"] as? String) == "group" })?["id"] as? String,
              let jiyeon = members.first(where: { ($0["handle"] as? String) == "jiyeon" })?["id"] as? String,
              let dm = rooms.first(where: { ($0["kind"] as? String) == "dm" && ($0["memberId"] as? String) == jiyeon })?["id"] as? String
        else { return nil }
        return SeededTeam(id: id, groupRoomId: group, dmRoomId: dm)
    }

    /// `POST /api/v1/teams/:id/rooms/:roomId/messages`. 201 이면 true.
    private static func post(_ text: String, room: String, team: String, server: String) -> Bool {
        guard let url = URL(string: "\(server)/api/v1/teams/\(team)/rooms/\(room)/messages"),
              let payload = try? JSONSerialization.data(withJSONObject: ["text": text])
        else { return false }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = payload
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("1", forHTTPHeaderField: "X-MAM-Protocol")
        guard let (_, response) = send(request) else { return false }
        return response.statusCode == 201
    }

    /// 그룹방의 `kind: "changes"` 메시지가 `atLeast` 장이 될 때까지 기다린다(턴 종료 = 자동 커밋 + 변경 카드).
    private static func waitForChanges(atLeast count: Int, team: SeededTeam, server: String, timeout: TimeInterval = 180) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if roomMessages(team: team, server: server).filter({ ($0["kind"] as? String) == "changes" }).count >= count { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(1))
        }
        return roomMessages(team: team, server: server).filter { ($0["kind"] as? String) == "changes" }.count >= count
    }

    /// 그룹방에서 사람이 보낸 첫 메시지 id(화면 맨 위 카드. 방이 맨 아래로 열렸는지 확인하는 기준).
    private static func firstUserMessageId(team: SeededTeam, server: String) -> String? {
        roomMessages(team: team, server: server).first {
            ($0["kind"] as? String) == "text" && (($0["author"] as? [String: Any])?["kind"] as? String) == "user"
        }?["id"] as? String
    }

    /// `GET /api/v1/teams/:id/rooms/:roomId` 의 `messages`. 실패는 빈 배열.
    private static func roomMessages(team: SeededTeam, server: String) -> [[String: Any]] {
        guard let url = URL(string: "\(server)/api/v1/teams/\(team.id)/rooms/\(team.groupRoomId)") else { return [] }
        var request = URLRequest(url: url)
        request.setValue("1", forHTTPHeaderField: "X-MAM-Protocol")
        guard let (data, response) = send(request), response.statusCode == 200,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let messages = json["messages"] as? [[String: Any]]
        else { return [] }
        return messages
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

    /// 테스트 본문에서 부르는 동기 요청(시드는 앱을 띄우기 전에 끝나야 한다).
    private static func send(_ request: URLRequest) -> (Data, HTTPURLResponse)? {
        let box = ResponseBox()
        let semaphore = DispatchSemaphore(value: 0)
        URLSession(configuration: .ephemeral).dataTask(with: request) { data, response, _ in
            if let data, let http = response as? HTTPURLResponse { box.value = (data, http) }
            semaphore.signal()
        }.resume()
        _ = semaphore.wait(timeout: .now() + 60)
        return box.value
    }

    // MARK: - 공용 (SideRoomUITests 와 같은 패턴)

    /// 요소가 실제로 화면 안에 그려져 있는지. LazyVStack 이 안 만들었거나 창 밖이면 false.
    private func isOnScreen(_ element: XCUIElement, in app: XCUIApplication) -> Bool {
        guard element.exists else { return false }
        let frame = element.frame
        guard frame.height > 0 else { return false }
        return app.windows.firstMatch.frame.intersects(frame)
    }

    /// 요소를 화면 가운데로 끌어온다. 화면 끝(내비게이션 바 아래·컴포저 위)에 걸친 채 탭하면 다른 뷰가 받고,
    /// `swipeUp()` 은 관성이 붙어 카드 몇 장을 지나치므로 모자란 만큼만 드래그한다.
    private func makeTappable(_ app: XCUIApplication, _ element: XCUIElement, timeout: TimeInterval = 30) -> Bool {
        let window = app.windows.firstMatch.frame
        guard window.height > 0 else { return false }
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            guard element.exists, element.frame.height > 0 else {
                app.swipeUp()
                RunLoop.current.run(until: Date().addingTimeInterval(0.4))
                continue
            }
            let frame = element.frame
            if element.isHittable, frame.minY > window.minY + 100, frame.maxY < window.maxY - 60 { return true }
            let startY = window.midY
            let endY = min(max(startY - (frame.midY - window.midY), window.minY + 160), window.maxY - 160)
            guard abs(endY - startY) > 4 else { return element.isHittable }
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: startY / window.height))
                .press(
                    forDuration: 0.05,
                    thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: endY / window.height))
                )
            RunLoop.current.run(until: Date().addingTimeInterval(0.4))
            // 목록 끝이라 더 움직이지 않으면(마지막 셀은 늘 바닥에 붙어 있다) 지금 눌릴 수 있는지로 판단한다.
            if element.exists, element.frame == frame { return element.isHittable }
        }
        return false
    }

    /// 방 맨 아래로 되돌린다. 이미 바닥이면 스와이프는 아무 일도 하지 않는다(새 메시지 자동 스크롤은 바닥일 때만 동작한다).
    private func scrollToBottom(_ app: XCUIApplication) {
        for _ in 0..<5 {
            app.swipeUp()
            RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        }
    }

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
