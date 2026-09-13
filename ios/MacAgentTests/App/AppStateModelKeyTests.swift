import Foundation
import XCTest
@testable import MacAgent

/// `AppState` 의 세션·방 혼합 LRU(8): 오래된 키부터 축출하며 `stop()` 을 부르고, `clearModels` 가 방도 지운다.
@MainActor
final class AppStateModelKeyTests: XCTestCase {
    private var suiteName: String!
    private var defaults: UserDefaults!

    override func setUp() async throws {
        try await super.setUp()
        suiteName = "AppStateModelKeyTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suiteName)
        try await super.tearDown()
    }

    private func makeAppState() -> AppState {
        AppState(configStore: ServerConfigStore(defaults: defaults), urlSession: StubURLProtocol.makeSession())
    }

    private func makeClient() -> APIClient {
        APIClient(baseURL: URL(string: "http://127.0.0.1:1")!, session: StubURLProtocol.makeSession())
    }

    func testLimitIsEightAndSameRoomReturnsSameModel() {
        XCTAssertEqual(AppState.maxTimelineModels, 8)
        let state = makeAppState()
        let client = makeClient()
        let a = state.roomModel(for: "t", roomId: "r1", client: client)
        let b = state.roomModel(for: "t", roomId: "r1", client: client)
        XCTAssertTrue(a === b)
        XCTAssertEqual(a.teamId, "t")
        XCTAssertEqual(a.roomId, "r1")
        XCTAssertEqual(state.roomModels.count, 1)
        XCTAssertNil(state.roomModel(for: "t", roomId: "r1"), "연결 전에는 nil")
    }

    func testMixedKeysEvictOldestFirstAndStopEvictedRoom() {
        let state = makeAppState()
        let client = makeClient()
        let r1 = state.roomModel(for: "t", roomId: "r1", client: client)
        _ = state.timelineModel(for: "s1", client: client)
        let r2 = state.roomModel(for: "t", roomId: "r2", client: client)
        r2.resume()
        XCTAssertNotNil(r2.socket, "resume 로 소켓을 열어 stop 을 관찰한다")
        _ = state.timelineModel(for: "s2", client: client)
        _ = state.roomModel(for: "t", roomId: "r1", client: client) // r1 을 다시 쓰면 가장 오래된 키는 s1
        _ = state.timelineModel(for: "s3", client: client)
        _ = state.roomModel(for: "t", roomId: "r3", client: client)
        _ = state.timelineModel(for: "s4", client: client)
        _ = state.roomModel(for: "t", roomId: "r4", client: client) // 8개

        _ = state.timelineModel(for: "s5", client: client) // 9 → s1 축출
        XCTAssertNil(state.timelineModels["s1"])
        XCTAssertNotNil(state.roomModels[.room(teamId: "t", roomId: "r1")])
        XCTAssertNotNil(state.roomModels[.room(teamId: "t", roomId: "r2")])

        _ = state.roomModel(for: "t", roomId: "r5", client: client) // → r2 축출
        XCTAssertNil(state.roomModels[.room(teamId: "t", roomId: "r2")])
        XCTAssertNil(r2.socket, "축출된 방 모델은 stop() 된다")
        XCTAssertTrue(state.roomModels[.room(teamId: "t", roomId: "r1")] === r1)
        XCTAssertEqual(state.timelineModels.count + state.roomModels.count, AppState.maxTimelineModels)
    }

    func testDisconnectClearsRoomsAndSelection() {
        let state = makeAppState()
        let client = makeClient()
        let room = state.roomModel(for: "t", roomId: "r1", client: client)
        room.resume()
        _ = state.timelineModel(for: "s1", client: client)
        state.selectedRoom = (teamId: "t", roomId: "r1")

        state.disconnect()

        XCTAssertTrue(state.roomModels.isEmpty)
        XCTAssertTrue(state.timelineModels.isEmpty)
        XCTAssertNil(room.socket)
        XCTAssertNil(state.selectedRoom)
    }
}
