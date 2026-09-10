import Foundation
import SwiftUI
import XCTest
@testable import MacAgent

/// 컨텍스트·사용량·모델(IOS.md 9.3): `session.usage` 적용, 스냅샷 전 보관, 게이지 색 경계, 모델·사고 수준 PATCH.
@MainActor
final class TimelineModelUsageTests: XCTestCase {
    private let baseURL = URL(string: "http://127.0.0.1:7777")!
    private let sessionId = "ses_01J8ZQ4K5N7P9R3S6T8V0W2XAB"
    private let requests = Locked<[URLRequest]>([])

    override func setUp() {
        super.setUp()
        requests.value = []
    }

    override func tearDown() {
        StubURLProtocol.handler = nil
        super.tearDown()
    }

    // MARK: - helpers

    private func makeModel() -> TimelineModel {
        let factory = FakeTransportFactory([])
        let client = APIClient(baseURL: baseURL, session: StubURLProtocol.makeSession())
        return TimelineModel(
            sessionId: sessionId, client: client, transientErrorDuration: .seconds(10),
            socketFactory: { id, since in
                SessionSocket(baseURL: client.baseURL, sessionId: id, since: since, transportFactory: { factory.make() })
            }
        )
    }

    private func event(_ name: String, seq: Int? = nil, mutate: ((inout [String: Any]) -> Void)? = nil) throws -> ServerEvent {
        var data = try FixtureLoader.data("ws/\(name).json")
        if seq != nil || mutate != nil {
            var json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            if let seq { json["seq"] = seq }
            mutate?(&json)
            data = try JSONSerialization.data(withJSONObject: json)
        }
        return try JSONCoding.decoder.decode(ServerEvent.self, from: data)
    }

