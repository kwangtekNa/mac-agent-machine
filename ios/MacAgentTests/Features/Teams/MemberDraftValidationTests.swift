import Foundation
import XCTest
@testable import MacAgent

/// `MemberDraft`: 검증 규칙 전부, 프리셋·템플릿·기존 팀원에서 만들기, 서버 요청 변환.
final class MemberDraftValidationTests: XCTestCase {
    private var presets: [RolePreset] = []

    override func setUpWithError() throws {
        try super.setUpWithError()
        presets = try JSONCoding.decoder.decode(TeamRolesResponse.self, from: FixtureLoader.data("rest/team-roles.json")).roles
    }

    private func preset(_ id: RoleId) -> RolePreset { presets.first { $0.id == id }! }

    private func valid(name: String = "지연") -> MemberDraft {
        var draft = MemberDraft.from(preset: preset(.developer))
        draft.name = name
        return draft
    }

    func testFromPresetCopiesRoleFieldsWithAutoEditDefault() {
        let draft = MemberDraft.from(preset: preset(.codeReviewer))
        XCTAssertEqual(draft.role, .codeReviewer)
        XCTAssertEqual(draft.roleLabel, "코드 리뷰어")
        XCTAssertEqual(draft.emoji, "🔍")
        XCTAssertTrue(draft.prompt.hasPrefix("You are a code reviewer"))
        XCTAssertEqual(draft.mode, .autoEdit)
        XCTAssertEqual(draft.agent, .claude)
        XCTAssertEqual(draft.name, "")
        XCTAssertFalse(draft.isLead)
        XCTAssertNil(draft.localPresetId)
        XCTAssertFalse(MemberDraft.selectableModes.contains(.fullAuto), "full-auto 는 팀원 편집기에 없다")
    }

    func testFromLocalPresetIsCustomRole() {
        let local = LocalRolePreset(label: "DBA", emoji: "🗄️", prompt: "You manage schemas.", mode: .plan)
        var draft = MemberDraft.from(localPreset: local)
        XCTAssertEqual(draft.role, .custom)
        XCTAssertEqual(draft.roleLabel, "DBA")
        XCTAssertEqual(draft.emoji, "🗄️")
        XCTAssertEqual(draft.mode, .plan)
        XCTAssertEqual(draft.localPresetId, local.id)
        XCTAssertEqual(draft.localPreset(), local, "프리셋으로 저장은 같은 id 로 왕복한다")

        draft.apply(preset: preset(.planner))
        XCTAssertEqual(draft.role, .planner)
        XCTAssertNil(draft.localPresetId, "서버 프리셋을 고르면 내 프리셋 선택은 풀린다")
        XCTAssertEqual(draft.mode, .plan, "서버 프리셋은 모드를 바꾸지 않는다")
    }

    func testValidationRules() {
        XCTAssertEqual(valid().validate(existing: []), [])
        XCTAssertEqual(valid(name: "  ").validate(existing: []), [.emptyName])
        XCTAssertEqual(valid(name: String(repeating: "가", count: 41)).validate(existing: []), [.nameTooLong])
        XCTAssertEqual(valid(name: String(repeating: "가", count: 40)).validate(existing: []), [])
        XCTAssertEqual(valid(name: "@지연").validate(existing: []), [.nameContainsAtOrWhitespace])
        XCTAssertEqual(valid(name: "지 연").validate(existing: []), [.nameContainsAtOrWhitespace])
        XCTAssertEqual(valid(name: "지연").validate(existing: [valid(name: "지연")]), [.duplicateName])
        XCTAssertEqual(valid(name: "Jiyeon").validate(existing: [valid(name: "jiyeon")]), [.duplicateName], "대소문자·NFKC 정규화로 비교")
        let me = valid(name: "지연")
        XCTAssertEqual(me.validate(existing: [me]), [], "자기 자신은 중복이 아니다")

        var custom = MemberDraft.from(preset: preset(.custom))
        custom.name = "봇"
        XCTAssertEqual(custom.roleLabel, "", "custom 프리셋의 label(커스텀)은 복사하지 않는다")
        XCTAssertEqual(custom.validate(existing: []), [.customRoleLabelMissing], "custom 은 roleLabel 을 직접 넣어야 한다")
        custom.roleLabel = "DBA"
        XCTAssertEqual(custom.validate(existing: []), [])

        var emoji = valid()
        emoji.emoji = ""
        XCTAssertEqual(emoji.validate(existing: []), [.emojiNotSingleCharacter])
        emoji.emoji = "ab"
        XCTAssertEqual(emoji.validate(existing: []), [.emojiNotSingleCharacter])
        emoji.emoji = "🧑‍💻"
        XCTAssertEqual(emoji.validate(existing: []), [], "ZWJ 시퀀스도 한 글자")

        XCTAssertEqual(valid().validate(existing: [], availableAgents: [.codex]), [.agentUnavailable])
        var codex = valid()
        codex.agent = .codex
        XCTAssertEqual(codex.validate(existing: [], availableAgents: [.codex]), [])

        var many = valid(name: "@a b")
        many.emoji = ""
        XCTAssertEqual(many.validate(existing: [], availableAgents: []), [.nameContainsAtOrWhitespace, .emojiNotSingleCharacter, .agentUnavailable])
    }

