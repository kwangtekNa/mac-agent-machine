import Foundation

/// 팀원 편집기의 폼 상태(순수 구조체). 서버 `MemberInput`(생성)·`TeamTemplateMember`(템플릿)·`PatchMemberRequest`(편집)로 바뀐다.
/// 검증 규칙은 PROTOCOL.md 6.1/6.2 의 `MemberInput` 규칙을 제출 전에 미리 적용한 것이다.
struct MemberDraft: Identifiable, Equatable, Sendable {
    enum ValidationError: Hashable, Sendable {
        case emptyName
        case nameTooLong
        case nameContainsAtOrWhitespace
        case duplicateName
        case customRoleLabelMissing
        case emojiNotSingleCharacter
        case agentUnavailable

        var message: String {
            switch self {
            case .emptyName: String(localized: "이름을 입력하세요.")
            case .nameTooLong: String(localized: "이름은 \(MemberDraft.nameMaxLength)자 이하로 입력하세요.")
            case .nameContainsAtOrWhitespace: String(localized: "이름에는 @ 와 공백을 쓸 수 없습니다. @멘션에 쓰이는 이름입니다.")
            case .duplicateName: String(localized: "같은 이름의 팀원이 이미 있습니다.")
            case .customRoleLabelMissing: String(localized: "커스텀 역할의 이름을 입력하세요.")
            case .emojiNotSingleCharacter: String(localized: "이모지는 한 글자만 입력하세요.")
            case .agentUnavailable: String(localized: "이 에이전트는 지금 쓸 수 없습니다. 설정에서 설치와 로그인 상태를 확인하세요.")
            }
        }
    }

    static let nameMaxLength = 40
    static let handleMaxLength = 32
    /// 팀원 편집기의 모드. `full-auto` 는 없다(자율 팀원의 무승인 명령 실행은 위험).
    static let selectableModes: [SessionMode] = [.ask, .autoEdit, .plan]
    static let allAgents: Set<AgentKind> = [.claude, .codex]

    var id = UUID()
    /// 기존 팀원 편집이면 그 팀원 id.
    var memberId: String?
    var name = ""
    var emoji = ""
    var role: RoleId = .developer
    var roleLabel = ""
    var agent: AgentKind = .claude
    var mode: SessionMode = .autoEdit
    var prompt = ""
    var isLead = false
    var handle: String?
    var model: String?
    var effort: String?
    /// "내 프리셋"에서 만들었으면 그 프리셋 id(피커 선택 표시용).
    var localPresetId: UUID?

