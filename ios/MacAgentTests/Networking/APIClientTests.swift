import Foundation
import XCTest
@testable import MacAgent

final class APIClientTests: XCTestCase {
    private let baseURL = URL(string: "http://127.0.0.1:7777")!
    private var client: APIClient!
    private let recorded = Locked<[URLRequest]>([])

    override func setUp() {
        super.setUp()
        client = APIClient(baseURL: baseURL, session: StubURLProtocol.makeSession())
        recorded.value = []
    }

    override func tearDown() {
        StubURLProtocol.handler = nil
        super.tearDown()
    }

    /// 요청을 기록하고 status + body 로 응답한다. body 가 nil 이면 빈 본문.
    private func stub(status: Int, fixture: String? = nil, body: Data? = nil) throws {
        let data = try fixture.map { try FixtureLoader.data($0) } ?? body ?? Data()
        let recorded = self.recorded
        StubURLProtocol.handler = { request in
            var copy = request
            copy.httpBody = StubURLProtocol.body(of: request)
            recorded.withValue { $0.append(copy) }
            return StubURLProtocol.response(request, status: status, body: data)
        }
    }

    private var lastRequest: URLRequest? { recorded.value.last }

    // MARK: - 헤더·URL

    func testHeadersAndURL() async throws {
        try stub(status: 200, fixture: "rest/me.json")
        _ = try await client.me()
        let request = try XCTUnwrap(lastRequest)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.absoluteString, "http://127.0.0.1:7777/api/v1/me")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-MAM-Protocol"), "1")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "application/json")
        XCTAssertNil(request.value(forHTTPHeaderField: "Content-Type"), "본문 없는 요청에는 Content-Type 을 붙이지 않는다")
        XCTAssertNil(request.value(forHTTPHeaderField: "X-MAM-User"), "신원 헤더는 보내지 않는다(CRITICAL 1)")
        XCTAssertEqual(request.timeoutInterval, 30)
    }

    func testHealthUsesRootPathAndReturnsTrueOn200() async throws {
        try stub(status: 200, body: Data(#"{"ok":true}"#.utf8))
        let healthy = try await client.health()
        XCTAssertTrue(healthy)
        XCTAssertEqual(lastRequest?.url?.absoluteString, "http://127.0.0.1:7777/healthz")
    }

    func testListDirectoryQueryEncoding() async throws {
        try stub(status: 200, fixture: "rest/fs-list.json")
        _ = try await client.listDirectory(path: "/Users/alice/작업 폴더")
        let url = try XCTUnwrap(lastRequest?.url)
        XCTAssertEqual(url.path(), "/api/v1/fs/list")
        let rawQuery = try XCTUnwrap(url.query(percentEncoded: true))
        XCTAssertTrue(rawQuery.contains("%EC%9E%91%EC%97%85%20%ED%8F%B4%EB%8D%94"), rawQuery)
        XCTAssertFalse(rawQuery.contains(" "))
        let items = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems)
        XCTAssertEqual(items, [URLQueryItem(name: "path", value: "/Users/alice/작업 폴더")])

        _ = try await client.listDirectory(path: "~/work/c++")
        let url2 = try XCTUnwrap(lastRequest?.url)
        XCTAssertTrue(try XCTUnwrap(url2.query(percentEncoded: true)).contains("%2B%2B"), "서버가 + 를 공백으로 읽지 않도록 %2B 로 보낸다")
        let items2 = try XCTUnwrap(URLComponents(url: url2, resolvingAgainstBaseURL: false)?.queryItems)
        XCTAssertEqual(items2.first?.value, "~/work/c++")
    }

    func testGitDiffQueryAndReadFileTimeout() async throws {
        try stub(status: 200, fixture: "rest/git-diff.json")
        _ = try await client.gitDiff(cwd: "/Users/alice/work/app", path: "src/index.ts", staged: true)
        let items = try XCTUnwrap(URLComponents(url: XCTUnwrap(lastRequest?.url), resolvingAgainstBaseURL: false)?.queryItems)
        XCTAssertEqual(items, [
            URLQueryItem(name: "cwd", value: "/Users/alice/work/app"),
            URLQueryItem(name: "path", value: "src/index.ts"),
            URLQueryItem(name: "staged", value: "true"),
        ])

        try stub(status: 200, fixture: "rest/fs-read-text.json")
        _ = try await client.readFile(path: "/Users/alice/work/app/src/index.ts")
        XCTAssertEqual(lastRequest?.timeoutInterval, 60)
    }

    // MARK: - 디코드

    func testMeDecodesFixture() async throws {
        try stub(status: 200, fixture: "rest/me.json")
        let me = try await client.me()
        XCTAssertEqual(me.user, "alice")
        XCTAssertEqual(me.agents.map(\.kind), [.claude, .codex])
        XCTAssertEqual(me.server.protocolVersion, 1)
    }

    func testDecodingFailureMapsToDecoding() async throws {
        try stub(status: 200, body: Data(#"{"nope":true}"#.utf8))
        do {
            _ = try await client.me()
            XCTFail("throw 를 기대")
        } catch APIError.decoding {
        } catch {
            XCTFail("예상 밖 오류: \(error)")
        }
    }

    // MARK: - 오류 매핑

    func test403MapsToServerForbidden() async throws {
        try stub(status: 403, body: Data(#"{"error":{"code":"forbidden","message":"user mismatch"}}"#.utf8))
        do {
            _ = try await client.projects()
            XCTFail("throw 를 기대")
        } catch APIError.server(let code, let message, let status) {
            XCTAssertEqual(code, .forbidden)
            XCTAssertEqual(message, "user mismatch")
            XCTAssertEqual(status, 403)
        } catch {
            XCTFail("예상 밖 오류: \(error)")
        }
    }

    func test426MapsToUnsupportedProtocol() async throws {
        try stub(status: 426, body: Data(#"{"error":{"code":"invalid_request","message":"unsupported protocol version"}}"#.utf8))
        do {
            _ = try await client.me()
            XCTFail("throw 를 기대")
        } catch APIError.unsupportedProtocol {
        } catch {
            XCTFail("예상 밖 오류: \(error)")
        }
    }

    func test500WithoutBodyMapsToInternal() async throws {
        try stub(status: 500)
        do {
            _ = try await client.sessions()
            XCTFail("throw 를 기대")
        } catch APIError.server(let code, let message, let status) {
            XCTAssertEqual(code, .internalError)
            XCTAssertEqual(message, "HTTP 500")
            XCTAssertEqual(status, 500)
        } catch {
            XCTFail("예상 밖 오류: \(error)")
        }
    }

    func testTransportErrorMapsToTransport() async throws {
        StubURLProtocol.handler = { _ in throw URLError(.notConnectedToInternet) }
        do {
            _ = try await client.me()
            XCTFail("throw 를 기대")
        } catch APIError.transport(let underlying) {
            XCTAssertEqual((underlying as? URLError)?.code, .notConnectedToInternet)
        } catch {
            XCTFail("예상 밖 오류: \(error)")
        }
    }

    // MARK: - 요청 본문

    func testCreateSessionBody() async throws {
        try stub(status: 201, fixture: "rest/session.json")
        let session = try await client.createSession(
            CreateSessionRequest(agent: .claude, cwd: "/Users/alice/work/app", title: "로그인 버그 수정", mode: .ask)
        )
        XCTAssertEqual(session.id, "ses_01J8ZQ4K5N7P9R3S6T8V0W2XAB")
        let request = try XCTUnwrap(lastRequest)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.absoluteString, "http://127.0.0.1:7777/api/v1/sessions")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? NSDictionary)
        XCTAssertEqual(body, ["agent": "claude", "cwd": "/Users/alice/work/app", "title": "로그인 버그 수정", "mode": "ask"] as NSDictionary)
    }

    func testRespondApprovalBodyAndPath() async throws {
        try stub(status: 200, body: Data(#"{"ok":true}"#.utf8))
        try await client.respondApproval(
            sessionId: "ses_1", approvalId: "apr_1",
            ApprovalRespondRequest(optionId: "deny", message: "아니오")
        )
        let request = try XCTUnwrap(lastRequest)
        XCTAssertEqual(request.url?.absoluteString, "http://127.0.0.1:7777/api/v1/sessions/ses_1/approvals/apr_1")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? NSDictionary)
        XCTAssertEqual(body, ["optionId": "deny", "message": "아니오"] as NSDictionary)
    }

    // MARK: - 2026-09-10 추가분 (mkdir · usage · models · patch model/effort)

    func testMakeDirectoryBodyAndDecodes201() async throws {
        try stub(status: 201, fixture: "rest/fs-mkdir.json")
        let entry = try await client.makeDirectory(path: "~/work/new-app")
        XCTAssertEqual(entry.name, "new-app")
        XCTAssertEqual(entry.path, "/Users/alice/work/new-app")
        XCTAssertEqual(entry.type, .dir)
        XCTAssertNil(entry.size)
        let request = try XCTUnwrap(lastRequest)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.absoluteString, "http://127.0.0.1:7777/api/v1/fs/mkdir")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? NSDictionary)
        XCTAssertEqual(body, ["path": "~/work/new-app"] as NSDictionary)
    }

    func testMakeDirectory409MapsToConflict() async throws {
        try stub(status: 409, body: Data(#"{"error":{"code":"conflict","message":"already exists"}}"#.utf8))
        do {
            _ = try await client.makeDirectory(path: "/Users/alice/work/app")
            XCTFail("throw 를 기대")
        } catch APIError.server(let code, let message, let status) {
            XCTAssertEqual(code, .conflict)
            XCTAssertEqual(message, "already exists")
            XCTAssertEqual(status, 409)
        } catch {
            XCTFail("예상 밖 오류: \(error)")
        }
    }

    func testUsageDecodesFixture() async throws {
        try stub(status: 200, fixture: "rest/usage.json")
        let usage = try await client.usage()
        let request = try XCTUnwrap(lastRequest)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.absoluteString, "http://127.0.0.1:7777/api/v1/usage")
        XCTAssertNil(request.httpBody)
        XCTAssertEqual(usage.agents.map(\.kind), [.claude, .codex])
        XCTAssertEqual(usage.agents[0].limits.map(\.status), [.ok, .warning])
        XCTAssertTrue(usage.agents[1].live)

        try stub(status: 200, fixture: "rest/usage-empty.json")
        let empty = try await client.usage()
        XCTAssertTrue(empty.agents.allSatisfy { $0.limits.isEmpty && $0.observedAt == nil && $0.plan == nil })
    }

    func testModelsQueryAndDecodes() async throws {
        try stub(status: 200, fixture: "rest/models-claude.json")
        let claude = try await client.models(agent: .claude)
        let url = try XCTUnwrap(lastRequest?.url)
        XCTAssertEqual(url.path(), "/api/v1/models")
        let items = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems)
        XCTAssertEqual(items, [URLQueryItem(name: "agent", value: "claude")])
        XCTAssertEqual(claude.map(\.id), ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"])
        XCTAssertEqual(claude.filter(\.isDefault).map(\.id), ["claude-opus-5"])
        XCTAssertEqual(claude[0].efforts.count, 5)
        XCTAssertTrue(claude[2].efforts.isEmpty)

        try stub(status: 200, fixture: "rest/models-codex.json")
        let codex = try await client.models(agent: .codex)
        let items2 = try XCTUnwrap(URLComponents(url: XCTUnwrap(lastRequest?.url), resolvingAgainstBaseURL: false)?.queryItems)
        XCTAssertEqual(items2, [URLQueryItem(name: "agent", value: "codex")])
        XCTAssertEqual(codex.map(\.id), ["gpt-5-codex", "gpt-5"])
        XCTAssertEqual(codex[0].defaultEffort, "medium")
    }

    func testPatchSessionEncodesModelAndEffortAndOmitsEmptyFields() async throws {
        try stub(status: 200, fixture: "rest/session.json")
        let session = try await client.patchSession(id: "ses_1", PatchSessionRequest(model: "claude-opus-5", effort: "high"))
        XCTAssertEqual(session.effort, "high")
        XCTAssertEqual(session.usage?.context?.percent, 21)
        let request = try XCTUnwrap(lastRequest)
        XCTAssertEqual(request.httpMethod, "PATCH")
        XCTAssertEqual(request.url?.absoluteString, "http://127.0.0.1:7777/api/v1/sessions/ses_1")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? NSDictionary)
        XCTAssertEqual(body, ["model": "claude-opus-5", "effort": "high"] as NSDictionary)

        // effort 만
        _ = try await client.patchSession(id: "ses_1", PatchSessionRequest(effort: "low"))
        let body2 = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(lastRequest?.httpBody)) as? NSDictionary)
        XCTAssertEqual(body2, ["effort": "low"] as NSDictionary)

        // 기존 필드(title/mode)와 섞어도 nil 키는 생략
        _ = try await client.patchSession(id: "ses_1", PatchSessionRequest(title: "새 제목", mode: .plan, model: "gpt-5-codex"))
        let body3 = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(lastRequest?.httpBody)) as? NSDictionary)
        XCTAssertEqual(body3, ["title": "새 제목", "mode": "plan", "model": "gpt-5-codex"] as NSDictionary)

        // 400: 모델 목록에 없는 값
        try stub(status: 400, body: Data(#"{"error":{"code":"invalid_request","message":"unknown model"}}"#.utf8))
        do {
            _ = try await client.patchSession(id: "ses_1", PatchSessionRequest(model: "nope"))
            XCTFail("throw 를 기대")
        } catch APIError.server(let code, _, let status) {
            XCTAssertEqual(code, .invalidRequest)
            XCTAssertEqual(status, 400)
        } catch {
            XCTFail("예상 밖 오류: \(error)")
        }
    }
}
