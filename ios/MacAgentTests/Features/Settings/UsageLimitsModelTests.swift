import Foundation
import SwiftUI
import XCTest
@testable import MacAgent

/// 설정 > 구독 사용 한도(IOS.md 9.3): fixture 로드, 상태별 색, 60초 갱신, 실패 문구.
@MainActor
final class UsageLimitsModelTests: XCTestCase {
    private let baseURL = URL(string: "http://127.0.0.1:7777")!
    private let requests = Locked<Int>(0)
    private let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }()

    /// 갱신 sleep 기록. `parkAfter` 번째 이후 sleep 은 취소될 때까지 잔다.
    private final class Sleeper: @unchecked Sendable {
        private let lock = NSLock()
        private var stored: [Duration] = []
        private let parkAfter: Int

        init(parkAfter: Int) { self.parkAfter = parkAfter }
        var durations: [Duration] { lock.withLock { stored } }

        func sleep(_ duration: Duration) async throws {
            let park: Bool = lock.withLock {
                stored.append(duration)
                return stored.count > parkAfter
            }
            if park { try await Task.sleep(for: .seconds(3600)) }
        }
    }

    override func setUp() {
        super.setUp()
        requests.value = 0
    }

    override func tearDown() {
        StubURLProtocol.handler = nil
        super.tearDown()
    }

    /// `/usage` 응답을 순서대로 돌려주고 마지막 것을 반복한다.
    private func install(_ responses: [(Int, Data)]) {
        let requests = self.requests
        StubURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path(), "/api/v1/usage")
            let index = requests.withValue { count -> Int in
                defer { count += 1 }
                return min(count, responses.count - 1)
            }
            return StubURLProtocol.response(request, status: responses[index].0, body: responses[index].1)
        }
    }

    private func makeModel(sleeper: Sleeper? = nil, now: Date = .now) -> UsageLimitsModel {
        let client = APIClient(baseURL: baseURL, session: StubURLProtocol.makeSession())
        return UsageLimitsModel(
            client: client,
            sleep: { duration in try await sleeper?.sleep(duration) },
            now: { now }
        )
    }

    func testLoadFixtureClassifiesLimits() async throws {
        install([(200, try FixtureLoader.data("rest/usage.json"))])
        let now = Date(timeIntervalSince1970: 1_789_041_600)
        let model = makeModel(now: now)
        XCTAssertNil(model.lastLoadedAt)
        await model.load()

        XCTAssertEqual(model.agents.map(\.kind), [.claude, .codex])
        XCTAssertNil(model.errorMessage)
        XCTAssertEqual(model.lastLoadedAt, now)
        XCTAssertFalse(model.isLoading)
        let claude = model.agents[0]
        XCTAssertEqual(claude.limits.map(\.status), [.ok, .warning])
        XCTAssertEqual(UsageLimitsModel.worstLimit(of: claude)?.id, "seven_day", "가장 높은 usedPercent")
        XCTAssertEqual(UsageLimitsModel.worstLimit(of: model.agents[1])?.usedPercent, 35)
        XCTAssertEqual(UsageLimitsModel.summaryLine(model.agents), "Claude Code 81% · Codex 35%")
        XCTAssertEqual(UsageLimitsModel.header(for: claude), "Claude Code · Max")
        XCTAssertEqual(UsageLimitsModel.header(for: AgentUsage(kind: .codex, plan: nil, live: true, observedAt: nil, limits: [])), "Codex")
    }

    func testStatusTintAndExceededCaption() {
        XCTAssertEqual(UsageLimitStatus.ok.tint, Color.accentColor)
        XCTAssertEqual(UsageLimitStatus.warning.tint, Color.yellow)
        XCTAssertEqual(UsageLimitStatus.exceeded.tint, Color.red)
        XCTAssertEqual(UsageLimitStatus.unknown.tint, Color.accentColor)
        XCTAssertTrue(UsageLimitStatus.exceeded.showsExceededCaption)
        XCTAssertFalse(UsageLimitStatus.warning.showsExceededCaption)
    }

    func testEmptyLimitsSummaryAndObservationCaptions() async throws {
        install([(200, try FixtureLoader.data("rest/usage-empty.json"))])
        let model = makeModel()
        await model.load()
        XCTAssertNil(UsageLimitsModel.summaryLine(model.agents), "관측된 한도가 없으면 요약 없음")
        XCTAssertEqual(UsageLimitsModel.observationCaption(for: model.agents[0], calendar: calendar), "아직 관측되지 않았습니다")
        XCTAssertNil(UsageLimitsModel.observationCaption(for: model.agents[1], calendar: calendar), "live 카드는 관측 캡션이 없다")

        let observed = AgentUsage(kind: .claude, plan: "max", live: false, observedAt: Date(timeIntervalSince1970: 1_789_011_600), limits: [])
        XCTAssertEqual(
            UsageLimitsModel.observationCaption(for: observed, calendar: calendar),
            "마지막 관측 03:40 · 세션을 실행하면 갱신됩니다"
        )
    }

    func testAutoRefreshReloadsEverySixtySeconds() async throws {
        install([(200, try FixtureLoader.data("rest/usage.json"))])
        let sleeper = Sleeper(parkAfter: 2)
        let model = makeModel(sleeper: sleeper)
        let task = Task { await model.runAutoRefresh() }
        defer { task.cancel() }

        let deadline = ContinuousClock.now + .seconds(3)
        while ContinuousClock.now < deadline, requests.value < 3 { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(requests.value, 3, "등장 시 1회 + sleep 마다 1회")
        XCTAssertEqual(sleeper.durations.prefix(2), [.seconds(60), .seconds(60)])
        XCTAssertEqual(model.agents.count, 2)

        task.cancel()
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(requests.value, 3, "취소되면 더 읽지 않는다")
    }

    func testLoadFailureKeepsPreviousAgentsAndSetsMessage() async throws {
        install([(200, try FixtureLoader.data("rest/usage.json")), (500, Data())])
        let model = makeModel()
        await model.load()
        XCTAssertEqual(model.agents.count, 2)
        await model.load()
        XCTAssertEqual(model.errorMessage, "HTTP 500")
        XCTAssertEqual(model.agents.count, 2, "실패해도 이전 값은 남긴다")

        StubURLProtocol.handler = { _ in throw URLError(.notConnectedToInternet) }
        await model.load()
        XCTAssertEqual(model.errorMessage, ErrorMessages.cannotConnect)
    }
}
