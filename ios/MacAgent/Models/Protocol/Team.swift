import Foundation

// PROTOCOL.md 6.1 팀 모델(2026-09-12 추가). 판별자가 아닌 문자열 열거형은 전부 lenient(`.unknown`).
// 팀원은 기존 `Session` 하나(`Session.team`)이며 자기 git worktree 에서 일한다.

enum RoleId: String, LenientRawEnum {
    case developer, planner
    case teamLead = "team-lead"
    case codeReviewer = "code-reviewer"
    case custom
    case unknown
}

/// `GET /team-roles` 항목. `prompt` 는 `MemberInput.prompt` 를 생략하면 복사되는 기본 지시문(`custom` 은 "").
struct RolePreset: Codable, Identifiable, Hashable, Sendable {
    var id: RoleId
    var label: String
    var emoji: String
    var prompt: String
}

/// 디스패처가 관리하는 팀원 상태. `idle → queued → running → (waiting_approval ⇄ running) → idle`, 실패 시 `error`.
enum TeamMemberState: String, LenientRawEnum {
    case idle, queued, running
    case waitingApproval = "waiting_approval"
    case error
    case unknown
}

struct TeamMember: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    /// `@멘션`·브랜치·커밋 작성자에 쓰는 ASCII 핸들. 팀 안에서 유일.
    var handle: String
    var role: RoleId
    /// 표시용 역할명. 프리셋 label 또는 `custom` 의 사용자 입력.
    var roleLabel: String
    var emoji: String
    var agent: AgentKind
    var prompt: String
    var mode: SessionMode
    /// nullable
    var model: String?
    /// nullable
    var effort: String?
    /// nullable. 첫 디스패치 전·`reset` 직후는 `null`.
    var sessionId: String?
    /// `mam/<team-slug>/<handle>`
    var branch: String
    var worktreePath: String
    /// 팀장. 팀에 정확히 1명.
    var isLead: Bool
    var state: TeamMemberState
    var createdAt: Date
    var updatedAt: Date
}

/// 기본값 `maxHops` 6, `maxConcurrent` 2, `contextMaxMessages` 40, `sideRoomMaxParticipants` 3.
struct TeamSettings: Codable, Hashable, Sendable {
    var maxHops: Int
    var maxConcurrent: Int
    var contextMaxMessages: Int
    /// 곁방 참가자 수 상한(2~8). 넘으면 곁방을 만들지 않고 그룹방에 남긴다(2026-09-14, PROTOCOL.md 6.6).
    var sideRoomMaxParticipants: Int
}

struct Team: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    /// 프로젝트 저장소 루트(절대 경로, 홈 안).
    var cwd: String
    /// 팀 생성 시점 `cwd` 의 현재 브랜치. 머지 대상.
    var baseBranch: String
    var settings: TeamSettings
    var members: [TeamMember]
    /// 그룹방 1 + 팀원별 DM 방.
    var rooms: [Room]
    var createdAt: Date
    var updatedAt: Date
}

/// 템플릿에 저장하는 팀원 정의. `TeamMember` 에서 런타임 필드를 뺀 것.
/// `model`/`effort` 는 서버 스키마가 nullable **필수** 키라, 인코딩 시 nil 이어도 키를 생략하지 않고 `null` 을 보낸다.
struct TeamTemplateMember: Codable, Hashable, Sendable {
    var name: String
    var handle: String
    var role: RoleId
    var roleLabel: String
    var emoji: String
    var agent: AgentKind
    var prompt: String
    var mode: SessionMode
    /// nullable
    var model: String?
    /// nullable
    var effort: String?
    var isLead: Bool

    private enum CodingKeys: String, CodingKey {
        case name, handle, role, roleLabel, emoji, agent, prompt, mode, model, effort, isLead
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(name, forKey: .name)
        try c.encode(handle, forKey: .handle)
        try c.encode(role, forKey: .role)
        try c.encode(roleLabel, forKey: .roleLabel)
        try c.encode(emoji, forKey: .emoji)
        try c.encode(agent, forKey: .agent)
        try c.encode(prompt, forKey: .prompt)
        try c.encode(mode, forKey: .mode)
        try c.encode(model, forKey: .model)
        try c.encode(effort, forKey: .effort)
        try c.encode(isLead, forKey: .isLead)
    }
}

/// 사용자별로 저장되는 팀 구성 템플릿.
struct TeamTemplate: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var settings: TeamSettings
    var members: [TeamTemplateMember]
    var createdAt: Date
    var updatedAt: Date
}

