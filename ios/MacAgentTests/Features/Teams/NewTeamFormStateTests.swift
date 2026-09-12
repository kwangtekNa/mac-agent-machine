import Foundation
import XCTest
@testable import MacAgent

/// `NewTeamFormState`: 제출 규칙(이름 1~60, 디렉토리, 팀원 ≥1, 팀장 정확히 1, 중복 없음), 요청 변환, 템플릿 적용, 팀장 배타.
final class NewTeamFormStateTests: XCTestCase {
    private let projects = [
        Project(path: "/Users/alice/work/app", name: "app", isGitRepo: true, lastSessionAt: nil, sessionCount: 1),
    ]
    private var presets: [RolePreset] = []
    private var template: TeamTemplate!

    override func setUpWithError() throws {
        try super.setUpWithError()
        presets = try JSONCoding.decoder.decode(TeamRolesResponse.self, from: FixtureLoader.data("rest/team-roles.json")).roles
        template = try JSONCoding.decoder.decode(TeamTemplatesResponse.self, from: FixtureLoader.data("rest/team-templates.json")).templates[0]
    }

    private func member(_ name: String, role: RoleId = .developer, isLead: Bool = false) -> MemberDraft {
        var draft = MemberDraft.from(preset: presets.first { $0.id == role }!)
        draft.name = name
        draft.isLead = isLead
        return draft
    }

    private func readyForm() -> NewTeamFormState {
        var form = NewTeamFormState.initial(initialCwd: nil, projects: projects)
        form.name = "backend"
        form.upsert(member("민수", role: .teamLead, isLead: true))
        form.upsert(member("지연"))
        return form
    }

    func testInitialReusesDirectoryFormAndDefaults() {
        let form = NewTeamFormState.initial(initialCwd: nil, projects: projects)
        XCTAssertEqual(form.directory.selectedPath, "/Users/alice/work/app", "새 세션과 같은 디렉토리 초기화")
        XCTAssertEqual(form.name, "")
        XCTAssertTrue(form.members.isEmpty)
        XCTAssertNil(form.templateId)
        XCTAssertEqual(form.settings, TeamSettings.defaults)
        XCTAssertEqual(TeamSettings.defaults, TeamSettings(maxHops: 6, maxConcurrent: 2, contextMaxMessages: 40))

        let custom = NewTeamFormState.initial(initialCwd: "~/other", projects: projects)
        XCTAssertEqual(custom.directory.selectedPath, "~/other")
        XCTAssertTrue(custom.directory.showsCustomInput)
    }

    func testCanSubmitRules() {
        var form = readyForm()
        XCTAssertTrue(form.canSubmit())
        XCTAssertNil(form.blockingReason())
        XCTAssertFalse(form.canSubmit(isSubmitting: true))

        form.name = "   "
        XCTAssertFalse(form.canSubmit())
        XCTAssertEqual(form.blockingReason(), "팀 이름을 입력하세요.")
        form.name = String(repeating: "a", count: 61)
        XCTAssertFalse(form.canSubmit())
        form.name = String(repeating: "a", count: 60)
        XCTAssertTrue(form.canSubmit())

        form.directory.setCustomPath("  ")
        XCTAssertFalse(form.canSubmit(), "디렉토리 없음")
        form.directory.pick("/Users/alice/work/app")

        var noMembers = form
        noMembers.members = []
        XCTAssertFalse(noMembers.canSubmit())
        XCTAssertEqual(noMembers.blockingReason(), "팀원을 한 명 이상 추가하세요.")

        var twoLeads = form
        twoLeads.members[1].isLead = true
        XCTAssertFalse(twoLeads.canSubmit(), "팀장 2명")
        XCTAssertEqual(twoLeads.blockingReason(), "팀장을 정확히 한 명 지정하세요.")
        var noLead = form
        noLead.members[0].isLead = false
        XCTAssertFalse(noLead.canSubmit(), "팀장 0명")

        var duplicate = form
        duplicate.members[1].name = "민수"
        XCTAssertFalse(duplicate.canSubmit(), "이름 중복")
        XCTAssertEqual(duplicate.memberErrors().count, 2, "중복은 둘 다에 붙는다")
        XCTAssertEqual(duplicate.blockingReason(), "민수: 같은 이름의 팀원이 이미 있습니다.")

        XCTAssertFalse(form.canSubmit(availableAgents: [.codex]), "에이전트 사용 불가")
        XCTAssertTrue(form.canSubmit(availableAgents: [.claude]))
    }

