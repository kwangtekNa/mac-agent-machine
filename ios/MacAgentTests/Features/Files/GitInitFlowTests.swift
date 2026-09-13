import Foundation
import XCTest
@testable import MacAgent

/// 저장소 초기화 흐름(`GitInitFlow` 문구 규칙 + `GitInitModel` 상태 전이). 초기화는 항상 dryRun 미리보기 → 확인 → 실제 순서다.
@MainActor
final class GitInitFlowTests: XCTestCase {
    private let cwd = "/Users/alice/work/new-app"
    private let requests = Locked<[URLRequest]>([])

    override func setUp() {
        super.setUp()
        requests.value = []
    }

    override func tearDown() {
        StubURLProtocol.handler = nil
        super.tearDown()
    }

    private func preview(files: Int = 12, bytes: Int = 48213, createdGitignore: Bool = true) -> GitInitResponse {
        GitInitResponse(initialized: false, branch: "main", commit: nil, files: files, bytes: bytes, createdGitignore: createdGitignore)
    }

    // MARK: - 문구

    func testConfirmMessageWithFilesAndGitignore() {
        XCTAssertEqual(
            GitInitFlow.confirmMessage(preview()),
            "파일 12개 · \(FileFormat.size(48213))를 첫 커밋에 담습니다. 기본 .gitignore 를 만듭니다."
        )
    }

    func testConfirmMessageOmitsGitignoreSentenceWhenItAlreadyExists() {
        XCTAssertEqual(
            GitInitFlow.confirmMessage(preview(createdGitignore: false)),
            "파일 12개 · \(FileFormat.size(48213))를 첫 커밋에 담습니다."
        )
    }

    func testConfirmMessageForEmptyDirectory() {
        XCTAssertEqual(GitInitFlow.confirmMessage(preview(files: 0, bytes: 0)), "빈 저장소를 만듭니다. 기본 .gitignore 를 만듭니다.")
        XCTAssertEqual(GitInitFlow.confirmMessage(preview(files: 0, bytes: 0, createdGitignore: false)), "빈 저장소를 만듭니다.")
    }

    func testDoneMessage() throws {
        let result = try JSONCoding.decoder.decode(GitInitResponse.self, from: FixtureLoader.data("rest/git-init.json"))
        XCTAssertEqual(GitInitFlow.doneMessage(result), "git 저장소를 만들었습니다 (main, 파일 12개)")
    }

    func testNeedsInitAndBusy() {
        XCTAssertTrue(GitInitFlow.Phase.notRepo.needsInit)
        XCTAssertTrue(GitInitFlow.Phase.previewing.needsInit)
        XCTAssertTrue(GitInitFlow.Phase.confirming(preview()).needsInit)
        XCTAssertTrue(GitInitFlow.Phase.initializing.needsInit)
        XCTAssertFalse(GitInitFlow.Phase.idle.needsInit)
        XCTAssertFalse(GitInitFlow.Phase.checking.needsInit)
        XCTAssertFalse(GitInitFlow.Phase.done(preview()).needsInit)
        XCTAssertFalse(GitInitFlow.Phase.failed("x").needsInit, "확인 실패는 서버가 최종 판단하도록 제출을 막지 않는다")
        XCTAssertTrue(GitInitFlow.Phase.previewing.isBusy)
        XCTAssertTrue(GitInitFlow.Phase.initializing.isBusy)
        XCTAssertFalse(GitInitFlow.Phase.notRepo.isBusy)
        XCTAssertEqual(GitInitFlow.Phase.confirming(preview()).preview, preview())
        XCTAssertNil(GitInitFlow.Phase.notRepo.preview)
    }

    // MARK: - 모델

    private func makeModel() -> GitInitModel {
        GitInitModel(client: APIClient(baseURL: URL(string: "http://127.0.0.1:7777")!, session: StubURLProtocol.makeSession()))
    }

    private var notRepoStatus: Data { Data(#"{"isRepo":false,"branch":null,"ahead":0,"behind":0,"entries":[]}"#.utf8) }

    private func errorBody(_ code: String, _ message: String) -> Data {
        Data("{\"error\":{\"code\":\"\(code)\",\"message\":\"\(message)\"}}".utf8)
    }

    /// `/git/status` 와 `/git/init` 응답을 경로별 큐로 준다. 큐가 비면 마지막 것을 반복한다.
    private func install(status: [(Int, Data)] = [], initRepo: [(Int, Data)] = []) {
        let requests = self.requests
        let statuses = Locked(status)
        let inits = Locked(initRepo)
        StubURLProtocol.handler = { request in
            var copy = request
            copy.httpBody = StubURLProtocol.body(of: request)
            requests.withValue { $0.append(copy) }
            let next: (Int, Data)?
            switch request.url?.path() {
            case "/api/v1/git/status": next = Self.take(statuses)
            case "/api/v1/git/init": next = Self.take(inits)
            default: next = nil
            }
            guard let next else { throw URLError(.unsupportedURL) }
            return StubURLProtocol.response(request, status: next.0, body: next.1)
        }
    }

    /// 큐의 첫 응답을 꺼낸다. 마지막 하나는 남겨 반복한다.
    private nonisolated static func take(_ queue: Locked<[(Int, Data)]>) -> (Int, Data)? {
        queue.withValue { values in
            guard let first = values.first else { return nil }
            if values.count > 1 { values.removeFirst() }
            return first
        }
    }

    private func body(of request: URLRequest) throws -> NSDictionary {
        try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? NSDictionary)
    }

    private func queryCwd(of request: URLRequest) -> String? {
        request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }?.queryItems?.first { $0.name == "cwd" }?.value
    }