// MARK: - 요청 (nil 필드는 키 생략, 합성 `encodeIfPresent`)

/// `POST /teams` 의 `members[]`, `POST /teams/:id/members` 본문.
/// `roleLabel`·`emoji`·`prompt` 를 생략하면 프리셋 값(`custom` 은 `roleLabel` 필수 → 400). `handle` 생략 시 이름에서 만든다.
struct MemberInput: Codable, Hashable, Sendable {
    var name: String
    var role: RoleId
    var roleLabel: String?
    var agent: AgentKind
    var emoji: String?
    var prompt: String?
    /// 생략하면 `auto-edit`.
    var mode: SessionMode?
    var model: String?
    var effort: String?
    var handle: String?
    var isLead: Bool?

    init(
        name: String,
        role: RoleId,
        agent: AgentKind,
        roleLabel: String? = nil,
        emoji: String? = nil,
        prompt: String? = nil,
        mode: SessionMode? = nil,
        model: String? = nil,
        effort: String? = nil,
        handle: String? = nil,
        isLead: Bool? = nil
    ) {
        self.name = name
        self.role = role
        self.roleLabel = roleLabel
        self.agent = agent
        self.emoji = emoji
        self.prompt = prompt
        self.mode = mode
        self.model = model
        self.effort = effort
        self.handle = handle
        self.isLead = isLead
    }
}

/// `POST /teams` 본문. `templateId` 를 주면 템플릿의 settings·members 를 기본으로 깔고 본문이 덮어쓴다.
struct CreateTeamRequest: Codable, Hashable, Sendable {
    var cwd: String
    var name: String
    var members: [MemberInput]
    var settings: TeamSettings?
    var templateId: String?

    init(cwd: String, name: String, members: [MemberInput], settings: TeamSettings? = nil, templateId: String? = nil) {
        self.cwd = cwd
        self.name = name
        self.members = members
        self.settings = settings
        self.templateId = templateId
    }
}

/// `PATCH /teams/:id` 본문.
struct PatchTeamRequest: Codable, Hashable, Sendable {
    var name: String?
    var settings: TeamSettings?

    init(name: String? = nil, settings: TeamSettings? = nil) {
        self.name = name
        self.settings = settings
    }
}

/// `PATCH /teams/:id/members/:memberId` 본문. `prompt`·`model` 은 다음 세션(reset)부터 적용된다.
struct PatchMemberRequest: Codable, Hashable, Sendable {
    var name: String?
    var emoji: String?
    var prompt: String?
    var mode: SessionMode?
    var model: String?
    var effort: String?

    init(
        name: String? = nil,
        emoji: String? = nil,
        prompt: String? = nil,
        mode: SessionMode? = nil,
        model: String? = nil,
        effort: String? = nil
    ) {
        self.name = name
        self.emoji = emoji
        self.prompt = prompt
        self.mode = mode
        self.model = model
        self.effort = effort
    }
}

/// `POST /team-templates` 본문. 팀장 규칙(정확히 1명)은 템플릿에도 적용된다(400).
struct CreateTeamTemplateRequest: Codable, Hashable, Sendable {
    var name: String
    var settings: TeamSettings?
    var members: [TeamTemplateMember]

    init(name: String, settings: TeamSettings? = nil, members: [TeamTemplateMember]) {
        self.name = name
        self.settings = settings
        self.members = members
    }
}

/// `PATCH /team-templates/:id` 본문. 전부 선택.
struct PatchTeamTemplateRequest: Codable, Hashable, Sendable {
    var name: String?
    var settings: TeamSettings?
    var members: [TeamTemplateMember]?

    init(name: String? = nil, settings: TeamSettings? = nil, members: [TeamTemplateMember]? = nil) {
        self.name = name
        self.settings = settings
        self.members = members
    }
}

// MARK: - 응답

/// `GET /team-roles`
struct TeamRolesResponse: Codable, Hashable, Sendable {
    var roles: [RolePreset]
}

/// `GET /teams`
struct TeamsResponse: Codable, Hashable, Sendable {
    var teams: [Team]
}

/// `GET /teams/:id`
struct TeamDetailResponse: Codable, Hashable, Sendable {
    var team: Team
    var dispatch: DispatchState
    var changes: [ChangeSet]
}

/// `GET /team-templates`
struct TeamTemplatesResponse: Codable, Hashable, Sendable {
    var templates: [TeamTemplate]
}
