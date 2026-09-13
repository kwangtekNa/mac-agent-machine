import Foundation
import XCTest
@testable import MacAgent

/// 방의 팀원 시트 상태(`MemberControlState`): 모델·사고 수준은 `SessionInfoState`(IOS.md 9.3) 규칙 그대로, PATCH 는 바뀐 필드만.
final class MemberControlStateTests: XCTestCase {
    private var minsu: TeamMember!

    override func setUpWithError() throws {
        try super.setUpWithError()
        // fixture: 민수 claude · auto-edit · claude-opus-5 · high
        minsu = try JSONCoding.decoder.decode(Team.self, from: FixtureLoader.data("rest/team.json")).members[0]
    }

    private func models(_ fixture: String = "rest/models-claude.json") throws -> [ModelOption] {
        try JSONCoding.decoder.decode(ModelsResponse.self, from: FixtureLoader.data(fixture)).models
    }

    func testMakeFollowsSessionInfoRules() throws {
        let state = MemberControlState.make(member: minsu, models: try models())
        XCTAssertEqual(state.mode, .autoEdit)
        XCTAssertEqual(state.info.selectedModelId, "claude-opus-5")
        XCTAssertNil(state.info.unlistedCurrentModel)
        XCTAssertEqual(state.info.efforts, ["low", "medium", "high", "xhigh", "max"])
        XCTAssertTrue(state.info.showsEffortSection)
        XCTAssertEqual(state.info.selectedEffort, "high")
        XCTAssertNil(state.info.unlistedCurrentEffort)
        XCTAssertNil(state.modelCaption, "모델을 바꾸기 전에는 캡션이 없다")
        XCTAssertEqual(state, MemberControlState.make(member: minsu, models: try models()))

        var unknown = minsu!
        unknown.model = "claude-opus-9"
        let unlisted = MemberControlState.make(member: unknown, models: try models())
        XCTAssertEqual(unlisted.info.selectedModelId, "claude-opus-9", "선택은 현재 값을 유지한다")
        XCTAssertEqual(unlisted.info.unlistedCurrentModel, "claude-opus-9")
        XCTAssertFalse(unlisted.info.showsEffortSection, "목록에 없는 모델의 effort 목록은 없다")

        var haiku = minsu!
        haiku.model = "claude-haiku-4-5-20251001"
        haiku.effort = nil
        let noEfforts = MemberControlState.make(member: haiku, models: try models())
        XCTAssertNil(noEfforts.info.unlistedCurrentModel)
        XCTAssertFalse(noEfforts.info.showsEffortSection, "efforts 가 비면 사고 수준 섹션을 숨긴다")

        var none = minsu!
        none.model = nil
        none.effort = nil
        let defaults = MemberControlState.make(member: none, models: try models())
        XCTAssertNil(defaults.info.selectedModelId, "기본은 nil")
        XCTAssertNil(defaults.info.selectedEffort)
        XCTAssertFalse(defaults.info.showsEffortSection)

        var ultra = minsu!
        ultra.effort = "ultra"
        XCTAssertEqual(MemberControlState.make(member: ultra, models: try models()).info.unlistedCurrentEffort, "ultra")

        XCTAssertEqual(
            MemberControlState.make(member: minsu, models: [], modelChanged: true).modelCaption,
            MemberControlState.nextSessionCaption
        )
        XCTAssertEqual(MemberControlState.nextSessionCaption, "다음 세션부터 적용됩니다(기억 초기화로 바로 적용)")
    }

    func testPatchContainsOnlyTheChangedField() throws {
        let state = MemberControlState.make(member: minsu, models: try models())

        XCTAssertNil(state.patch(mode: nil))
        XCTAssertNil(state.patch(mode: .autoEdit), "같은 값이면 보낼 것이 없다")
        XCTAssertEqual(state.patch(mode: .fullAuto), PatchMemberRequest(mode: .fullAuto))
        XCTAssertEqual(state.patch(mode: .plan), PatchMemberRequest(mode: .plan))

        XCTAssertNil(state.patch(model: nil))
        XCTAssertNil(state.patch(model: "claude-opus-5"))
        XCTAssertEqual(state.patch(model: "claude-sonnet-5"), PatchMemberRequest(model: "claude-sonnet-5"))

        XCTAssertNil(state.patch(effort: nil))
        XCTAssertNil(state.patch(effort: "high"))
        XCTAssertEqual(state.patch(effort: "max"), PatchMemberRequest(effort: "max"))

        let json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONCoding.encoder.encode(XCTUnwrap(state.patch(effort: "max")))) as? [String: Any]
        )
        XCTAssertEqual(Array(json.keys), ["effort"], "바뀐 필드만 본문에 실린다")
    }
}
