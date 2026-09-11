import Foundation
import XCTest
@testable import MacAgent

@MainActor
final class FileBrowserModelTests: XCTestCase {
    private let rootPath = "/Users/alice/work/app"
    private var defaults: UserDefaults!
    private var suite: String!
    private let requests = Locked<[URLRequest]>([])

    override func setUp() {
        super.setUp()
        suite = "test.files.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
        requests.value = []
    }

    override func tearDown() {
        StubURLProtocol.handler = nil
        defaults.removePersistentDomain(forName: suite)
        super.tearDown()
    }

    private func makeModel(mode: FileBrowserModel.Mode = .files, rootPath: String? = nil) -> FileBrowserModel {
        FileBrowserModel(
            client: APIClient(baseURL: URL(string: "http://127.0.0.1:7777")!, session: StubURLProtocol.makeSession()),
            rootPath: rootPath ?? self.rootPath,
            mode: mode,
            defaults: defaults
        )
    }

    /// `/fs/list` 요청을 순서대로 응답한다. 응답 배열이 끝나면 마지막 것을 반복한다.
    private func install(_ responses: [(status: Int, body: Data)]) {
        let requests = self.requests
        let counter = Locked(0)
        StubURLProtocol.handler = { request in
            requests.withValue { $0.append(request) }
            let index = counter.withValue { value -> Int in
                defer { value += 1 }
                return min(value, responses.count - 1)
            }
            XCTAssertEqual(request.url?.path(), "/api/v1/fs/list")
            let response = responses[index]
            return StubURLProtocol.response(request, status: response.status, body: response.body)
        }
    }