    /// 메서드·경로별 응답. PATCH 는 `rest/session.json` 에 본문 값을 덮어써 돌려준다(서버가 반영한 것처럼).
    private func installServer(patchStatus: Int = 200, patchError: Data? = nil) throws {
        let sessionJSON = try FixtureLoader.data("rest/session.json")
        let models = try FixtureLoader.data("rest/models-claude.json")
        let requests = self.requests
        StubURLProtocol.handler = { request in
            var copy = request
            copy.httpBody = StubURLProtocol.body(of: request)
            requests.withValue { $0.append(copy) }
            let path = request.url?.path() ?? ""
            if request.httpMethod == "PATCH" {
                if let patchError { return StubURLProtocol.response(request, status: patchStatus, body: patchError) }
                var session = (try? JSONSerialization.jsonObject(with: sessionJSON) as? [String: Any]) ?? [:]
                if let body = copy.httpBody, let patch = try? JSONSerialization.jsonObject(with: body) as? [String: Any] {
                    for (key, value) in patch { session[key] = value }
                }
                let data = (try? JSONSerialization.data(withJSONObject: session)) ?? Data()
                return StubURLProtocol.response(request, status: patchStatus, body: data)
            }
            if path.hasSuffix("/models") { return StubURLProtocol.response(request, status: 200, body: models) }
            return StubURLProtocol.response(request, status: 404, body: Data(#"{"error":{"code":"not_found","message":"nope"}}"#.utf8))
        }
    }

    private func body(of request: URLRequest?) throws -> NSDictionary {
        try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request?.httpBody)) as? NSDictionary)
    }

    // MARK: - session.usage

    func testUsageEventUpdatesContextAndTint() throws {
        let model = makeModel()
        XCTAssertNil(model.contextUsage)
        model.apply(try event("session.snapshot"))
        XCTAssertEqual(model.contextUsage?.percent, 19, "스냅샷 세션의 usage.context")

        model.apply(try event("session.usage"))                       // seq 44, percent 21
        XCTAssertEqual(model.contextUsage, ContextUsage(tokens: 42_000, window: 200_000, percent: 21))
        XCTAssertEqual(model.session?.usage?.turns, 3)
        XCTAssertEqual(model.contextTint, Color.accentColor)

        model.apply(try event("session.usage", seq: 45) { json in
            var usage = json["usage"] as! [String: Any]
            usage["context"] = ["tokens": 170_000, "window": 200_000, "percent": 85]
            json["usage"] = usage
        })
        XCTAssertEqual(model.contextTint, Color.red)
    }

    func testUsageBeforeSnapshotIsKeptAndAppliedAfterSnapshot() throws {
        let model = makeModel()
        model.apply(try event("session.usage"))                       // seq 44, turns 3 — 세션이 아직 없다
        XCTAssertNil(model.session)
        XCTAssertNil(model.contextUsage)

        model.apply(try event("session.snapshot"))                    // session.lastSeq 38, usage.turns 2
        XCTAssertEqual(model.session?.usage?.turns, 3, "스냅샷보다 뒤에 온 usage 가 스냅샷의 usage 를 덮는다")
        XCTAssertEqual(model.contextUsage?.percent, 21)
        XCTAssertEqual(model.lastSeq, 44)
        XCTAssertEqual(model.status, .waitingApproval, "스냅샷의 다른 필드는 그대로")
    }

    func testStaleUsageBeforeSnapshotIsDropped() throws {
        let model = makeModel()
        model.apply(try event("session.usage", seq: 30))              // 스냅샷(lastSeq 38)보다 오래된 관측
        model.apply(try event("session.snapshot"))
        XCTAssertEqual(model.session?.usage?.turns, 2, "스냅샷에 이미 반영된 것이므로 스냅샷 값을 쓴다")
        XCTAssertEqual(model.lastSeq, 38)
    }

    // MARK: - 색 경계

    func testUsageLevelBoundaries() {
        XCTAssertEqual(UsageLevel.level(percent: 0), .normal)
        XCTAssertEqual(UsageLevel.level(percent: 59), .normal)
        XCTAssertEqual(UsageLevel.level(percent: 60), .warning)
        XCTAssertEqual(UsageLevel.level(percent: 84), .warning)
        XCTAssertEqual(UsageLevel.level(percent: 85), .critical)
        XCTAssertEqual(UsageLevel.level(percent: 120), .critical)
        XCTAssertEqual(UsageLevel.tint(percent: 59), Color.accentColor)
        XCTAssertEqual(UsageLevel.tint(percent: 60), Color.yellow)
        XCTAssertEqual(UsageLevel.tint(percent: 84), Color.yellow)
        XCTAssertEqual(UsageLevel.tint(percent: 85), Color.red)
    }

    func testContextGaugePrefersStatusTextWhenWaitingOrError() {
        let context = ContextUsage(tokens: 42_000, window: 200_000, percent: 21)
        let idle = ContextGaugeState.make(status: .idle, context: context)
        XCTAssertEqual(idle.subtitle, "컨텍스트 21% · 42k/200k")
        XCTAssertEqual(idle.percent, 21)
        XCTAssertEqual(ContextGaugeState.make(status: .running, context: context).percent, 21)

        XCTAssertEqual(ContextGaugeState.make(status: .waitingApproval, context: context), ContextGaugeState())
        XCTAssertEqual(ContextGaugeState.make(status: .error, context: context), ContextGaugeState())
        XCTAssertEqual(ContextGaugeState.make(status: .idle, context: nil), ContextGaugeState(), "context 가 null 이면 기존 상태 텍스트")
        XCTAssertEqual(ContextGaugeState.make(status: .idle, context: ContextUsage(tokens: 1, window: 1, percent: 140)).percent, 100, "게이지는 0~100 으로 클램프")
    }

    // MARK: - 모델·사고 수준 PATCH

    func testSetModelPatchesAndReplacesSessionFromResponse() async throws {
        try installServer()
        let model = makeModel()
        model.apply(try event("session.snapshot"))
        XCTAssertNil(model.session?.model)

        await model.setModel("claude-sonnet-5")

        let request = try XCTUnwrap(requests.value.last)
        XCTAssertEqual(request.httpMethod, "PATCH")
        XCTAssertEqual(request.url?.path(), "/api/v1/sessions/\(sessionId)")
        XCTAssertEqual(try body(of: request), ["model": "claude-sonnet-5"] as NSDictionary, "model 만 보낸다")
        XCTAssertEqual(model.session?.model, "claude-sonnet-5", "응답 Session 으로 교체(낙관적 갱신 없음)")
        XCTAssertEqual(model.session?.status, .idle, "응답 세션의 상태를 그대로 따른다")
        XCTAssertEqual(model.status, .idle)
        XCTAssertNil(model.transientError)
        XCTAssertFalse(model.isPatching)
    }

    func testSetEffortPatchesEffortOnly() async throws {
        try installServer()
        let model = makeModel()
        model.apply(try event("session.snapshot"))
        await model.setEffort("low")
        XCTAssertEqual(try body(of: requests.value.last), ["effort": "low"] as NSDictionary)
        XCTAssertEqual(model.session?.effort, "low")
    }

    func testPatchFailureShowsTransientErrorAndKeepsSession() async throws {
        try installServer(patchStatus: 400, patchError: Data(#"{"error":{"code":"invalid_request","message":"unknown model"}}"#.utf8))
        let model = makeModel()
        model.apply(try event("session.snapshot"))
        let before = model.session
        await model.setModel("nope")
        XCTAssertEqual(model.transientError, "unknown model")
        XCTAssertEqual(model.session, before, "실패하면 세션은 그대로")
    }

    // MARK: - 모델 목록

    func testLoadModelsUsesCacheForFiveMinutes() async throws {
        try installServer()
        let model = makeModel()
        await model.loadModels()
        XCTAssertTrue(model.models.isEmpty, "세션(에이전트)을 모르면 요청하지 않는다")
        XCTAssertTrue(requests.value.isEmpty)

        model.apply(try event("session.snapshot"))
        let t0 = Date(timeIntervalSince1970: 1_789_041_600)
        await model.loadModels(now: t0)
        XCTAssertEqual(model.models.map(\.id), ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"])
        XCTAssertEqual(requests.value.count, 1)
        let query = URLComponents(url: try XCTUnwrap(requests.value[0].url), resolvingAgainstBaseURL: false)?.queryItems
        XCTAssertEqual(query, [URLQueryItem(name: "agent", value: "claude")])

        await model.loadModels(now: t0.addingTimeInterval(299))
        XCTAssertEqual(requests.value.count, 1, "5분 안에는 캐시")
        await model.loadModels(now: t0.addingTimeInterval(301))
        XCTAssertEqual(requests.value.count, 2, "5분이 지나면 다시 읽는다")
        await model.loadModels(force: true, now: t0.addingTimeInterval(302))
        XCTAssertEqual(requests.value.count, 3)
        XCTAssertNil(model.modelsError)
    }
}
