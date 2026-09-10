import Foundation
import XCTest
@testable import MacAgent

/// 세션 정보 시트의 모델·사고 수준·구독 한도 표시 규칙(`SessionInfoState`).
final class SessionInfoStateTests: XCTestCase {
    private func models(_ fixture: String = "rest/models-claude.json") throws -> [ModelOption] {
        try JSONCoding.decoder.decode(ModelsResponse.self, from: FixtureLoader.data(fixture)).models
    }

    func testCurrentModelInListSelectsItAndExposesEfforts() throws {
        let state = SessionInfoState(currentModel: "claude-sonnet-5", currentEffort: "medium", models: try models())
        XCTAssertEqual(state.selectedModelId, "claude-sonnet-5")
        XCTAssertNil(state.unlistedCurrentModel)
        XCTAssertEqual(state.efforts, ["low", "medium", "high", "xhigh", "max"])
        XCTAssertTrue(state.showsEffortSection)
        XCTAssertEqual(state.selectedEffort, "medium")
        XCTAssertNil(state.unlistedCurrentEffort)
    }

    func testCurrentModelNotInListShowsCurrentRowAndHidesEffort() throws {
        let state = SessionInfoState(currentModel: "claude-opus-9", currentEffort: "high", models: try models())
        XCTAssertEqual(state.selectedModelId, "claude-opus-9", "선택은 현재 값을 유지한다")
        XCTAssertEqual(state.unlistedCurrentModel, "claude-opus-9")
        XCTAssertTrue(state.efforts.isEmpty, "모르는 모델의 effort 목록은 없다")
        XCTAssertFalse(state.showsEffortSection)
    }

    func testModelWithoutEffortsHidesSection() throws {
        let state = SessionInfoState(currentModel: "claude-haiku-4-5-20251001", currentEffort: nil, models: try models())
        XCTAssertFalse(state.showsEffortSection)
        XCTAssertNil(state.unlistedCurrentModel)
    }

    func testUnknownModelOrEmptyListHasNoSelection() throws {
        let noModel = SessionInfoState(currentModel: nil, currentEffort: nil, models: try models())
        XCTAssertNil(noModel.selectedModelId)
        XCTAssertNil(noModel.unlistedCurrentModel)
        XCTAssertFalse(noModel.showsEffortSection)

        let emptyList = SessionInfoState(currentModel: "gpt-5", currentEffort: "high", models: [])
        XCTAssertEqual(emptyList.unlistedCurrentModel, "gpt-5")
        XCTAssertFalse(emptyList.showsEffortSection)
    }

    func testCurrentEffortNotInListIsShownAsCurrentRow() throws {
        let state = SessionInfoState(currentModel: "gpt-5-codex", currentEffort: "ultra", models: try models("rest/models-codex.json"))
        XCTAssertTrue(state.showsEffortSection)
        XCTAssertEqual(state.unlistedCurrentEffort, "ultra")
        XCTAssertEqual(state.selectedEffort, "ultra")
    }

    func testLimitLinesTakeAtMostTwo() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let now = Date(timeIntervalSince1970: 1_789_009_200) // 2026-09-10 03:00:00 UTC
        let usage = try JSONCoding.decoder.decode(UsageResponse.self, from: FixtureLoader.data("rest/usage.json"))
        let claude = try XCTUnwrap(usage.agents.first { $0.kind == .claude })
        XCTAssertEqual(
            SessionInfoState.limitLines(claude, now: now, calendar: calendar),
            ["5시간 42% · 3시간 후 초기화", "주간 81% · 9월 14일 00:00 초기화"]
        )

        var three = claude
        three.limits.append(UsageLimit(id: "extra", label: "추가", usedPercent: 5, windowMinutes: nil, resetsAt: nil, status: .ok))
        XCTAssertEqual(SessionInfoState.limitLines(three, now: now, calendar: calendar).count, 2)

        let empty = try JSONCoding.decoder.decode(UsageResponse.self, from: FixtureLoader.data("rest/usage-empty.json"))
        XCTAssertEqual(SessionInfoState.limitLines(empty.agents[0], now: now, calendar: calendar), [])
        XCTAssertEqual(SessionInfoState.limitLines(nil, now: now, calendar: calendar), [])
    }
}