    private func queryPath(of request: URLRequest) -> String? {
        request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }?
            .queryItems?.first { $0.name == "path" }?.value
    }

    private func errorBody(_ code: String, _ message: String) -> Data {
        Data("{\"error\":{\"code\":\"\(code)\",\"message\":\"\(message)\"}}".utf8)
    }

    /// "파일" 탭의 제자리 탐색(IOS.md 9.1): 현재 디렉토리와 상위 이름은 stack 만 따라간다.
    func testCurrentDirectoryPathAndParentNameFollowStack() {
        let model = makeModel()
        XCTAssertEqual(model.currentDirectoryPath, rootPath)
        XCTAssertNil(model.parentName)

        model.push(rootPath + "/src")
        XCTAssertEqual(model.currentDirectoryPath, rootPath + "/src")
        XCTAssertEqual(model.parentName, "app")

        model.push(rootPath + "/src/lib")
        XCTAssertEqual(model.currentDirectoryPath, rootPath + "/src/lib")
        XCTAssertEqual(model.parentName, "src")

        model.pop()
        XCTAssertEqual(model.currentDirectoryPath, rootPath + "/src")
        model.pop()
        XCTAssertNil(model.parentName)
        model.pop()
        XCTAssertEqual(model.currentDirectoryPath, rootPath, "루트에서 pop 은 아무 일도 하지 않는다")
    }

    func testLoadRootFromFixture() async throws {
        install([(200, try FixtureLoader.data("rest/fs-list.json"))])
        let model = makeModel()
        XCTAssertTrue(model.root.isLoading)
        await model.load(rootPath)
        XCTAssertEqual(model.root.listing?.entries.count, 9)
        XCTAssertNil(model.root.error)
        XCTAssertTrue(model.isGitRepo)
        XCTAssertEqual(queryPath(of: requests.value[0]), rootPath, "서버가 준 경로를 그대로 보낸다")
        XCTAssertEqual(model.directory(for: rootPath)?.path, rootPath)
    }

    func testHiddenFilterKeepsServerOrder() async throws {
        install([(200, try FixtureLoader.data("rest/fs-list.json"))])
        let model = makeModel()
        await model.load(rootPath)
        XCTAssertFalse(model.showHidden, "기본은 숨김 파일 감춤")
        let visible = model.visibleEntries(of: model.root).map(\.name)
        XCTAssertEqual(visible, ["src", "current", "index.ts", "notes.txt", "package.json", "app.sock"])
        model.toggleShowHidden()
        XCTAssertTrue(model.showHidden)
        XCTAssertEqual(model.visibleEntries(of: model.root).count, 9)
        XCTAssertEqual(model.visibleEntries(of: model.root).first?.name, ".git", "서버 정렬 유지")
        XCTAssertTrue(defaults.bool(forKey: FileBrowserModel.showHiddenKey), "UserDefaults 에 기억")
        XCTAssertTrue(makeModel().showHidden, "새 모델도 기억한 값을 읽는다")
    }

    func testPushPop() {
        let model = makeModel()
        let src = "\(rootPath)/src"
        model.push(src)
        model.push(src)
        XCTAssertEqual(model.stack.map(\.path), [src], "같은 경로 연속 push 는 한 번만")
        XCTAssertEqual(model.directory(for: src)?.path, src)
        model.push("\(src)/lib")
        XCTAssertEqual(model.stack.count, 2)
        model.pop()
        XCTAssertEqual(model.stack.map(\.path), [src])
        model.pop()
        model.pop()
        XCTAssertTrue(model.stack.isEmpty)
    }

    func testForbiddenAndNotFoundMessages() async {
        install([(403, errorBody("forbidden", "outside home")), (404, errorBody("not_found", "no such dir"))])
        let model = makeModel()
        await model.load(rootPath)
        XCTAssertNil(model.root.listing)
        XCTAssertEqual(model.root.error, ErrorMessages.pathForbidden)
        XCTAssertFalse(model.root.isLoading)

        let sub = "\(rootPath)/missing"
        model.push(sub)
        await model.load(sub)
        XCTAssertEqual(model.directory(for: sub)?.error, ErrorMessages.pathNotFound)
    }

    func testCacheThenRefresh() async throws {
        let full = try FixtureLoader.data("rest/fs-list.json")
        var trimmed = try JSONCoding.decoder.decode(FsListResponse.self, from: full)
        trimmed.entries.removeLast(3)
        install([(200, full), (200, try JSONCoding.encoder.encode(trimmed)), (500, errorBody("internal_error", "boom"))])
        let model = makeModel()
        let src = "\(rootPath)/src"

        await model.load(src)
        model.push(src)
        XCTAssertEqual(model.directory(for: src)?.listing?.entries.count, 9, "push 시 캐시가 바로 붙는다")

        await model.load(src)
        XCTAssertEqual(model.directory(for: src)?.listing?.entries.count, 6, "refresh 로 갱신")
        XCTAssertEqual(requests.value.count, 2)

        await model.load(src)
        XCTAssertEqual(model.directory(for: src)?.listing?.entries.count, 6, "refresh 실패 시 캐시 유지")
        XCTAssertEqual(model.directory(for: src)?.error, "boom")

        model.pop()
        model.push(src)
        XCTAssertEqual(model.directory(for: src)?.listing?.entries.count, 6)
        XCTAssertNil(model.directory(for: src)?.error, "다시 push 하면 오류는 지워진다")
    }

    func testDirectoryIdentityIsPathOnly() throws {
        let listing = try JSONCoding.decoder.decode(FsListResponse.self, from: try FixtureLoader.data("rest/fs-list.json"))
        let a = FileBrowserModel.Directory(path: rootPath)
        let b = FileBrowserModel.Directory(path: rootPath, listing: listing, error: "x")
        XCTAssertEqual(a, b)
        XCTAssertEqual(a.hashValue, b.hashValue)
        XCTAssertEqual(b.name, "app")
    }

    // MARK: - 디렉토리 피커 (IOS.md 9.2)

    func testDirectoriesModeShowsOnlyDirectories() async throws {
        install([(200, try FixtureLoader.data("rest/fs-list.json"))])
        let model = makeModel(mode: .directories)
        XCTAssertEqual(model.mode, .directories)
        XCTAssertEqual(makeModel().mode, .files, "기본은 파일 모드")
        await model.load(rootPath)
        XCTAssertEqual(model.visibleEntries(of: model.root).map(\.name), ["src"], "파일·심링크·기타는 숨긴다")
        model.toggleShowHidden()
        XCTAssertEqual(model.visibleEntries(of: model.root).map(\.name), [".git", "src"], "숨김 토글은 디렉토리에만 적용된다")
    }

    func testCreateDirectorySuccessReloadsParentAndPushes() async throws {
        let listing = try FixtureLoader.data("rest/fs-list.json")
        let created = try FixtureLoader.data("rest/fs-mkdir.json")   // /Users/alice/work/new-app
        let requests = self.requests
        StubURLProtocol.handler = { request in
            requests.withValue { $0.append(request) }
            switch request.url?.path() {
            case "/api/v1/fs/mkdir": return StubURLProtocol.response(request, status: 201, body: created)
            case "/api/v1/fs/list": return StubURLProtocol.response(request, status: 200, body: listing)
            default: throw URLError(.unsupportedURL)
            }
        }
        let model = makeModel(mode: .directories)
        let error = await model.createDirectory(named: " new-app ", in: rootPath)
        XCTAssertNil(error)

        let mkdir = try XCTUnwrap(requests.value.first { $0.url?.path() == "/api/v1/fs/mkdir" })
        XCTAssertEqual(mkdir.httpMethod, "POST")
        let body = try XCTUnwrap(StubURLProtocol.body(of: mkdir))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
        XCTAssertEqual(json, ["path": "\(rootPath)/new-app"], "이름은 다듬어 부모 경로 뒤에 붙인다")
        XCTAssertEqual(
            requests.value.map { $0.url?.path() }, ["/api/v1/fs/mkdir", "/api/v1/fs/list"],
            "성공하면 부모 목록을 다시 읽는다"
        )
        XCTAssertEqual(model.stack.map(\.path), ["/Users/alice/work/new-app"], "서버가 돌려준 경로로 push 한다")
        XCTAssertEqual(model.root.listing?.entries.count, 9)
    }

    func testCreateDirectoryUsesServerPathOfParentWhenKnown() async throws {
        let listing = try FixtureLoader.data("rest/fs-list.json")   // path /Users/alice/work/app
        let created = try FixtureLoader.data("rest/fs-mkdir.json")
        let requests = self.requests
        StubURLProtocol.handler = { request in
            requests.withValue { $0.append(request) }
            switch request.url?.path() {
            case "/api/v1/fs/mkdir": return StubURLProtocol.response(request, status: 201, body: created)
            default: return StubURLProtocol.response(request, status: 200, body: listing)
            }
        }
        let model = makeModel(mode: .directories, rootPath: "~")
        await model.load("~")
        XCTAssertEqual(model.currentPath, "/Users/alice/work/app", "루트 `~` 는 서버가 준 절대 경로로 보인다")
        _ = await model.createDirectory(named: "new-app", in: "~")
        let mkdir = try XCTUnwrap(requests.value.first { $0.url?.path() == "/api/v1/fs/mkdir" })
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(StubURLProtocol.body(of: mkdir))) as? [String: String])
        XCTAssertEqual(json, ["path": "/Users/alice/work/app/new-app"])
        XCTAssertEqual(model.stack.map(\.path), ["/Users/alice/work/new-app"])
        XCTAssertEqual(model.currentPath, "/Users/alice/work/new-app")
    }

    func testCreateDirectoryErrorMessages() async {
        let responses = Locked<[(Int, Data)]>([
            (409, errorBody("conflict", "이미 존재하는 경로입니다")),
            (400, errorBody("invalid_request", "경로에 제어 문자가 있습니다")),
            (403, errorBody("forbidden", "outside home")),
        ])
        StubURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path(), "/api/v1/fs/mkdir")
            let next = responses.withValue { $0.removeFirst() }
            return StubURLProtocol.response(request, status: next.0, body: next.1)
        }
        let model = makeModel(mode: .directories)
        let conflict = await model.createDirectory(named: "dup", in: rootPath)
        XCTAssertEqual(conflict, ErrorMessages.directoryExists)
        let invalid = await model.createDirectory(named: "weird", in: rootPath)
        XCTAssertEqual(invalid, "경로에 제어 문자가 있습니다", "400 은 서버 메시지 그대로")
        let forbidden = await model.createDirectory(named: "x", in: rootPath)
        XCTAssertEqual(forbidden, "outside home", "403 도 서버 메시지 그대로")
        XCTAssertTrue(model.stack.isEmpty, "실패하면 push 하지 않는다")
    }

    func testCreateDirectoryRejectsInvalidNameBeforeRequest() async {
        StubURLProtocol.handler = { _ in
            XCTFail("잘못된 이름은 서버에 보내지 않는다")
            throw URLError(.unsupportedURL)
        }
        let model = makeModel(mode: .directories)
        let message = await model.createDirectory(named: "a/b", in: rootPath)
        XCTAssertEqual(message, DirectoryNameValidation.validate("a/b"))
        XCTAssertNotNil(message)
        XCTAssertTrue(model.stack.isEmpty)
    }

    func testPathsUnderHome() {
        XCTAssertEqual(
            FileBrowserModel.pathsUnderHome("/Users/alice", target: "/Users/alice/work/app"),
            ["/Users/alice/work", "/Users/alice/work/app"]
        )
        XCTAssertEqual(FileBrowserModel.pathsUnderHome("/Users/alice", target: "~/work"), ["/Users/alice/work"])
        XCTAssertEqual(FileBrowserModel.pathsUnderHome("/Users/alice", target: "/Users/alice/work/"), ["/Users/alice/work"])
        XCTAssertEqual(FileBrowserModel.pathsUnderHome("/Users/alice", target: "~"), [])
        XCTAssertEqual(FileBrowserModel.pathsUnderHome("/Users/alice", target: "/Users/alice"), [])
        XCTAssertEqual(FileBrowserModel.pathsUnderHome("/Users/alice", target: "/Users/bob/x"), [], "홈 밖은 시작점이 없다")
        XCTAssertEqual(FileBrowserModel.pathsUnderHome("/Users/alice", target: "/Users/alicex/y"), [], "접두어만 같은 경로는 홈 밖")
    }

    func testRevealPushesIntermediateDirectoriesAfterRootLoads() async throws {
        install([(200, try FixtureLoader.data("rest/fs-list.json"))])   // path /Users/alice/work/app
        let model = makeModel(mode: .directories, rootPath: "~")
        model.reveal("/Users/alice/work/app/src/lib")
        XCTAssertTrue(model.stack.isEmpty, "홈의 절대 경로를 모르면 아무것도 하지 않는다")
        await model.load("~")
        model.reveal("/Users/alice/work/app/src/lib")
        XCTAssertEqual(model.stack.map(\.path), ["/Users/alice/work/app/src", "/Users/alice/work/app/src/lib"])
        XCTAssertEqual(model.currentPath, "/Users/alice/work/app/src/lib")
        model.reveal("~")
        XCTAssertTrue(model.stack.isEmpty)
    }
}