    func testCheckNotRepo() async {
        install(status: [(200, notRepoStatus)])
        let model = makeModel()
        XCTAssertEqual(model.flow.phase, .idle)
        await model.check(cwd: cwd)
        XCTAssertEqual(model.flow.phase, .notRepo)
        XCTAssertEqual(requests.value.map { $0.url?.path() }, ["/api/v1/git/status"])
        XCTAssertEqual(queryCwd(of: requests.value[0]), cwd)
    }

    func testCheckRepoIsIdle() async throws {
        install(status: [(200, try FixtureLoader.data("rest/git-status.json"))])
        let model = makeModel()
        await model.check(cwd: cwd)
        XCTAssertEqual(model.flow.phase, .idle)
    }

    func testCheckFailureAndEmptyPath() async {
        install(status: [(404, errorBody("not_found", "no such dir"))])
        let model = makeModel()
        await model.check(cwd: cwd)
        XCTAssertEqual(model.flow.phase, .failed(ErrorMessages.pathNotFound))
        await model.check(cwd: "")
        XCTAssertEqual(model.flow.phase, .idle, "빈 경로는 확인하지 않는다")
        XCTAssertEqual(requests.value.count, 1)
    }

    func testPreviewSendsDryRunAndWaitsForConfirmation() async throws {
        install(initRepo: [(200, try FixtureLoader.data("rest/git-init-dry-run.json"))])
        let model = makeModel()
        await model.preview(cwd: cwd)
        XCTAssertEqual(model.flow.phase, .confirming(preview()))
        let request = try XCTUnwrap(requests.value.last)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path(), "/api/v1/git/init")
        XCTAssertEqual(try body(of: request), ["cwd": cwd, "dryRun": true] as NSDictionary)

        model.cancelPreview()
        XCTAssertEqual(model.flow.phase, .notRepo, "확인 다이얼로그를 닫으면 다시 저장소 아님")
    }

    func testConfirmSendsWithoutDryRunAndFinishes() async throws {
        install(initRepo: [(201, try FixtureLoader.data("rest/git-init.json"))])
        let model = makeModel()
        await model.confirm(cwd: cwd)
        guard case .done(let result) = model.flow.phase else { return XCTFail("done 을 기대: \(model.flow.phase)") }
        XCTAssertTrue(result.initialized)
        XCTAssertEqual(result.branch, "main")
        XCTAssertEqual(result.commit, "9f1c2b3a4d5e6f708192a3b4c5d6e7f8091a2b3c")
        let request = try XCTUnwrap(requests.value.last)
        XCTAssertEqual(try body(of: request), ["cwd": cwd] as NSDictionary, "실제 초기화 본문에는 dryRun 키가 없다")
        XCTAssertEqual(requests.value.count, 1)
    }

    func testConfirmConflictKeepsMessageWhenStillNotRepo() async {
        install(status: [(200, notRepoStatus)], initRepo: [(409, errorBody("conflict", "이미 git 저장소입니다: /x"))])
        let model = makeModel()
        await model.confirm(cwd: cwd)
        XCTAssertEqual(model.flow.phase, .failed(ErrorMessages.gitInitConflict))
        XCTAssertEqual(requests.value.map { $0.url?.path() }, ["/api/v1/git/init", "/api/v1/git/status"], "409 뒤에는 상태를 다시 확인한다")
    }

    func testConfirmConflictBecomesIdleWhenRepoNowExists() async throws {
        install(status: [(200, try FixtureLoader.data("rest/git-status.json"))], initRepo: [(409, errorBody("conflict", "이미 git 저장소입니다: /x"))])
        let model = makeModel()
        await model.confirm(cwd: cwd)
        XCTAssertEqual(model.flow.phase, .idle, "그 사이 저장소가 됐으면 그대로 쓴다")
    }

    func testPreviewFailureMessages() async {
        install(initRepo: [(403, errorBody("forbidden", "outside home"))])
        let model = makeModel()
        await model.preview(cwd: cwd)
        XCTAssertEqual(model.flow.phase, .failed(ErrorMessages.pathForbidden))

        install(initRepo: [(400, errorBody("invalid_request", "cwd 가 존재하지 않습니다"))])
        await model.preview(cwd: cwd)
        XCTAssertEqual(model.flow.phase, .failed("cwd 가 존재하지 않습니다"), "400 은 서버 메시지 그대로")

        install(initRepo: [(500, errorBody("internal", "boom"))])
        await model.preview(cwd: cwd)
        XCTAssertEqual(model.flow.phase, .failed("boom"))

        model.reset()
        XCTAssertEqual(model.flow, GitInitFlow())
    }

    func testGitInitMessages() {
        XCTAssertEqual(ErrorMessages.gitInitConflict, "이미 git 저장소입니다.")
        XCTAssertEqual(ErrorMessages.gitInitMessage(for: APIError.server(code: .conflict, message: "x", status: 409)), ErrorMessages.gitInitConflict)
        XCTAssertEqual(ErrorMessages.gitInitMessage(for: APIError.server(code: .invalidRequest, message: "서버 문구", status: 400)), "서버 문구")
        XCTAssertEqual(ErrorMessages.gitInitMessage(for: APIError.server(code: .forbidden, message: "x", status: 403)), ErrorMessages.pathForbidden)
        XCTAssertEqual(ErrorMessages.gitInitMessage(for: APIError.transport(URLError(.timedOut))), ErrorMessages.cannotConnect)
    }
}
