import Foundation
import XCTest
@testable import MacAgent

@MainActor
final class SessionsStoreTests: XCTestCase {
    private let baseURL = URL(string: "http://127.0.0.1:7777")!
    private var store: SessionsStore!
    private let requests = Locked<[URLRequest]>([])

    private struct Route: Sendable {
        var method: String
        var path: String
        var status: Int
        var body: Data
    }

    override func setUp() {
        super.setUp()
        store = SessionsStore(client: APIClient(baseURL: baseURL, session: StubURLProtocol.makeSession()))
        requests.value = []
        XCTAssertFalse(store.hasLoaded, "첫 refresh 전에는 로드 전 상태다")
    }

    override func tearDown() {
        StubURLProtocol.handler = nil
        super.tearDown()
    }

    // MARK: - helpers

    private func install(_ routes: [Route]) {
        let requests = self.requests
        StubURLProtocol.handler = { request in
            var copy = request
            copy.httpBody = StubURLProtocol.body(of: request)
            requests.withValue { $0.append(copy) }
            let path = request.url?.path() ?? ""
            guard let route = routes.first(where: { $0.method == request.httpMethod && $0.path == path }) else {
                throw URLError(.unsupportedURL)
            }
            return StubURLProtocol.response(request, status: route.status, body: route.body)
        }
    }

    private func date(_ iso: String) -> Date {
        ISO8601DateFormatter().date(from: iso)!
    }

    private func makeSession(
        id: String,
        status: SessionStatus = .idle,
        updatedAt: String = "2026-09-09T10:00:00Z",
        cwd: String = "/Users/alice/work/app",
        pendingApprovals: Int = 0,
        agent: AgentKind = .claude,
        title: String = "세션 \(UUID().uuidString.prefix(4))",
        preview: String? = nil
    ) -> Session {
        Session(
            id: id, agent: agent, cwd: cwd, title: title, mode: .ask, model: nil, status: status, nativeId: nil,
            createdAt: date("2026-09-09T09:00:00Z"), updatedAt: date(updatedAt), lastSeq: 0,
            pendingApprovals: pendingApprovals, preview: preview
        )
    }

    private func sessionsBody(_ sessions: [Session]) throws -> Data {
        try JSONCoding.encoder.encode(SessionsResponse(sessions: sessions))
    }

    private func projectsRoute() throws -> Route {
        Route(method: "GET", path: "/api/v1/projects", status: 200, body: try FixtureLoader.data("rest/projects.json"))
    }

    private func sessionsRoute(_ sessions: [Session]) throws -> Route {
        Route(method: "GET", path: "/api/v1/sessions", status: 200, body: try sessionsBody(sessions))
    }

    private func fixtureSessions() throws -> [Session] {
        try JSONCoding.decoder.decode(SessionsResponse.self, from: FixtureLoader.data("rest/sessions.json")).sessions
    }

    private func requestPaths(method: String) -> [String] {
        requests.value.filter { $0.httpMethod == method }.compactMap { $0.url?.path() }
    }

    // MARK: - refresh

    func testRefreshLoadsProjectsAndSessionsFromFixtures() async throws {
        install([
            try projectsRoute(),
            Route(method: "GET", path: "/api/v1/sessions", status: 200, body: try FixtureLoader.data("rest/sessions.json")),
        ])

        await store.refresh()

        XCTAssertEqual(store.projects.map(\.name), ["app", "notes"])
        XCTAssertEqual(store.sessions.count, 2)
        XCTAssertFalse(store.isLoading)
        XCTAssertTrue(store.hasLoaded)
        XCTAssertNil(store.errorMessage)
        XCTAssertEqual(Set(requestPaths(method: "GET")), ["/api/v1/projects", "/api/v1/sessions"])
    }

    func testRefreshMapsTransportErrorAndKeepsPreviousData() async throws {
        install([try projectsRoute(), try sessionsRoute(try fixtureSessions())])
        await store.refresh()
        XCTAssertEqual(store.sessions.count, 2)

        StubURLProtocol.handler = { _ in throw URLError(.cannotConnectToHost) }
        await store.refresh()

        XCTAssertEqual(store.errorMessage, "서버에 연결할 수 없습니다. Tailscale이 켜져 있는지 확인하세요.")
        XCTAssertEqual(store.sessions.count, 2, "실패해도 이전 목록은 남긴다")
        XCTAssertEqual(store.projects.count, 2)
        XCTAssertFalse(store.isLoading)
    }

