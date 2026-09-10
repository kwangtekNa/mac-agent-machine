import Foundation
import XCTest
@testable import MacAgent

/// 실제 개발 서버(`bash scripts/dev-smoke.sh --keep`)에 붙는 통합 테스트. 환경변수 `MAM_IT_SERVER` 가 없으면 건너뛴다.
/// 실행: `TEST_RUNNER_MAM_IT_SERVER=http://127.0.0.1:7777 xcodebuild test ... -only-testing:MacAgentTests/APIClientIntegrationTests`
final class APIClientIntegrationTests: XCTestCase {
    @MainActor
    func testMeCreateSessionAndReceiveSnapshot() async throws {
        guard let raw = ProcessInfo.processInfo.environment["MAM_IT_SERVER"], !raw.isEmpty else {
            throw XCTSkip("MAM_IT_SERVER 가 설정되지 않아 건너뜀")
        }
        let baseURL = try ServerConfigStore.normalize(raw)
        let client = APIClient(baseURL: baseURL)

        let healthy = try await client.health()
        XCTAssertTrue(healthy)
        let me = try await client.me()
        XCTAssertFalse(me.user.isEmpty)
        XCTAssertEqual(me.server.protocolVersion, 1)
        XCTAssertEqual(me.agents.count, 2)

        let session = try await client.createSession(CreateSessionRequest(agent: .claude, cwd: me.home, title: "ios-it"))
        XCTAssertEqual(session.agent, .claude)
        XCTAssertTrue([.starting, .idle].contains(session.status))

        let socket = SessionSocket(baseURL: baseURL, sessionId: session.id)
        let collector = EventCollector(socket)
        defer { collector.stop(); socket.disconnect() }
        socket.connect()
        let deadline = ContinuousClock.now + .seconds(5)
        while collector.events.isEmpty, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        guard case .sessionSnapshot(let snapshot)? = collector.events.first else {
            return XCTFail("첫 이벤트가 session.snapshot 이 아니다: \(String(describing: collector.events.first?.type)) state=\(socket.state)")
        }
        XCTAssertEqual(snapshot.sessionId, session.id)
        XCTAssertEqual(socket.state, .open)

        let closed = try await client.closeSession(id: session.id)
        XCTAssertEqual(closed.status, .closed)
    }
}
