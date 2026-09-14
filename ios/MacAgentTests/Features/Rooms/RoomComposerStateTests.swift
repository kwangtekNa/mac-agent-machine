import Foundation
import XCTest
@testable import MacAgent

/// `RoomComposerState.make(text:room:members:lead:)`(순수): 캡션 규칙, 제안 칩, 삽입 결과.
final class RoomComposerStateTests: XCTestCase {
    private var team: Team!
    private var members: [TeamMember] = []
    private var lead: TeamMember!
    private var dev: TeamMember!
    private var group: Room!
    private var dm: Room!
    /// 곁방(참가자 = 민수·지연)과 참가자가 아닌 팀원.
    private var side: Room!
    private var outsider: TeamMember!

    override func setUpWithError() throws {
        try super.setUpWithError()
        team = try JSONCoding.decoder.decode(Team.self, from: FixtureLoader.data("rest/team.json"))
        members = team.members
        lead = try XCTUnwrap(members.first { $0.isLead })
        dev = try XCTUnwrap(members.first { !$0.isLead })
        group = try XCTUnwrap(team.rooms.first { $0.kind == .group })
        dm = try XCTUnwrap(team.rooms.first { $0.kind == .dm })
        side = try XCTUnwrap(team.rooms.first { $0.kind == .side })
        outsider = {
            var member = members[1]
            member.id = "agt_outsider"
            member.name = "철수"
            member.handle = "chulsoo"
            return member
        }()
    }

    /// 곁방 케이스용: 팀원이 3명이고 그중 둘(민수·지연)만 이 곁방 참가자다.
    private func makeSide(_ text: String, room: Room? = nil, lead: TeamMember?? = nil) -> RoomComposerState {
        RoomComposerState.make(
            text: text, room: room ?? side, members: members + [outsider], lead: lead ?? self.lead
        )
    }

    private func make(_ text: String, room: Room? = nil, lead: TeamMember?? = nil) -> RoomComposerState {
        RoomComposerState.make(text: text, room: room ?? group, members: members, lead: lead ?? self.lead)
    }

    // MARK: - 캡션

    func testGroupRoomWithoutMentionForwardsToLead() {
        XCTAssertEqual(make("로그인 버그 고쳐줘").caption, "팀장 민수에게 전달됩니다")
    }

    func testEmptyTextHasNoCaption() {
        XCTAssertNil(make("").caption)
        XCTAssertNil(make("   \n").caption)
    }

    func testMentionedTextHasNoLeadCaption() {
        XCTAssertNil(make("@지연 테스트 돌려줘").caption, "이름 멘션")
        XCTAssertNil(make("@jiyeon 테스트 돌려줘").caption, "핸들 멘션")
        XCTAssertNil(make("@all 상황 공유해줘").caption, "@all")
        XCTAssertNil(make("고쳐줘 @민수.").caption, "끝 문장부호 뒤 멘션")
    }

    func testDMHasNoCaptionAndNoSuggestions() {
        XCTAssertNil(make("고쳐줘", room: dm).caption)
        XCTAssertNil(make("@철수 고쳐줘", room: dm).caption, "DM 은 멘션을 무시하므로 모르는 토큰도 알리지 않는다")
        XCTAssertTrue(make("@지", room: dm).suggestions.isEmpty)
    }

    func testUnknownTokenCaption() {
        XCTAssertEqual(make("@철수 고쳐줘").caption, "모르는 팀원 @철수 는 무시됩니다")
        XCTAssertEqual(make("@철수 @영희 고쳐줘").caption, "모르는 팀원 @철수, @영희 는 무시됩니다")
        XCTAssertEqual(make("@지연 @철수 고쳐줘").caption, "모르는 팀원 @철수 는 무시됩니다", "아는 멘션이 있어도 모르는 토큰이 우선")
    }

    func testTrailingTokenBeingTypedIsNotUnknown() {
        // 아직 입력 중인 끝 토큰은 모르는 팀원으로 취급하지 않는다(공백을 치면 확정).
        XCTAssertEqual(make("@철").caption, "팀장 민수에게 전달됩니다")
        XCTAssertEqual(make("고쳐줘 @철").caption, "팀장 민수에게 전달됩니다")
        XCTAssertEqual(make("@철 ").caption, "모르는 팀원 @철 는 무시됩니다")
    }

