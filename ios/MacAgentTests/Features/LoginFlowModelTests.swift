import Foundation
import XCTest
@testable import MacAgent

@MainActor
final class LoginFlowModelTests: XCTestCase {
    private let baseURL = URL(string: "http://127.0.0.1:7777")!
    private var client: APIClient!

    /// 폴링 sleep 기록. `parkAfter` 번째 이후 sleep 은 취소될 때까지 잔다.
    private final class PollSleeper: @unchecked Sendable {
        private let lock = NSLock()
        private var storedDurations: [Duration] = []
        private let parkAfter: Int

        init(parkAfter: Int = .max) { self.parkAfter = parkAfter }

        var durations: [Duration] { lock.withLock { storedDurations } }

        func sleep(_ duration: Duration) async throws {
            let park: Bool = lock.withLock {
                storedDurations.append(duration)
                return storedDurations.count > parkAfter
            }
            if park { try await Task.sleep(for: .seconds(3600)) }
        }
    }

    /// 경로별 응답 스크립트. `/auth/.../login/<flowId>` GET 은 `statuses` 를 순서대로 돌려주고 마지막 값을 반복한다.
    private struct Script: Sendable {
        var start: (Int, Data)
        var code: (Int, Data) = (200, Data(#"{"ok":true}"#.utf8))
        var statuses: [(Int, Data)] = []
    }

    private let requests = Locked<[URLRequest]>([])
    private let statusCalls = Locked<Int>(0)

    override func setUp() {
        super.setUp()
        client = APIClient(baseURL: baseURL, session: StubURLProtocol.makeSession())
        requests.value = []
        statusCalls.value = 0
    }

    override func tearDown() {
        StubURLProtocol.handler = nil
        super.tearDown()
    }

    private func install(_ script: Script) {
        let requests = self.requests
        let statusCalls = self.statusCalls
        StubURLProtocol.handler = { request in
            var copy = request
            copy.httpBody = StubURLProtocol.body(of: request)
            requests.withValue { $0.append(copy) }
            let path = request.url?.path() ?? ""
            let (status, body): (Int, Data)
            if request.httpMethod == "POST", path.hasSuffix("/login") {
                (status, body) = script.start
            } else if request.httpMethod == "POST", path.hasSuffix("/code") {
                (status, body) = script.code
            } else {
                let index = statusCalls.withValue { calls -> Int in
                    calls += 1
                    return calls - 1
                }
                (status, body) = script.statuses[min(index, script.statuses.count - 1)]
            }
            return StubURLProtocol.response(request, status: status, body: body)
        }
    }

    private func json(_ text: String) -> Data { Data(text.utf8) }

    private func makeModel(agent: AgentKind, sleeper: PollSleeper) -> LoginFlowModel {
        LoginFlowModel(agent: agent, client: client, sleep: { try await sleeper.sleep($0) })
    }

    // MARK: - needsCode == true (Claude)

    func testClaudeFlowStartSubmitCodePendingThenDone() async throws {
        install(Script(
            start: (200, try FixtureLoader.data("rest/login-start.json")),
            statuses: [
                (200, try FixtureLoader.data("rest/login-status.json")),
                (200, json(#"{"status":"done","message":"로그인 완료"}"#)),
            ]
        ))
        let sleeper = PollSleeper()
        let model = makeModel(agent: .claude, sleeper: sleeper)

        await model.begin()
        XCTAssertEqual(model.phase, .waiting)
        XCTAssertEqual(model.start?.flowId, "flw_01J8ZQ4K5N7P9R3S6T8V0W2XF1")
        XCTAssertEqual(model.start?.needsCode, true)
        XCTAssertEqual(model.start?.instructions, "브라우저에서 열고 코드를 붙여넣으세요")
        XCTAssertNil(model.displayedCode)
        XCTAssertEqual(requests.value.first?.url?.path(), "/api/v1/auth/claude/login")

        model.code = "  abc123#xyz  "
        await model.submitCode()
        let codeRequest = try XCTUnwrap(requests.value.first { $0.url?.path().hasSuffix("/code") == true })
        XCTAssertEqual(codeRequest.url?.path(), "/api/v1/auth/claude/login/flw_01J8ZQ4K5N7P9R3S6T8V0W2XF1/code")
        let body = try XCTUnwrap(codeRequest.httpBody)
        XCTAssertEqual(try JSONDecoder().decode(LoginCodeRequest.self, from: body).code, "abc123#xyz")
        XCTAssertEqual(model.code, "", "제출한 코드는 저장하지 않는다")

        await model.pollTask?.value
        XCTAssertEqual(model.phase, .done(message: "로그인 완료"))
        XCTAssertEqual(statusCalls.value, 2)
        XCTAssertEqual(sleeper.durations, [LoginFlowModel.pollInterval, LoginFlowModel.pollInterval])
        XCTAssertNil(model.pollTask, "done 이면 폴링을 끝낸다")
    }

    func testSubmitCodeFailureShowsMessageAndKeepsPolling() async throws {
        install(Script(
            start: (200, try FixtureLoader.data("rest/login-start.json")),
            code: (400, json(#"{"error":{"code":"invalid_request","message":"코드가 올바르지 않습니다"}}"#)),
            statuses: [(200, try FixtureLoader.data("rest/login-status.json"))]
        ))
        let sleeper = PollSleeper(parkAfter: 1)
        let model = makeModel(agent: .claude, sleeper: sleeper)
        await model.begin()
        model.code = "bad"
        await model.submitCode()
        XCTAssertEqual(model.codeMessage, "코드가 올바르지 않습니다")
        XCTAssertEqual(model.phase, .waiting)
        XCTAssertNotNil(model.pollTask)
        model.stop()
    }

    // MARK: - needsCode == false (Codex)

    func testCodexFlowShowsCodeAndCompletesWithoutSubmitting() async throws {
        install(Script(
            start: (200, json(#"{"flowId":"flw_1","url":"https://auth.openai.com/device","instructions":"링크를 열고 코드 ABCD-1234 를 입력하세요","needsCode":false}"#)),
            statuses: [(200, json(#"{"status":"done","message":"로그인 완료"}"#))]
        ))
        let sleeper = PollSleeper()
        let model = makeModel(agent: .codex, sleeper: sleeper)
        await model.begin()
        XCTAssertEqual(model.start?.needsCode, false)
        XCTAssertEqual(model.displayedCode, "ABCD-1234")
        XCTAssertEqual(model.loginURL, URL(string: "https://auth.openai.com/device"))

        await model.pollTask?.value
        XCTAssertEqual(model.phase, .done(message: "로그인 완료"))
        XCTAssertFalse(requests.value.contains { $0.url?.path().hasSuffix("/code") == true }, "Codex 는 코드 제출 엔드포인트를 쓰지 않는다")
    }

    func testDisplayedCodeIsNilWhenInstructionsHaveNoCode() async throws {
        install(Script(
            start: (200, json(#"{"flowId":"flw_1","url":"https://auth.openai.com/device","instructions":"링크를 열어 로그인하세요","needsCode":false}"#)),
            statuses: [(200, json(#"{"status":"done","message":"로그인 완료"}"#))]
        ))
        let model = makeModel(agent: .codex, sleeper: PollSleeper())
        await model.begin()
        XCTAssertNil(model.displayedCode)
        await model.pollTask?.value
    }

    // MARK: - 오류

    func testStatusErrorBecomesFailedWithRetry() async throws {
        install(Script(
            start: (200, try FixtureLoader.data("rest/login-start.json")),
            statuses: [(200, json(#"{"status":"error","message":"인증이 취소되었습니다"}"#))]
        ))
        let model = makeModel(agent: .claude, sleeper: PollSleeper())
        await model.begin()
        await model.pollTask?.value
        XCTAssertEqual(model.phase, .failed(message: "인증이 취소되었습니다"))
        XCTAssertNil(model.pollTask)

        // 다시 시도하면 start 부터 다시 간다.
        install(Script(
            start: (200, try FixtureLoader.data("rest/login-start.json")),
            statuses: [(200, json(#"{"status":"done","message":"로그인 완료"}"#))]
        ))
        await model.retry()
        await model.pollTask?.value
        XCTAssertEqual(model.phase, .done(message: "로그인 완료"))
    }

    func testStartFailureBecomesFailed() async throws {
        install(Script(start: (500, json(#"{"error":{"code":"internal","message":"PTY 를 열 수 없습니다"}}"#))))
        let model = makeModel(agent: .claude, sleeper: PollSleeper())
        await model.begin()
        XCTAssertEqual(model.phase, .failed(message: "PTY 를 열 수 없습니다"))
        XCTAssertNil(model.pollTask)
    }

    func test501MapsToUnsupportedMessage() async throws {
        install(Script(start: (501, json(#"{"error":{"code":"agent_unavailable","message":"use ssh"}}"#))))
        let model = makeModel(agent: .codex, sleeper: PollSleeper())
        await model.begin()
        XCTAssertEqual(model.phase, .unsupported(message: ErrorMessages.loginUnsupported))
        XCTAssertTrue(ErrorMessages.loginUnsupported.contains("claude setup-token"))
        XCTAssertTrue(ErrorMessages.loginUnsupported.contains("codex login"))
        XCTAssertNil(model.pollTask)
    }

    func testAgentUnavailableCodeWithoutStatus501AlsoUnsupported() async throws {
        install(Script(start: (503, json(#"{"error":{"code":"agent_unavailable","message":"codex not installed"}}"#))))
        let model = makeModel(agent: .codex, sleeper: PollSleeper())
        await model.begin()
        XCTAssertEqual(model.phase, .unsupported(message: ErrorMessages.loginUnsupported))
    }

    // MARK: - 폴링 중단

    func testStopCancelsPolling() async throws {
        install(Script(
            start: (200, try FixtureLoader.data("rest/login-start.json")),
            statuses: [(200, try FixtureLoader.data("rest/login-status.json"))]
        ))
        let sleeper = PollSleeper(parkAfter: 2)
        let model = makeModel(agent: .claude, sleeper: sleeper)
        await model.begin()

        // 폴링이 2회 돌고 3번째 sleep 에서 잠들 때까지 기다린다.
        for _ in 0..<200 where sleeper.durations.count < 3 {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(statusCalls.value, 2)
        let task = try XCTUnwrap(model.pollTask)
        model.stop()
        XCTAssertNil(model.pollTask)
        await task.value
        XCTAssertEqual(statusCalls.value, 2, "중단 후에는 더 폴링하지 않는다")
        XCTAssertEqual(model.phase, .waiting, "중단은 상태를 바꾸지 않는다")
    }
}
