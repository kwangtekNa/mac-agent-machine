import Foundation
import XCTest
@testable import MacAgent

/// `AppState` 의 세션별 모델 보관(LRU, `maxTimelineModels`) 과 UI 테스트용 서버 주소 override. 세션·방 혼합 축출은 `AppStateModelKeyTests`.
@MainActor
final class AppStateModelsTests: XCTestCase {
    private let defaults = UserDefaults(suiteName: "AppStateModelsTests")!

    override func tearDown() {
        defaults.removePersistentDomain(forName: "AppStateModelsTests")
        super.tearDown()
    }

    private func makeAppState(environment: [String: String] = [:]) -> AppState {
        AppState(configStore: ServerConfigStore(defaults: defaults), urlSession: StubURLProtocol.makeSession(), environment: environment)
    }

    private func makeClient() -> APIClient {
        APIClient(baseURL: URL(string: "http://127.0.0.1:1")!, session: StubURLProtocol.makeSession())
    }

    func testSameSessionReturnsSameTimelineModel() {
        let state = makeAppState()
        let client = makeClient()
        let a = state.timelineModel(for: "s1", client: client)
        let b = state.timelineModel(for: "s1", client: client)
        XCTAssertTrue(a === b)
        XCTAssertEqual(state.timelineModels.count, 1)
    }

    func testEvictsLeastRecentlyUsedBeyondLimit() {
        let state = makeAppState()
        let client = makeClient()
        for i in 1...AppState.maxTimelineModels {
            _ = state.timelineModel(for: "s\(i)", client: client)
        }
        // s1 을 다시 쓰면 가장 오래된 것은 s2 가 된다.
        let next = "s\(AppState.maxTimelineModels + 1)"
        _ = state.timelineModel(for: "s1", client: client)
        _ = state.timelineModel(for: next, client: client)
        XCTAssertEqual(state.timelineModels.count, AppState.maxTimelineModels)
        XCTAssertNotNil(state.timelineModels["s1"])
        XCTAssertNil(state.timelineModels["s2"])
        XCTAssertNotNil(state.timelineModels[next])
    }

    func testFileBrowserModelFollowsSessionAndCwd() {
        let state = makeAppState()
        let client = makeClient()
        let a = state.fileBrowserModel(for: "s1", cwd: "/Users/me/work", client: client)
        let b = state.fileBrowserModel(for: "s1", cwd: "/Users/me/work", client: client)
        XCTAssertTrue(a === b)
        let c = state.fileBrowserModel(for: "s1", cwd: "/Users/me/other", client: client)
        XCTAssertFalse(a === c)
        XCTAssertEqual(c.rootPath, "/Users/me/other")
    }

    func testDisconnectClearsModels() async {
        let state = makeAppState()
        _ = state.timelineModel(for: "s1", client: makeClient())
        state.disconnect()
        XCTAssertTrue(state.timelineModels.isEmpty)
    }

    func testUITestServerOverrideIsUsedWithoutSaving() async {
        let state = makeAppState(environment: [AppState.uiTestServerKey: "http://127.0.0.1:7777"])
        XCTAssertEqual(state.uiTestServerURL, URL(string: "http://127.0.0.1:7777"))
        await state.reconnectSavedServer()
        XCTAssertNil(state.configStore.config, "override 주소는 저장하지 않는다")
        XCTAssertNotEqual(state.connection, .disconnected)
        XCTAssertEqual(state.client?.baseURL, URL(string: "http://127.0.0.1:7777"))
    }

    func testEmptyOverrideIsIgnored() {
        let state = makeAppState(environment: [AppState.uiTestServerKey: ""])
        XCTAssertNil(state.uiTestServerURL)
    }
}

/// 카드·배너 접근성 문구 규칙.
final class AccessibilityTextTests: XCTestCase {
    func testApprovalHint() {
        let allow = ApprovalOption(id: "allow", label: "허용", style: .primary)
        XCTAssertEqual(ApprovalBannerState.accessibilityHint(for: allow, kind: .command), "이 명령 실행을 허용합니다")
        let deny = ApprovalOption(id: "deny", label: "거절", style: .destructive)
        XCTAssertEqual(ApprovalBannerState.accessibilityHint(for: deny, kind: .fileChange), "이 파일 변경을 거절합니다")
    }

    func testItemSummaryOnlyForTitledKinds() {
        XCTAssertEqual(ItemAccessibility.statusLabel(.completed), "완료")
        XCTAssertNil(ItemAccessibility.statusLabel(.unknown))
    }
}
