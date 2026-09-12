import Foundation
import XCTest
@testable import MacAgent

/// `MentionParser`(PROTOCOL.md 6.4 멘션 문법의 클라이언트 미러). 서버 `mentions.ts` 와 같은 규칙:
/// `@이름`/`@핸들`(NFC·소문자 비교), 끝 문장부호 무시, `@all` 은 전원, 모르는 토큰은 무시.
final class MentionParserTests: XCTestCase {
    private var members: [TeamMember] = []
    private let leadId = "agt_01J8ZQ4K5N7P9R3S6T8V0W2XA1"
    private let devId = "agt_01J8ZQ4K5N7P9R3S6T8V0W2XA2"

    override func setUpWithError() throws {
        try super.setUpWithError()
        let detail = try JSONCoding.decoder.decode(TeamDetailResponse.self, from: FixtureLoader.data("rest/team-detail.json"))
        members = detail.team.members
        XCTAssertEqual(members.map(\.name), ["민수", "지연"])
        XCTAssertEqual(members.map(\.handle), ["minsu", "jiyeon"])
    }

    // MARK: - mentions(in:members:)

    func testNameMentionResolvesToMemberId() {
        let result = MentionParser.mentions(in: "@민수 로그인 버그를 고쳐줘", members: members)
        XCTAssertEqual(result.memberIds, [leadId])
        XCTAssertFalse(result.all)
    }

    func testHandleMentionIsCaseInsensitive() {
        XCTAssertEqual(MentionParser.mentions(in: "@minsu 부탁해", members: members).memberIds, [leadId])
        XCTAssertEqual(MentionParser.mentions(in: "@MinSu 부탁해", members: members).memberIds, [leadId])
    }

    func testTrailingPunctuationIsIgnored() {
        XCTAssertEqual(MentionParser.mentions(in: "@민수, 확인해줘", members: members).memberIds, [leadId])
        XCTAssertEqual(MentionParser.mentions(in: "(@jiyeon) 봐줘.", members: members).memberIds, [devId])
        XCTAssertEqual(MentionParser.mentions(in: "끝에 @지연!", members: members).memberIds, [devId])
    }

    func testAllMentionsEveryoneOnce() {
        let result = MentionParser.mentions(in: "@all 회의 시작", members: members)
        XCTAssertTrue(result.all)
        XCTAssertEqual(Set(result.memberIds), [leadId, devId])
        XCTAssertEqual(result.memberIds.count, 2)

        let mixed = MentionParser.mentions(in: "@민수 @ALL 같이", members: members)
        XCTAssertTrue(mixed.all)
        XCTAssertEqual(mixed.memberIds.count, 2, "중복 없이 전원")
    }

    func testUnknownTokenIsIgnored() {
        let result = MentionParser.mentions(in: "@철수 안녕 @민수", members: members)
        XCTAssertEqual(result.memberIds, [leadId])
        XCTAssertFalse(result.all)
        XCTAssertEqual(MentionParser.mentions(in: "@ 없음 @", members: members).memberIds, [])
        XCTAssertEqual(MentionParser.mentions(in: "멘션 없음", members: members).memberIds, [])
    }

    func testDuplicateMentionsAreCollapsedInFirstSeenOrder() {
        let result = MentionParser.mentions(in: "@지연 @민수 @jiyeon 다시", members: members)
        XCTAssertEqual(result.memberIds, [devId, leadId])
    }

    func testDecomposedHangulMatchesPrecomposedName() {
        let decomposed = "@" + "민수".decomposedStringWithCanonicalMapping + " 부탁"
        XCTAssertEqual(MentionParser.mentions(in: decomposed, members: members).memberIds, [leadId], "NFC 정규화 비교")
    }

    // MARK: - suggestions(for:members:)

    func testTrailingTokenSuggestsMatchingMembersByNameOrHandlePrefix() throws {
        let text = "안녕 @지"
        let suggestion = try XCTUnwrap(MentionParser.suggestions(for: text, members: members))
        XCTAssertEqual(suggestion.members.map(\.id), [devId])
        XCTAssertEqual(text[suggestion.token], "@지")

        let byHandle = try XCTUnwrap(MentionParser.suggestions(for: "@Ji", members: members))
        XCTAssertEqual(byHandle.members.map(\.id), [devId], "핸들 접두어는 대소문자 무시")
    }

    func testBareAtSuggestsEveryone() throws {
        let suggestion = try XCTUnwrap(MentionParser.suggestions(for: "@", members: members))
        XCTAssertEqual(suggestion.members.map(\.id), [leadId, devId])
        XCTAssertEqual("@"[suggestion.token], "@")
    }

    func testMiddleTokenOrCompletedTokenIsNotSuggested() {
        XCTAssertNil(MentionParser.suggestions(for: "@지연 고쳐줘", members: members), "끝에 공백이 있으면 토큰이 끝난 것")
        XCTAssertNil(MentionParser.suggestions(for: "@민수 안녕 지", members: members), "중간의 @ 는 무시")
        XCTAssertNil(MentionParser.suggestions(for: "이메일 a@b", members: members), "단어에 붙은 @ 는 멘션이 아니다")
        XCTAssertNil(MentionParser.suggestions(for: "멘션 없음", members: members))
        XCTAssertNil(MentionParser.suggestions(for: "", members: members))
    }

    func testNoMatchingMemberReturnsNil() {
        XCTAssertNil(MentionParser.suggestions(for: "@철", members: members))
    }

    // MARK: - apply(_:to:token:)

    func testApplyReplacesTokenWithNameAndSpace() throws {
        let text = "안녕 @지"
        let suggestion = try XCTUnwrap(MentionParser.suggestions(for: text, members: members))
        let applied = MentionParser.apply(members[1], to: text, token: suggestion.token)
        XCTAssertEqual(applied, "안녕 @지연 ")
        XCTAssertEqual(MentionParser.mentions(in: applied, members: members).memberIds, [devId], "적용 결과는 다시 멘션으로 해석된다")
    }

    func testApplyOnBareAtKeepsPrefixText() throws {
        let text = "먼저 @"
        let suggestion = try XCTUnwrap(MentionParser.suggestions(for: text, members: members))
        XCTAssertEqual(MentionParser.apply(members[0], to: text, token: suggestion.token), "먼저 @민수 ")
    }
}
