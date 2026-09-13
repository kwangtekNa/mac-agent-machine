import Foundation
import XCTest
@testable import MacAgent

/// `TeamsStore`: 3개 목록 병렬 로드와 부분 실패, 생성·편집·삭제의 목록 반영, 세션 ↔ 팀원 조인.
@MainActor
final class TeamsStoreTests: XCTestCase {
    private let baseURL = URL(string: "http://127.0.0.1:7777")!
    private let teamId = "team_01J8ZQ4K5N7P9R3S6T8V0W2XT1"
    private var store: TeamsStore!
    private let requests = Locked<[URLRequest]>([])

    private struct Route: Sendable {
        var method: String
        var path: String
        var status: Int
        var body: Data
    }

    override func setUp() async throws {
        try await super.setUp()
        store = TeamsStore(client: APIClient(baseURL: baseURL, session: StubURLProtocol.makeSession()))
        requests.value = []
    }

    override func tearDown() async throws {
        StubURLProtocol.handler = nil
        try await super.tearDown()
    }

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

    private func listRoutes() throws -> [Route] {
        [
            Route(method: "GET", path: "/api/v1/teams", status: 200, body: try FixtureLoader.data("rest/teams.json")),
            Route(method: "GET", path: "/api/v1/team-templates", status: 200, body: try FixtureLoader.data("rest/team-templates.json")),
            Route(method: "GET", path: "/api/v1/team-roles", status: 200, body: try FixtureLoader.data("rest/team-roles.json")),
        ]
    }

    private func fixtureTeam() throws -> Team {
        try JSONCoding.decoder.decode(Team.self, from: FixtureLoader.data("rest/team.json"))
    }

    private func session(id: String, team: SessionTeamRef?) -> Session {
        Session(
            id: id, agent: .codex, cwd: "/Users/alice/work/app", title: "", mode: .autoEdit, model: nil, status: .running,
            nativeId: nil, createdAt: Date(), updatedAt: Date(), lastSeq: 0, pendingApprovals: 0, preview: nil, team: team
        )
    }

