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

    private func makeModel() -> FileBrowserModel {
        FileBrowserModel(
            client: APIClient(baseURL: URL(string: "http://127.0.0.1:7777")!, session: StubURLProtocol.makeSession()),
            rootPath: rootPath,
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
}