    func testRequestCarriesEverythingButTemplateId() {
        var form = readyForm()
        form.name = " backend "
        form.settings.maxHops = 3
        form.apply(template: template)
        var jiyeon = form.members[1]
        jiyeon.mode = .autoEdit
        form.upsert(jiyeon) // 템플릿 팀원을 제자리 편집해도 목록은 그대로
        let request = form.request()
        XCTAssertEqual(request.cwd, "/Users/alice/work/app")
        XCTAssertEqual(request.name, "backend")
        XCTAssertEqual(request.members.map(\.name), ["민수", "지연"])
        XCTAssertEqual(request.members.map(\.isLead), [true, false])
        XCTAssertEqual(request.members[1].mode, .autoEdit)
        XCTAssertEqual(request.settings, template.settings)
        XCTAssertNil(request.templateId, "팀원을 전부 본문에 담으므로 templateId 는 보내지 않는다")
    }

    func testApplyTemplateFillsMembersSettingsAndName() {
        var form = NewTeamFormState.initial(initialCwd: nil, projects: projects)
        form.apply(template: template)
        XCTAssertEqual(form.templateId, template.id)
        XCTAssertEqual(form.name, "백엔드 2인", "이름이 비어 있으면 템플릿 이름")
        XCTAssertEqual(form.members.map(\.name), ["민수", "지연"])
        XCTAssertEqual(form.members.map(\.isLead), [true, false])
        XCTAssertEqual(form.members[1].agent, .codex)
        XCTAssertEqual(form.members[1].model, "gpt-5-codex")
        XCTAssertEqual(form.leadCount, 1)
        XCTAssertTrue(form.canSubmit())

        form.name = "내 팀"
        form.apply(template: template)
        XCTAssertEqual(form.name, "내 팀", "이미 쓴 이름은 유지")

        form.clearTemplate()
        XCTAssertNil(form.templateId)
        XCTAssertEqual(form.members.count, 2, "선택 해제해도 팀원은 남는다")
    }

    func testUpsertKeepsSingleLeadAndFirstMemberBecomesLead() {
        var form = NewTeamFormState()
        let first = member("지연")
        form.upsert(first)
        XCTAssertTrue(form.members[0].isLead, "첫 팀원은 자동 팀장")

        let second = member("민수", isLead: true)
        form.upsert(second)
        XCTAssertEqual(form.members.map(\.isLead), [false, true], "새 팀장은 이전 팀장을 해제")

        var edited = form.members[1]
        edited.name = "민수2"
        form.upsert(edited)
        XCTAssertEqual(form.members.map(\.name), ["지연", "민수2"], "같은 id 는 제자리 교체")
        XCTAssertEqual(form.leadCount, 1)

        form.setLead(id: first.id)
        XCTAssertEqual(form.members.map(\.isLead), [true, false])
        form.setLead(id: UUID())
        XCTAssertEqual(form.members.map(\.isLead), [true, false], "모르는 id 는 무시")

        form.remove(id: first.id)
        XCTAssertEqual(form.members.map(\.name), ["민수2"])
        XCTAssertEqual(form.leadCount, 0, "팀장을 지우면 다시 지정해야 한다")
        XCTAssertEqual(form.blockingReason(availableAgents: [.claude, .codex]), "팀 이름을 입력하세요.")
        form.upsert(member("새"))
        XCTAssertTrue(form.members.last!.isLead, "팀장이 없을 때 추가된 팀원이 팀장")
    }
}