    func testRefreshUsesServerMessageWhenOneRequestFails() async throws {
        install([
            try projectsRoute(),
            Route(
                method: "GET", path: "/api/v1/sessions", status: 500,
                body: Data(#"{"error":{"code":"internal","message":"세션 저장소를 읽을 수 없습니다"}}"#.utf8)
            ),
        ])

        await store.refresh()

        XCTAssertEqual(store.errorMessage, "세션 저장소를 읽을 수 없습니다")
        XCTAssertEqual(store.projects.count, 2, "성공한 쪽은 반영한다")
        XCTAssertTrue(store.sessions.isEmpty)
    }

    func testRefreshClearsErrorAfterSuccess() async throws {
        StubURLProtocol.handler = { _ in throw URLError(.cannotConnectToHost) }
        await store.refresh()
        XCTAssertNotNil(store.errorMessage)

        install([try projectsRoute(), try sessionsRoute([])])
        await store.refresh()
        XCTAssertNil(store.errorMessage)
    }

    // MARK: - derived lists

    func testActivePutsWaitingApprovalFirstThenUpdatedAtDescending() async throws {
        install([
            try projectsRoute(),
            try sessionsRoute([
                makeSession(id: "ses_running_old", status: .running, updatedAt: "2026-09-09T10:00:00Z"),
                makeSession(id: "ses_idle", status: .idle, updatedAt: "2026-09-09T13:00:00Z"),
                makeSession(id: "ses_waiting", status: .waitingApproval, updatedAt: "2026-09-09T09:00:00Z", pendingApprovals: 2),
                makeSession(id: "ses_running_new", status: .running, updatedAt: "2026-09-09T12:00:00Z"),
                makeSession(id: "ses_closed", status: .closed, updatedAt: "2026-09-09T14:00:00Z"),
                makeSession(id: "ses_error", status: .error, updatedAt: "2026-09-09T14:00:00Z"),
            ]),
        ])

        await store.refresh()

        XCTAssertEqual(store.active.map(\.id), ["ses_waiting", "ses_running_new", "ses_running_old"])
    }

    func testSessionsInProjectFiltersByExactCwdSortedByUpdatedAtDescending() async throws {
        install([
            try projectsRoute(),
            try sessionsRoute([
                makeSession(id: "ses_app_old", updatedAt: "2026-09-09T10:00:00Z", cwd: "/Users/alice/work/app"),
                makeSession(id: "ses_sub", updatedAt: "2026-09-09T12:00:00Z", cwd: "/Users/alice/work/app/sub"),
                makeSession(id: "ses_app_new", updatedAt: "2026-09-09T11:00:00Z", cwd: "/Users/alice/work/app"),
                makeSession(id: "ses_notes", updatedAt: "2026-09-09T13:00:00Z", cwd: "/Users/alice/work/notes"),
            ]),
        ])

        await store.refresh()

        XCTAssertEqual(store.sessions(inProject: "/Users/alice/work/app").map(\.id), ["ses_app_new", "ses_app_old"])
        XCTAssertEqual(store.sessions(inProject: "/Users/alice/work/notes").map(\.id), ["ses_notes"])
        XCTAssertTrue(store.sessions(inProject: "/Users/alice/work/none").isEmpty)
    }

    func testPendingApprovalTotalSumsAllSessions() async throws {
        install([
            try projectsRoute(),
            try sessionsRoute([
                makeSession(id: "ses_a", status: .waitingApproval, pendingApprovals: 2),
                makeSession(id: "ses_b", status: .waitingApproval, pendingApprovals: 1),
                makeSession(id: "ses_c", status: .idle),
            ]),
        ])

        await store.refresh()

        XCTAssertEqual(store.pendingApprovalTotal, 3)
    }

    func testOldestWaitingSessionPicksEarliestUpdatedWithPendingApprovals() async throws {
        install([
            try projectsRoute(),
            try sessionsRoute([
                makeSession(id: "ses_idle", status: .idle, updatedAt: "2026-09-09T08:00:00Z"),
                makeSession(id: "ses_wait_new", status: .waitingApproval, updatedAt: "2026-09-09T12:00:00Z", pendingApprovals: 1),
                makeSession(id: "ses_wait_old", status: .waitingApproval, updatedAt: "2026-09-09T09:00:00Z", pendingApprovals: 2),
                makeSession(id: "ses_running", status: .running, updatedAt: "2026-09-09T07:00:00Z"),
            ]),
        ])

        await store.refresh()

        XCTAssertEqual(store.oldestWaitingSession?.id, "ses_wait_old")
    }

    func testOldestWaitingSessionIsNilWithoutPendingApprovals() async throws {
        install([try projectsRoute(), try sessionsRoute([makeSession(id: "ses_idle", status: .idle)])])
        await store.refresh()
        XCTAssertNil(store.oldestWaitingSession)
    }

    func testRecentTakesTopTenByUpdatedAt() async throws {
        let sessions = (0..<12).map { index in
            makeSession(id: "ses_\(index)", updatedAt: "2026-09-09T\(String(format: "%02d", index)):00:00Z")
        }
        install([try projectsRoute(), try sessionsRoute(sessions)])

        await store.refresh()

        XCTAssertEqual(store.recent.count, 10)
        XCTAssertEqual(store.recent.first?.id, "ses_11")
        XCTAssertEqual(store.recent.last?.id, "ses_2")
    }

    // MARK: - create / close

    func testCreateSendsBodyAndPrependsSession() async throws {
        // fixture 의 id 는 sessions.json 첫 항목과 같으므로 새 id 로 바꿔 "추가" 를 검증한다.
        var newSession = try JSONCoding.decoder.decode(Session.self, from: FixtureLoader.data("rest/session.json"))
        newSession.id = "ses_01J8ZQ4K5N7P9R3S6T8V0W2XZZ"
        install([
            try projectsRoute(),
            try sessionsRoute(try fixtureSessions()),
            Route(method: "POST", path: "/api/v1/sessions", status: 201, body: try JSONCoding.encoder.encode(newSession)),
        ])
        await store.refresh()
        let before = store.sessions.count

        let created = try await store.create(agent: .claude, cwd: "/Users/alice/work/app", title: "로그인 버그 수정", mode: .ask)

        let post = try XCTUnwrap(requests.value.first { $0.httpMethod == "POST" })
        let body = try XCTUnwrap(post.httpBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json["agent"] as? String, "claude")
        XCTAssertEqual(json["cwd"] as? String, "/Users/alice/work/app")
        XCTAssertEqual(json["mode"] as? String, "ask")
        XCTAssertEqual(json["title"] as? String, "로그인 버그 수정")
        XCTAssertEqual(Set(json.keys), ["agent", "cwd", "mode", "title"])

        XCTAssertEqual(created.id, "ses_01J8ZQ4K5N7P9R3S6T8V0W2XZZ")
        XCTAssertEqual(store.sessions.first?.id, created.id, "새 세션은 목록 맨 앞에 온다")
        XCTAssertEqual(store.sessions.count, before + 1)
    }

    func testCreateOmitsTitleWhenNilAndReplacesExistingId() async throws {
        install([
            try projectsRoute(),
            try sessionsRoute(try fixtureSessions()),
            Route(method: "POST", path: "/api/v1/sessions", status: 201, body: try FixtureLoader.data("rest/session.json")),
        ])
        await store.refresh()

        _ = try await store.create(agent: .codex, cwd: "~/work/app", title: nil, mode: .plan)

        let post = try XCTUnwrap(requests.value.first { $0.httpMethod == "POST" })
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(post.httpBody)) as? [String: Any])
        XCTAssertEqual(json["agent"] as? String, "codex")
        XCTAssertEqual(json["mode"] as? String, "plan")
        XCTAssertNil(json["title"])
        XCTAssertEqual(store.sessions.filter { $0.id == "ses_01J8ZQ4K5N7P9R3S6T8V0W2XAB" }.count, 1, "같은 id 는 중복되지 않는다")
    }

    func testCreateRethrowsServerError() async throws {
        install([
            Route(
                method: "POST", path: "/api/v1/sessions", status: 400,
                body: Data(#"{"error":{"code":"invalid_request","message":"cwd가 존재하지 않습니다"}}"#.utf8)
            ),
        ])

        do {
            _ = try await store.create(agent: .claude, cwd: "/Users/alice/nope", title: nil, mode: .ask)
            XCTFail("400 은 throw 해야 한다")
        } catch let error as APIError {
            guard case .server(let code, _, let status) = error else { return XCTFail("server 오류여야 한다: \(error)") }
            XCTAssertEqual(code, .invalidRequest)
            XCTAssertEqual(status, 400)
        }
        XCTAssertTrue(store.sessions.isEmpty)
    }

    func testCloseUpdatesSessionStatusInPlace() async throws {
        let sessions = try fixtureSessions()
        let target = sessions[0]
        var closed = target
        closed.status = .closed
        closed.updatedAt = date("2026-09-09T12:00:00Z")
        install([
            try projectsRoute(),
            try sessionsRoute(sessions),
            Route(
                method: "POST", path: "/api/v1/sessions/\(target.id)/close", status: 200,
                body: try JSONCoding.encoder.encode(closed)
            ),
        ])
        await store.refresh()

        try await store.close(target)

        XCTAssertEqual(requestPaths(method: "POST"), ["/api/v1/sessions/\(target.id)/close"])
        XCTAssertEqual(store.sessions.count, 2)
        XCTAssertEqual(store.sessions.first { $0.id == target.id }?.status, .closed)
        XCTAssertEqual(store.sessions.first { $0.id == target.id }?.updatedAt, closed.updatedAt)
    }

    // MARK: - messages

    func testCreateErrorMessagesMapHomeAndMissingPathAndAgentUnavailable() {
        let forbidden = APIError.server(code: .forbidden, message: "outside home", status: 403)
        XCTAssertEqual(
            ErrorMessages.sessionCreateMessage(for: forbidden, agent: .claude),
            "접근할 수 없는 경로입니다. 홈 디렉토리 안의 경로를 입력하세요."
        )

        let missing = APIError.server(code: .invalidRequest, message: "cwd가 존재하지 않습니다: /x", status: 400)
        XCTAssertEqual(
            ErrorMessages.sessionCreateMessage(for: missing, agent: .claude),
            "디렉토리를 찾을 수 없습니다. 경로를 확인하세요."
        )

        let unavailable = APIError.server(code: .agentUnavailable, message: "codex 어댑터를 사용할 수 없습니다", status: 503)
        XCTAssertEqual(
            ErrorMessages.sessionCreateMessage(for: unavailable, agent: .codex),
            "Codex를 지금 사용할 수 없습니다. 설정에서 설치와 로그인 상태를 확인하세요."
        )

        XCTAssertEqual(
            ErrorMessages.sessionCreateMessage(for: APIError.transport(URLError(.timedOut)), agent: .claude),
            "서버에 연결할 수 없습니다. Tailscale이 켜져 있는지 확인하세요."
        )
        XCTAssertEqual(
            ErrorMessages.sessionCreateMessage(
                for: APIError.server(code: .internalError, message: "디스크가 가득 찼습니다", status: 500), agent: .claude
            ),
            "디스크가 가득 찼습니다"
        )
    }

    func testDisplayTitleFallsBackToPreviewFirstLineThenDefault() {
        XCTAssertEqual(makeSession(id: "a", title: "로그인 버그 수정", preview: "무시").displayTitle, "로그인 버그 수정")
        XCTAssertEqual(makeSession(id: "b", title: "", preview: "첫 줄\n둘째 줄").displayTitle, "첫 줄")
        XCTAssertEqual(makeSession(id: "c", title: "  ", preview: "  \n본문").displayTitle, "본문")
        XCTAssertEqual(makeSession(id: "d", title: "", preview: nil).displayTitle, "새 세션")
        XCTAssertEqual(makeSession(id: "e", title: "", preview: "").displayTitle, "새 세션")
    }

    func testStatusLabels() {
        XCTAssertEqual(SessionStatus.waitingApproval.label, "승인 대기")
        XCTAssertEqual(SessionStatus.running.label, "실행 중")
        XCTAssertEqual(SessionStatus.closed.label, "닫힘")
        XCTAssertEqual(SessionStatus.unknown.label, "알 수 없음")
    }
}
