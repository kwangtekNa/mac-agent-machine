import Foundation
import XCTest
@testable import MacAgent

@MainActor
final class AppStateTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName: String!
    private let serverURL = URL(string: "http://127.0.0.1:7777")!

    override func setUp() {
        super.setUp()
        suiteName = "AppStateTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        StubURLProtocol.handler = nil
        defaults.removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    private func makeAppState() -> AppState {
        AppState(configStore: ServerConfigStore(defaults: defaults), urlSession: StubURLProtocol.makeSession())
    }

    private func stub(status: Int, fixture: String? = nil, body: Data = Data()) throws {
        let data = try fixture.map { try FixtureLoader.data($0) } ?? body
        StubURLProtocol.handler = { request in StubURLProtocol.response(request, status: status, body: data) }
    }

    func testConnectSucceedsAndSavesConfig() async throws {
        try stub(status: 200, fixture: "rest/me.json")
        let appState = makeAppState()
        await appState.connect(to: serverURL)

        guard case .connected(let me) = appState.connection else {
            return XCTFail("connected 여야 한다: \(appState.connection)")
        }
        XCTAssertEqual(me.user, "alice")
        XCTAssertEqual(me.agents.count, 2)
        XCTAssertEqual(appState.configStore.config?.baseURL, serverURL)
        XCTAssertEqual(appState.client?.baseURL, serverURL)
    }

    func testConnectMaps403ToRegistrationMessage() async throws {
        try stub(status: 403, body: Data(#"{"error":{"code":"forbidden","message":"unknown user"}}"#.utf8))
        let appState = makeAppState()
        await appState.connect(to: serverURL)

        XCTAssertEqual(
            appState.connection,
            .failed(message: "이 계정은 서버에 등록되어 있지 않습니다. 관리자에게 이메일 등록을 요청하세요.")
        )
        XCTAssertEqual(appState.configStore.config?.baseURL, serverURL, "실패해도 주소는 남겨 다시 시도할 수 있게 한다")
    }

    func testConnectMapsTransportErrorAnd426() async throws {
        StubURLProtocol.handler = { _ in throw URLError(.cannotConnectToHost) }
        let appState = makeAppState()
        await appState.connect(to: serverURL)
        XCTAssertEqual(appState.connection, .failed(message: "서버에 연결할 수 없습니다. Tailscale이 켜져 있는지 확인하세요."))

        try stub(status: 426)
        await appState.connect(to: serverURL)
        XCTAssertEqual(appState.connection, .failed(message: "앱을 업데이트해야 합니다."))
    }

    func testConnectUsesServerMessageForOtherErrors() async throws {
        try stub(status: 500, body: Data(#"{"error":{"code":"internal","message":"디스크가 가득 찼습니다"}}"#.utf8))
        let appState = makeAppState()
        await appState.connect(to: serverURL)
        XCTAssertEqual(appState.connection, .failed(message: "디스크가 가득 찼습니다"))
    }

    func testReconnectWithoutSavedServerStaysDisconnected() async {
        let appState = makeAppState()
        await appState.reconnectSavedServer()
        XCTAssertEqual(appState.connection, .disconnected)
        XCTAssertNil(appState.client)
    }

    func testReconnectUsesSavedServer() async throws {
        try stub(status: 200, fixture: "rest/me.json")
        ServerConfigStore(defaults: defaults).save(ServerConfig(baseURL: serverURL))
        let appState = makeAppState()
        await appState.reconnectSavedServer()
        guard case .connected = appState.connection else {
            return XCTFail("저장된 서버로 자동 연결해야 한다: \(appState.connection)")
        }
    }

    func testDisconnectClearsConfigAndClient() async throws {
        try stub(status: 200, fixture: "rest/me.json")
        let appState = makeAppState()
        await appState.connect(to: serverURL)
        appState.disconnect()

        XCTAssertEqual(appState.connection, .disconnected)
        XCTAssertNil(appState.client)
        XCTAssertNil(appState.configStore.config)
        XCTAssertNil(defaults.data(forKey: ServerConfigStore.defaultsKey))
    }

    func testRefreshMeUpdatesConnectedValue() async throws {
        try stub(status: 200, fixture: "rest/me.json")
        let appState = makeAppState()
        await appState.connect(to: serverURL)

        var me = try JSONCoding.decoder.decode(MeResponse.self, from: FixtureLoader.data("rest/me.json"))
        me.agents[1].loggedIn = true
        me.agents[1].account = "alice@example.com"
        try stub(status: 200, body: JSONCoding.encoder.encode(me))
        await appState.refreshMe()

        guard case .connected(let refreshed) = appState.connection else {
            return XCTFail("connected 여야 한다: \(appState.connection)")
        }
        XCTAssertEqual(refreshed.agents[1].loggedIn, true)
    }
}
