import Foundation

extension TeamSettings {
    /// PROTOCOL.md 6.1 기본값.
    static let defaults = TeamSettings(
        maxHops: 6, maxConcurrent: 2, contextMaxMessages: 40, sideRoomMaxParticipants: 3
    )
    static let maxHopsRange = 0...50
    static let maxConcurrentRange = 1...8
}

/// 새 팀 시트의 폼 상태(순수 구조체). 디렉토리 선택은 `NewSessionFormState` 를 그대로 쓴다(선택·찾아보기·직접 입력).
struct NewTeamFormState: Equatable, Sendable {
    static let nameMaxLength = 60

    var name = ""
    var directory = NewSessionFormState()
    var members: [MemberDraft] = []
    /// 템플릿 피커의 현재 선택. `apply(template:)` 이 채우고 `clearTemplate()` 이 비운다.
    var templateId: String?
    var settings = TeamSettings.defaults

    static func initial(initialCwd: String?, projects: [Project]) -> NewTeamFormState {
        var form = NewTeamFormState()
        form.directory = .initial(initialCwd: initialCwd, projects: projects)
        return form
    }

    var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    var leadCount: Int { members.filter(\.isLead).count }

    /// 팀원별 검증 오류(중복 이름은 서로에게 붙는다).
    func memberErrors(availableAgents: Set<AgentKind> = MemberDraft.allAgents) -> [UUID: [MemberDraft.ValidationError]] {
        var errors: [UUID: [MemberDraft.ValidationError]] = [:]
        for member in members {
            let found = member.validate(existing: members, availableAgents: availableAgents)
            if !found.isEmpty { errors[member.id] = found }
        }
        return errors
    }

    /// 제출 못 하는 이유 한 줄(버튼 아래 캡션). nil 이면 제출할 수 있다.
    /// `gitPhase` 는 선택한 디렉토리의 저장소 확인 상태(`GitInitModel`). 저장소가 아니면(초기화 진행 중 포함) 막는다.
    func blockingReason(availableAgents: Set<AgentKind> = MemberDraft.allAgents, gitPhase: GitInitFlow.Phase = .idle) -> String? {
        if trimmedName.isEmpty { return String(localized: "팀 이름을 입력하세요.") }
        if trimmedName.count > Self.nameMaxLength { return String(localized: "팀 이름은 \(Self.nameMaxLength)자 이하로 입력하세요.") }
        if directory.selectedPath.isEmpty { return String(localized: "프로젝트 디렉토리를 고르세요. git 저장소여야 합니다.") }
        if gitPhase.needsInit { return String(localized: "git 저장소가 아닙니다. 먼저 저장소를 초기화하세요.") }
        if members.isEmpty { return String(localized: "팀원을 한 명 이상 추가하세요.") }
        if leadCount != 1 { return String(localized: "팀장을 정확히 한 명 지정하세요.") }
        let errors = memberErrors(availableAgents: availableAgents)
        if let first = members.first(where: { errors[$0.id] != nil }), let error = errors[first.id]?.first {
            let who = first.trimmedName.isEmpty ? String(localized: "팀원") : first.trimmedName
            return "\(who): \(error.message)"
        }
        return nil
    }

    /// 이름 1~60, 디렉토리(git 저장소), 팀원 1명 이상, 팀장 정확히 1명, 팀원 검증(중복 이름 포함) 통과.
    func canSubmit(
        availableAgents: Set<AgentKind> = MemberDraft.allAgents, gitPhase: GitInitFlow.Phase = .idle, isSubmitting: Bool = false
    ) -> Bool {
        !isSubmitting && blockingReason(availableAgents: availableAgents, gitPhase: gitPhase) == nil
    }

    /// `POST /teams` 본문. 팀원은 전부 본문에 담으므로 `templateId` 는 보내지 않는다(서버가 템플릿 팀원을 다시 깔지 않게).
    func request() -> CreateTeamRequest {
        CreateTeamRequest(
            cwd: directory.selectedPath,
            name: trimmedName,
            members: members.map { $0.memberInput() },
            settings: settings,
            templateId: nil
        )
    }

    /// 템플릿의 팀원·설정을 폼에 깐다. 이름이 비어 있으면 템플릿 이름을 쓴다.
    mutating func apply(template: TeamTemplate) {
        templateId = template.id
        members = template.members.map { MemberDraft.from(templateMember: $0) }
        settings = template.settings
        if trimmedName.isEmpty { name = template.name }
    }

    /// 템플릿 선택 해제. 이미 깔린 팀원은 그대로 둔다(사용자가 편집했을 수 있다).
    mutating func clearTemplate() {
        templateId = nil
    }

    /// 추가 또는 같은 id 교체. 팀장으로 표시하면 다른 팀원의 팀장은 해제한다. 첫 팀원은 자동으로 팀장.
    mutating func upsert(_ draft: MemberDraft) {
        var draft = draft
        if members.isEmpty || (leadCount == 0 && !members.contains(where: { $0.id == draft.id })) {
            draft.isLead = true
        }
        if draft.isLead {
            for index in members.indices { members[index].isLead = false }
        }
        if let index = members.firstIndex(where: { $0.id == draft.id }) {
            members[index] = draft
        } else {
            members.append(draft)
        }
    }

    mutating func remove(id: UUID) {
        members.removeAll { $0.id == id }
    }

    mutating func setLead(id: UUID) {
        guard members.contains(where: { $0.id == id }) else { return }
        for index in members.indices { members[index].isLead = members[index].id == id }
    }
}