    func testNoLeadNoLeadCaption() {
        XCTAssertNil(make("고쳐줘", lead: .some(nil)).caption)
    }

    func testNilRoomHasNothing() {
        let state = RoomComposerState.make(text: "@지", room: nil, members: members, lead: lead)
        XCTAssertNil(state.caption)
        XCTAssertTrue(state.suggestions.isEmpty)
    }

    // MARK: - 곁방 (2026-09-14, PROTOCOL.md 6.6)

    func testSideRoomWithoutMentionForwardsToEveryParticipant() {
        XCTAssertEqual(makeSide("어떻게 할까?").caption, "참가자 전원에게 전달됩니다")
        XCTAssertNil(makeSide("").caption)
        XCTAssertNil(makeSide("@지연 봐줘").caption, "멘션이 있으면 캡션 없음")
        XCTAssertNil(makeSide("@철수 봐줘").caption, "참가자가 아닌 팀원 멘션도 아는 팀원이다(새 곁방으로 간다)")
        XCTAssertEqual(makeSide("@영희 봐줘").caption, "모르는 팀원 @영희 는 무시됩니다", "모르는 토큰이 우선")
        XCTAssertEqual(
            makeSide("어떻게 할까?", lead: .some(nil)).caption, "참가자 전원에게 전달됩니다",
            "곁방 캡션은 팀장과 무관하다"
        )
    }

    func testSideRoomSuggestionsAreLimitedToParticipants() throws {
        XCTAssertEqual(makeSide("@").suggestions.map(\.id), [lead.id, dev.id], "그 방 참가자만")
        XCTAssertTrue(makeSide("@철").suggestions.isEmpty, "참가자가 아닌 팀원은 제안하지 않는다")
        XCTAssertEqual(makeSide("@철").caption, "참가자 전원에게 전달됩니다", "입력 중인 토큰은 캡션을 바꾸지 않는다")
        XCTAssertEqual(makeSide("@지").applying(dev), "@지연 ")

        XCTAssertEqual(
            makeSide("@", room: group).suggestions.map(\.id), [lead.id, dev.id, outsider.id],
            "그룹방은 전체 팀원 그대로"
        )
        XCTAssertEqual(makeSide("@철", room: group).suggestions.map(\.id), [outsider.id])
    }

    func testSideRoomWithoutParticipantsFallsBackToNoSuggestions() throws {
        var unknownSide = side!
        unknownSide.participants = nil
        XCTAssertTrue(makeSide("@", room: unknownSide).suggestions.isEmpty, "참가자를 모르면 제안하지 않는다")
        XCTAssertEqual(makeSide("어떻게 할까?", room: unknownSide).caption, "참가자 전원에게 전달됩니다")
    }

    // MARK: - 제안 칩

    func testSuggestionsForTrailingToken() {
        XCTAssertEqual(make("@지").suggestions.map(\.id), [dev.id])
        XCTAssertEqual(make("@").suggestions.map(\.id), members.map(\.id), "@ 만 치면 전원")
        XCTAssertEqual(make("안녕 @min").suggestions.map(\.id), [lead.id], "핸들 접두어")
        XCTAssertTrue(make("@지연 ").suggestions.isEmpty, "토큰이 끝나면 없음")
        XCTAssertTrue(make("a@지").suggestions.isEmpty, "@ 앞이 공백이 아니면 없음")
    }

    func testApplyingSuggestionReplacesToken() {
        XCTAssertEqual(make("안녕 @지").applying(dev), "안녕 @지연 ")
        XCTAssertEqual(make("@").applying(lead), "@민수 ")
        XCTAssertNil(make("안녕").applying(dev), "토큰이 없으면 nil")
    }

    // MARK: - 삽입

    func testReplyInsertion() {
        XCTAssertEqual(RoomComposerState.insertingReply(to: dev, into: ""), "@지연 ")
        XCTAssertEqual(RoomComposerState.insertingReply(to: dev, into: "안녕"), "안녕 @지연 ")
        XCTAssertEqual(RoomComposerState.insertingReply(to: dev, into: "안녕 "), "안녕 @지연 ")
        XCTAssertEqual(RoomComposerState.insertingReply(to: dev, into: "안녕\n"), "안녕\n@지연 ")
    }
}
