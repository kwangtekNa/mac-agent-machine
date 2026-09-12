import Foundation
import Observation

/// 팀 홈의 데이터(PROTOCOL.md 6절). 팀·템플릿·역할 프리셋 목록과 팀 편집 REST 를 한곳에 둔다.
/// `SessionsStore` 처럼 뷰는 이 클래스의 값만 그리고, 편집은 서버 응답(`Team`)으로 목록을 교체한다(낙관적 갱신 없음).
@MainActor
@Observable
final class TeamsStore {
    private(set) var teams: [Team] = []
    private(set) var templates: [TeamTemplate] = []
    private(set) var presets: [RolePreset] = []
    private(set) var isLoading = false
    /// 첫 `refresh()` 가 끝났는지. 빈 팀 섹션 문구와 첫 로딩을 구분한다.
    private(set) var hasLoaded = false
    private(set) var errorMessage: String?

    @ObservationIgnored private let client: APIClient

    init(client: APIClient) {
        self.client = client
    }

    /// `/teams`·`/team-templates`·`/team-roles` 를 병렬로 읽는다. 실패한 쪽은 이전 값을 유지하고 문구만 남긴다.
    func refresh() async {
        isLoading = true
        defer {
            isLoading = false
            hasLoaded = true
        }

        let client = self.client
        async let teamsResult = Self.capture { try await client.teams() }
        async let templatesResult = Self.capture { try await client.teamTemplates() }
        async let presetsResult = Self.capture { try await client.teamRoles() }
        let (loadedTeams, loadedTemplates, loadedPresets) = await (teamsResult, templatesResult, presetsResult)

        var failure: (any Error)?
        switch loadedTeams {
        case .success(let value): teams = value
        case .failure(let error): failure = error
        }
        switch loadedTemplates {
        case .success(let value): templates = value
        case .failure(let error): failure = failure ?? error
        }
        switch loadedPresets {
        case .success(let value): presets = value
        case .failure(let error): failure = failure ?? error
        }
        errorMessage = failure.map { ErrorMessages.message(for: $0) }
    }

    // MARK: - 팀

    /// `POST /teams`. 성공하면 목록 맨 앞에 넣고 돌려준다. 오류는 그대로 던진다(문구는 시트가 만든다).
    func create(_ request: CreateTeamRequest) async throws -> Team {
        let team = try await client.createTeam(request)
        teams.removeAll { $0.id == team.id }
        teams.insert(team, at: 0)
        return team
    }

    @discardableResult
    func patch(id: String, _ request: PatchTeamRequest) async throws -> Team {
        replace(try await client.patchTeam(id: id, request))
    }

    /// `DELETE /teams/:id`. 409(커밋되지 않은 worktree 변경)는 `APIError` 그대로 던진다.
    /// `keepWorktrees: true` 재시도는 호출자(뷰)가 사용자에게 묻고 결정한다.
    func delete(id: String, keepWorktrees: Bool = false) async throws {
        try await client.deleteTeam(id: id, keepWorktrees: keepWorktrees)
        teams.removeAll { $0.id == id }
    }

    func stop(id: String) async throws -> DispatchState {
        try await client.stopTeam(id: id)
    }

    // MARK: - 팀원 (응답 Team 으로 교체)

    @discardableResult
    func addMember(teamId: String, _ input: MemberInput) async throws -> Team {
        replace(try await client.addMember(teamId: teamId, input))
    }

    @discardableResult
    func patchMember(teamId: String, memberId: String, _ request: PatchMemberRequest) async throws -> Team {
        replace(try await client.patchMember(teamId: teamId, memberId: memberId, request))
    }

    @discardableResult
    func removeMember(teamId: String, memberId: String, keepWorktree: Bool = false) async throws -> Team {
        replace(try await client.removeMember(teamId: teamId, memberId: memberId, keepWorktree: keepWorktree))
    }

    @discardableResult
    func resetMember(teamId: String, memberId: String) async throws -> Team {
        replace(try await client.resetMember(teamId: teamId, memberId: memberId))
    }

    // MARK: - 템플릿

    func saveTemplate(_ request: CreateTeamTemplateRequest) async throws -> TeamTemplate {
        let template = try await client.createTeamTemplate(request)
        templates.removeAll { $0.id == template.id }
        templates.append(template)
        return template
    }

    func deleteTemplate(id: String) async throws {
        try await client.deleteTeamTemplate(id: id)
        templates.removeAll { $0.id == id }
    }

    // MARK: - 조회·조인

    func team(id: String) -> Team? {
        teams.first { $0.id == id }
    }

    /// `session.team` 으로 팀·팀원을 찾는다. 팀원 세션이 아니거나 팀을 모르면 nil.
    func team(forSession session: Session) -> (team: Team, member: TeamMember)? {
        Self.membership(of: session, in: teams)
    }

    nonisolated static func membership(of session: Session, in teams: [Team]) -> (team: Team, member: TeamMember)? {
        guard let ref = session.team,
              let team = teams.first(where: { $0.id == ref.teamId }),
              let member = team.members.first(where: { $0.id == ref.memberId })
        else { return nil }
        return (team, member)
    }

    /// 세션 행 캡션 배지 `🧑‍💻 지연 · backend`.
    nonisolated static func badge(for session: Session, teams: [Team]) -> String? {
        membership(of: session, in: teams).map { "\($0.member.emoji) \($0.member.name) · \($0.team.name)" }
    }

    /// 삭제·제거의 409 `conflict`: worktree 에 커밋되지 않은 변경이 있다.
    nonisolated static func isDirtyWorktreeConflict(_ error: any Error) -> Bool {
        guard case .server(let code, _, let status) = error as? APIError else { return false }
        return status == 409 || code == .conflict
    }

    @discardableResult
    private func replace(_ team: Team) -> Team {
        if let index = teams.firstIndex(where: { $0.id == team.id }) {
            teams[index] = team
        } else {
            teams.insert(team, at: 0)
        }
        return team
    }

    /// throw 를 `Result` 로 바꿔 `async let` 을 모두 기다릴 수 있게 한다.
    private static func capture<T: Sendable>(
        _ body: @Sendable () async throws -> T
    ) async -> Result<T, any Error> {
        do {
            return .success(try await body())
        } catch {
            return .failure(error)
        }
    }
}