    var isCustom: Bool { role == .custom }
    var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    var trimmedRoleLabel: String { roleLabel.trimmingCharacters(in: .whitespacesAndNewlines) }
    var trimmedPrompt: String { prompt.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// 서버 정규화(공백 제거·소문자·NFKC)를 따라 중복을 비교한다.
    static func normalizedName(_ name: String) -> String {
        name.filter { !$0.isWhitespace }.precomposedStringWithCompatibilityMapping.lowercased()
    }

    /// 빈 이름 → 40자 초과 → `@`/공백 → 중복 → 커스텀 역할 이름 → 이모지 한 글자 → 에이전트 사용 가능 순으로 검사한다.
    /// `existing` 에서 같은 id(자기 자신)는 뺀다.
    func validate(existing: [MemberDraft], availableAgents: Set<AgentKind> = MemberDraft.allAgents) -> [ValidationError] {
        var errors: [ValidationError] = []
        let name = trimmedName
        if name.isEmpty {
            errors.append(.emptyName)
        } else {
            if name.count > Self.nameMaxLength { errors.append(.nameTooLong) }
            if name.contains("@") || name.contains(where: \.isWhitespace) { errors.append(.nameContainsAtOrWhitespace) }
            let normalized = Self.normalizedName(name)
            if existing.contains(where: { $0.id != id && Self.normalizedName($0.trimmedName) == normalized }) {
                errors.append(.duplicateName)
            }
        }
        if isCustom, trimmedRoleLabel.isEmpty { errors.append(.customRoleLabelMissing) }
        if emoji.count != 1 { errors.append(.emojiNotSingleCharacter) }
        if !availableAgents.contains(agent) { errors.append(.agentUnavailable) }
        return errors
    }

    // MARK: - 만들기

    /// 서버 프리셋에서 시작하는 새 팀원. 이름은 비어 있고 모드는 `auto-edit`.
    static func from(preset: RolePreset) -> MemberDraft {
        var draft = MemberDraft()
        draft.apply(preset: preset)
        return draft
    }

    /// 내 프리셋에서 시작하는 새 팀원(역할 `custom`).
    static func from(localPreset: LocalRolePreset) -> MemberDraft {
        var draft = MemberDraft()
        draft.apply(localPreset: localPreset)
        return draft
    }

    static func from(templateMember member: TeamTemplateMember) -> MemberDraft {
        var draft = MemberDraft()
        draft.name = member.name
        draft.handle = member.handle
        draft.role = member.role
        draft.roleLabel = member.roleLabel
        draft.emoji = member.emoji
        draft.agent = member.agent
        draft.prompt = member.prompt
        draft.mode = member.mode
        draft.model = member.model
        draft.effort = member.effort
        draft.isLead = member.isLead
        return draft
    }

    /// 기존 팀원 편집. `memberId` 가 채워진다.
    static func from(member: TeamMember) -> MemberDraft {
        var draft = MemberDraft()
        draft.memberId = member.id
        draft.name = member.name
        draft.handle = member.handle
        draft.role = member.role
        draft.roleLabel = member.roleLabel
        draft.emoji = member.emoji
        draft.agent = member.agent
        draft.prompt = member.prompt
        draft.mode = member.mode
        draft.model = member.model
        draft.effort = member.effort
        draft.isLead = member.isLead
        return draft
    }

    /// 프리셋이 없을 때(목록 로드 전)의 기본 팀원. 서버 기본 개발자 프리셋과 같은 표시값.
    static func defaultDraft(presets: [RolePreset], localPresets: [LocalRolePreset] = []) -> MemberDraft {
        if let developer = presets.first(where: { $0.id == .developer }) ?? presets.first {
            return from(preset: developer)
        }
        var draft = MemberDraft()
        draft.role = .developer
        draft.roleLabel = String(localized: "개발자")
        draft.emoji = "🧑‍💻"
        return draft
    }

    /// 역할·역할명·이모지·지시문을 프리셋 값으로 바꾼다. 이름·에이전트·모드·팀장은 그대로.
    /// `custom` 은 서버가 프리셋 label 을 복사하지 않으므로(roleLabel 필수 → 400) 역할명을 비워 사용자가 넣게 한다.
    mutating func apply(preset: RolePreset) {
        role = preset.id
        roleLabel = preset.id == .custom ? "" : preset.label
        emoji = preset.emoji
        prompt = preset.prompt
        localPresetId = nil
    }

    /// 내 프리셋 적용: 역할은 `custom`, 모드까지 프리셋 값.
    mutating func apply(localPreset: LocalRolePreset) {
        role = .custom
        roleLabel = localPreset.label
        emoji = localPreset.emoji
        prompt = localPreset.prompt
        mode = localPreset.mode
        localPresetId = localPreset.id
    }

    // MARK: - 서버 요청

    /// `POST /teams` 의 `members[]`·`POST /teams/:id/members` 본문. 비어 있는 선택 필드는 키를 생략해 서버가 프리셋 값을 복사하게 한다.
    func memberInput() -> MemberInput {
        MemberInput(
            name: trimmedName,
            role: role,
            agent: agent,
            roleLabel: trimmedRoleLabel.isEmpty ? nil : trimmedRoleLabel,
            emoji: emoji.isEmpty ? nil : emoji,
            prompt: trimmedPrompt.isEmpty ? nil : prompt,
            mode: mode,
            model: model,
            effort: effort,
            handle: handle,
            isLead: isLead
        )
    }

    /// 템플릿 저장용. `handle` 이 없으면 서버 규칙대로 이름에서 만든다(로마자·숫자만, 없으면 `agent-<n>`).
    func templateMember(index: Int) -> TeamTemplateMember {
        TeamTemplateMember(
            name: trimmedName,
            handle: handle ?? Self.derivedHandle(from: trimmedName, fallbackIndex: index),
            role: role,
            roleLabel: trimmedRoleLabel,
            emoji: emoji,
            agent: agent,
            prompt: prompt,
            mode: mode,
            model: model,
            effort: effort,
            isLead: isLead
        )
    }

    /// `^[a-z0-9][a-z0-9-]{0,31}$`. 로마자·숫자·`-` 만 남기고 앞의 `-` 를 뗀다.
    static func derivedHandle(from name: String, fallbackIndex: Int) -> String {
        let scalars = name.lowercased().unicodeScalars.filter { scalar in
            (scalar.value >= 97 && scalar.value <= 122) || (scalar.value >= 48 && scalar.value <= 57) || scalar == "-"
        }
        var handle = String(String.UnicodeScalarView(scalars))
        while handle.first == "-" { handle.removeFirst() }
        handle = String(handle.prefix(Self.handleMaxLength))
        return handle.isEmpty ? "agent-\(fallbackIndex)" : handle
    }

    /// "프리셋으로 저장": 역할명·이모지·지시문·모드를 내 프리셋으로.
    func localPreset() -> LocalRolePreset {
        LocalRolePreset(id: localPresetId ?? UUID(), label: trimmedRoleLabel, emoji: emoji, prompt: prompt, mode: mode)
    }

    /// 기존 팀원 편집의 `PATCH` 본문. 바뀐 필드만 담고, 아무것도 안 바뀌었으면 nil.
    func patchRequest(from original: MemberDraft) -> PatchMemberRequest? {
        let request = PatchMemberRequest(
            name: trimmedName != original.trimmedName ? trimmedName : nil,
            emoji: emoji != original.emoji ? emoji : nil,
            prompt: prompt != original.prompt ? prompt : nil,
            mode: mode != original.mode ? mode : nil,
            model: model != original.model ? model : nil,
            effort: effort != original.effort ? effort : nil
        )
        let changed = request.name != nil || request.emoji != nil || request.prompt != nil
            || request.mode != nil || request.model != nil || request.effort != nil
        return changed ? request : nil
    }

    /// `prompt`·`model` 변경은 다음 세션(기억 초기화)부터 적용된다(PROTOCOL.md 6.2).
    func appliesNextSession(from original: MemberDraft) -> Bool {
        prompt != original.prompt || model != original.model
    }
}