    private func errorBody(_ code: String, _ message: String) -> Data {
        Data(#"{"error":{"code":"\#(code)","message":"\#(message)"}}"#.utf8)
    }

    // MARK: - refresh

    func testRefreshLoadsTeamsTemplatesAndPresets() async throws {
        install(try listRoutes())
        XCTAssertFalse(store.hasLoaded)

        await store.refresh()

        XCTAssertEqual(store.teams.map(\.name), ["backend"])
        XCTAssertEqual(store.templates.map(\.name), ["백엔드 2인"])
        XCTAssertEqual(store.presets.map(\.id), [.developer, .planner, .teamLead, .codeReviewer, .custom])
        XCTAssertTrue(store.hasLoaded)
        XCTAssertNil(store.errorMessage)
        XCTAssertFalse(store.isLoading)
    }

    func testRefreshPartialFailureKeepsPreviousValuesAndSetsMessage() async throws {
        install(try listRoutes())
        await store.refresh()

        var routes = try listRoutes()
        routes[1] = Route(method: "GET", path: "/api/v1/team-templates", status: 500, body: errorBody("internal", "템플릿을 읽을 수 없습니다"))
        install(routes)
        await store.refresh()

        XCTAssertEqual(store.errorMessage, "템플릿을 읽을 수 없습니다")
        XCTAssertEqual(store.templates.count, 1, "실패한 쪽은 이전 값을 유지한다")
        XCTAssertEqual(store.teams.count, 1)
        XCTAssertEqual(store.presets.count, 5)

        StubURLProtocol.handler = { _ in throw URLError(.cannotConnectToHost) }
        await store.refresh()
        XCTAssertEqual(store.errorMessage, ErrorMessages.cannotConnect)
        XCTAssertEqual(store.teams.count, 1)

        install(try listRoutes())
        await store.refresh()
        XCTAssertNil(store.errorMessage, "성공하면 문구를 지운다")
    }

    // MARK: - create / patch / delete

    func testCreateInsertsTeamAtFront() async throws {
        var created = try fixtureTeam()
        created.id = "team_01J8ZQ4K5N7P9R3S6T8V0W2XT9"
        created.name = "frontend"
        install(try listRoutes() + [
            Route(method: "POST", path: "/api/v1/teams", status: 201, body: try JSONCoding.encoder.encode(created)),
        ])
        await store.refresh()

        let request = CreateTeamRequest(
            cwd: "/Users/alice/work/app", name: "frontend",
            members: [MemberInput(name: "민수", role: .teamLead, agent: .claude, isLead: true)]
        )
        let team = try await store.create(request)

        XCTAssertEqual(team.id, created.id)
        XCTAssertEqual(store.teams.map(\.name), ["frontend", "backend"])
        let post = try XCTUnwrap(requests.value.first { $0.httpMethod == "POST" })
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(post.httpBody)) as? [String: Any])
        XCTAssertEqual(json["name"] as? String, "frontend")
        XCTAssertNil(json["templateId"])
    }

    func testCreateRethrowsServerErrorAndTeamMessagesMap() async throws {
        install([Route(method: "POST", path: "/api/v1/teams", status: 400, body: errorBody("invalid_request", "팀장은 정확히 1명이어야 합니다 (현재 0명)"))])
        do {
            _ = try await store.create(CreateTeamRequest(cwd: "/x", name: "t", members: []))
            XCTFail("400 은 throw 해야 한다")
        } catch {
            XCTAssertEqual(ErrorMessages.teamMessage(for: error), ErrorMessages.teamLeadRequired)
        }
        XCTAssertTrue(store.teams.isEmpty)

        XCTAssertEqual(
            ErrorMessages.teamMessage(for: APIError.server(code: .invalidRequest, message: "cwd 가 git 저장소가 아닙니다", status: 400)),
            ErrorMessages.teamNotGitRepo
        )
        XCTAssertEqual(
            ErrorMessages.teamMessage(for: APIError.server(code: .conflict, message: "같은 이름의 팀원이 있습니다: 민수", status: 409)),
            ErrorMessages.teamMemberConflict
        )
        XCTAssertEqual(
            ErrorMessages.teamMessage(for: APIError.server(code: .invalidRequest, message: "cwd 는 디렉토리여야 합니다", status: 400)),
            "cwd 는 디렉토리여야 합니다"
        )
    }

    func testPatchMemberReplacesTeamInPlace() async throws {
        var patched = try fixtureTeam()
        patched.members[1].name = "지연2"
        install(try listRoutes() + [
            Route(method: "PATCH", path: "/api/v1/teams/\(teamId)/members/\(patched.members[1].id)", status: 200, body: try JSONCoding.encoder.encode(patched)),
        ])
        await store.refresh()

        try await store.patchMember(teamId: teamId, memberId: patched.members[1].id, PatchMemberRequest(name: "지연2"))

        XCTAssertEqual(store.teams.count, 1)
        XCTAssertEqual(store.team(id: teamId)?.members[1].name, "지연2")
    }

    func testDeleteConflictRethrowsAPIErrorAndKeepWorktreesRetryRemoves() async throws {
        install(try listRoutes() + [
            Route(method: "DELETE", path: "/api/v1/teams/\(teamId)", status: 409, body: errorBody("conflict", "민수의 worktree 에 커밋되지 않은 변경이 있습니다")),
        ])
        await store.refresh()

        do {
            try await store.delete(id: teamId)
            XCTFail("409 는 throw 해야 한다")
        } catch let error as APIError {
            guard case .server(let code, _, let status) = error else { return XCTFail("server 오류여야 한다") }
            XCTAssertEqual(code, .conflict)
            XCTAssertEqual(status, 409)
            XCTAssertTrue(TeamsStore.isDirtyWorktreeConflict(error))
        }
        XCTAssertEqual(store.teams.count, 1, "실패하면 목록은 그대로")
        XCTAssertFalse(TeamsStore.isDirtyWorktreeConflict(APIError.transport(URLError(.timedOut))))

        install(try listRoutes() + [
            Route(method: "DELETE", path: "/api/v1/teams/\(teamId)", status: 200, body: Data(#"{"ok":true}"#.utf8)),
        ])
        try await store.delete(id: teamId, keepWorktrees: true)

        let delete = try XCTUnwrap(requests.value.last { $0.httpMethod == "DELETE" })
        XCTAssertEqual(delete.url?.query(), "keepWorktrees=true")
        XCTAssertTrue(store.teams.isEmpty)
    }

    // MARK: - models(for:)

    /// `GET /models?agent=` 를 쿼리까지 보고 응답한다.
    private func installModels() {
        let requests = self.requests
        StubURLProtocol.handler = { request in
            requests.withValue { $0.append(request) }
            guard request.url?.path() == "/api/v1/models" else { throw URLError(.unsupportedURL) }
            switch request.url?.query() {
            case "agent=claude": return StubURLProtocol.response(request, status: 200, body: try FixtureLoader.data("rest/models-claude.json"))
            case "agent=codex": return StubURLProtocol.response(request, status: 200, body: try FixtureLoader.data("rest/models-codex.json"))
            default: throw URLError(.unsupportedURL)
            }
        }
    }

    func testModelsForAgentCachesPerAgentForFiveMinutes() async throws {
        installModels()
        let now = Date()

        let claude = await store.models(for: .claude, now: now)
        XCTAssertEqual(claude.map(\.id), ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"])
        XCTAssertEqual(store.modelsByAgent[.claude]?.count, 3)
        XCTAssertEqual(requests.value.count, 1)

        let again = await store.models(for: .claude, now: now.addingTimeInterval(TeamsStore.modelsCacheDuration - 1))
        XCTAssertEqual(again.count, 3)
        XCTAssertEqual(requests.value.count, 1, "5분 안에는 다시 요청하지 않는다")

        let codex = await store.models(for: .codex, now: now)
        XCTAssertEqual(codex.map(\.id), ["gpt-5-codex", "gpt-5"])
        XCTAssertEqual(requests.value.map { $0.url?.query() }, ["agent=claude", "agent=codex"], "에이전트별로 따로 읽고 캐시한다")
        XCTAssertEqual(store.modelsByAgent[.codex]?.count, 2)
        XCTAssertEqual(store.modelsByAgent[.claude]?.count, 3)

        _ = await store.models(for: .claude, now: now.addingTimeInterval(TeamsStore.modelsCacheDuration + 1))
        XCTAssertEqual(requests.value.count, 3, "5분이 지나면 다시 읽는다")
        _ = await store.models(for: .claude, force: true, now: now)
        XCTAssertEqual(requests.value.count, 4, "force 는 캐시를 무시한다")
        XCTAssertNil(store.errorMessage)
    }

    func testModelsForAgentFailureIsSilentEmptyAndRetried() async throws {
        StubURLProtocol.handler = { _ in throw URLError(.cannotConnectToHost) }
        let empty = await store.models(for: .claude)
        XCTAssertEqual(empty, [])
        XCTAssertNil(store.errorMessage, "실패는 조용히")
        XCTAssertNil(store.modelsByAgent[.claude])

        installModels()
        let loaded = await store.models(for: .claude)
        XCTAssertEqual(loaded.count, 3, "실패는 캐시하지 않으므로 다음 호출이 다시 읽는다")

        StubURLProtocol.handler = { _ in throw URLError(.cannotConnectToHost) }
        let stale = await store.models(for: .claude, now: Date().addingTimeInterval(TeamsStore.modelsCacheDuration + 1))
        XCTAssertEqual(stale.count, 3, "만료 뒤 재조회가 실패하면 이전 캐시를 돌려준다")
        XCTAssertNil(store.errorMessage)
    }

    // MARK: - join

    func testTeamForSessionAndBadge() async throws {
        install(try listRoutes())
        await store.refresh()
        let dev = session(id: "ses_01J8ZQ4K5N7P9R3S6T8V0W2XS2", team: SessionTeamRef(teamId: teamId, memberId: "agt_01J8ZQ4K5N7P9R3S6T8V0W2XA2"))

        let joined = try XCTUnwrap(store.team(forSession: dev))
        XCTAssertEqual(joined.team.name, "backend")
        XCTAssertEqual(joined.member.name, "지연")
        XCTAssertEqual(TeamsStore.badge(for: dev, teams: store.teams), "🧑‍💻 지연 · backend")

        XCTAssertNil(store.team(forSession: session(id: "ses_plain", team: nil)))
        XCTAssertNil(TeamsStore.badge(for: session(id: "ses_plain", team: nil), teams: store.teams))
        let unknown = session(id: "ses_x", team: SessionTeamRef(teamId: "team_nope", memberId: "agt_nope"))
        XCTAssertNil(TeamsStore.badge(for: unknown, teams: store.teams), "모르는 팀이면 배지 없음")
        let unknownMember = session(id: "ses_y", team: SessionTeamRef(teamId: teamId, memberId: "agt_nope"))
        XCTAssertNil(TeamsStore.badge(for: unknownMember, teams: store.teams))
    }
}