    func testMemberInputOmitsEmptyOptionalFields() {
        var draft = valid(name: " 지연 ")
        draft.isLead = true
        var input = draft.memberInput()
        XCTAssertEqual(input.name, "지연")
        XCTAssertEqual(input.role, .developer)
        XCTAssertEqual(input.roleLabel, "개발자")
        XCTAssertEqual(input.emoji, "🧑‍💻")
        XCTAssertEqual(input.mode, .autoEdit)
        XCTAssertEqual(input.isLead, true)
        XCTAssertNil(input.handle)

        draft.roleLabel = ""
        draft.prompt = "  "
        draft.handle = "jiyeon"
        input = draft.memberInput()
        XCTAssertNil(input.roleLabel, "비어 있으면 키를 생략해 서버가 프리셋 값을 복사하게 한다")
        XCTAssertNil(input.prompt)
        XCTAssertEqual(input.handle, "jiyeon")
    }

    func testTemplateMemberDerivesHandleLikeServer() {
        let draft = valid(name: "Ji-yeon 2")
        XCTAssertEqual(draft.templateMember(index: 1).handle, "ji-yeon2")
        XCTAssertEqual(MemberDraft.derivedHandle(from: "지연", fallbackIndex: 3), "agent-3")
        XCTAssertEqual(MemberDraft.derivedHandle(from: "--Bob", fallbackIndex: 1), "bob")
        XCTAssertEqual(MemberDraft.derivedHandle(from: String(repeating: "a", count: 40), fallbackIndex: 1).count, 32)
        var withHandle = draft
        withHandle.handle = "custom"
        XCTAssertEqual(withHandle.templateMember(index: 1).handle, "custom")
    }

    func testFromTemplateMemberAndFromMember() throws {
        let template = try JSONCoding.decoder.decode(TeamTemplatesResponse.self, from: FixtureLoader.data("rest/team-templates.json")).templates[0]
        let lead = MemberDraft.from(templateMember: template.members[0])
        XCTAssertEqual(lead.name, "민수")
        XCTAssertEqual(lead.handle, "minsu")
        XCTAssertEqual(lead.role, .teamLead)
        XCTAssertEqual(lead.model, "claude-opus-5")
        XCTAssertTrue(lead.isLead)
        XCTAssertNil(lead.memberId)

        let team = try JSONCoding.decoder.decode(Team.self, from: FixtureLoader.data("rest/team.json"))
        let existing = MemberDraft.from(member: team.members[1])
        XCTAssertEqual(existing.memberId, team.members[1].id)
        XCTAssertEqual(existing.agent, .codex)
        XCTAssertEqual(existing.effort, "medium")
        XCTAssertFalse(existing.isLead)
    }

    func testPatchRequestContainsOnlyChangesAndFlagsNextSession() throws {
        let team = try JSONCoding.decoder.decode(Team.self, from: FixtureLoader.data("rest/team.json"))
        let original = MemberDraft.from(member: team.members[1])
        XCTAssertNil(original.patchRequest(from: original), "바뀐 게 없으면 nil")
        XCTAssertFalse(original.appliesNextSession(from: original))

        var edited = original
        edited.name = " 지연 "
        edited.mode = .plan
        let request = try XCTUnwrap(edited.patchRequest(from: original))
        XCTAssertNil(request.name, "다듬은 이름이 같으면 보내지 않는다")
        XCTAssertEqual(request.mode, .plan)
        XCTAssertNil(request.prompt)
        XCTAssertNil(request.emoji)
        XCTAssertFalse(edited.appliesNextSession(from: original), "mode 는 즉시 적용")

        edited.prompt = "Be terse."
        edited.emoji = "🦊"
        let next = try XCTUnwrap(edited.patchRequest(from: original))
        XCTAssertEqual(next.prompt, "Be terse.")
        XCTAssertEqual(next.emoji, "🦊")
        XCTAssertTrue(edited.appliesNextSession(from: original), "prompt 는 다음 세션부터")

        var model = original
        model.model = "gpt-5"
        XCTAssertEqual(model.patchRequest(from: original)?.model, "gpt-5")
        XCTAssertTrue(model.appliesNextSession(from: original))
    }

    func testDefaultDraftPrefersDeveloperPresetThenFallback() {
        XCTAssertEqual(MemberDraft.defaultDraft(presets: presets).role, .developer)
        XCTAssertEqual(MemberDraft.defaultDraft(presets: [preset(.planner)]).role, .planner)
        let fallback = MemberDraft.defaultDraft(presets: [])
        XCTAssertEqual(fallback.role, .developer)
        XCTAssertEqual(fallback.emoji, "🧑‍💻")
        XCTAssertEqual(fallback.roleLabel, "개발자")
    }
}
