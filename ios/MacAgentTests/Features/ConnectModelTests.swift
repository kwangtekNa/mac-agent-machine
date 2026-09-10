import Foundation
import XCTest
@testable import MacAgent

@MainActor
final class ConnectModelTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "ConnectModelTests.\(UUID().uuidString)"
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

    func testValidationMessagesForNormalizeErrors() async {
        let appState = makeAppState()
        let model = ConnectModel()
        let cases: [(String, String)] = [
            ("   ", "서버 주소를 입력하세요."),
            ("https://", "서버 주소 형식이 올바르지 않습니다. 예: https://macmini.tailnet.ts.net"),
            ("ftp://macmini", "http 또는 https 주소만 사용할 수 있습니다."),
            ("http://example.com", "example.com에는 https로 연결해야 합니다. 주소를 https://로 시작하세요."),
        ]
        for (input, expected) in cases {
            model.address = input
            await model.submit(using: appState)
            XCTAssertEqual(model.validationMessage, expected, input)
            XCTAssertEqual(appState.connection, .disconnected, "검증에 실패하면 연결을 시도하지 않는다: \(input)")
        }
    }

    func testCanSubmitRequiresNonEmptyAddress() {
        let model = ConnectModel()
        XCTAssertFalse(model.canSubmit)
        model.address = "  "
        XCTAssertFalse(model.canSubmit)
        model.address = "macmini.ts.net"
        XCTAssertTrue(model.canSubmit)
    }

    func testSubmitNormalizesAndConnects() async throws {
        let data = try FixtureLoader.data("rest/me.json")
        StubURLProtocol.handler = { request in StubURLProtocol.response(request, status: 200, body: data) }
        let appState = makeAppState()
        let model = ConnectModel()
        model.address = " http://127.0.0.1:7777/ "
        await model.submit(using: appState)

        XCTAssertNil(model.validationMessage)
        XCTAssertFalse(model.isSubmitting)
        XCTAssertEqual(appState.configStore.config?.baseURL, URL(string: "http://127.0.0.1:7777"))
        guard case .connected = appState.connection else {
            return XCTFail("connected 여야 한다: \(appState.connection)")
        }
    }

    func testPrefillsSavedAddress() {
        ServerConfigStore(defaults: defaults).save(ServerConfig(baseURL: URL(string: "https://macmini.ts.net")!))
        let appState = makeAppState()
        let model = ConnectModel(savedConfig: appState.configStore.config)
        XCTAssertEqual(model.address, "https://macmini.ts.net")
    }
}
