import Foundation
import Observation

/// 세션 홈의 데이터(IOS.md 6절). 프로젝트·세션 목록과 파생 목록(진행 중, 프로젝트별, 최근)을 한곳에서 계산한다.
/// 뷰는 이 클래스의 계산 결과만 그린다.
@MainActor
@Observable
final class SessionsStore {
    static let recentLimit = 10

    private(set) var projects: [Project] = []
    private(set) var sessions: [Session] = []
    private(set) var isLoading = false
    /// 첫 `refresh()` 가 끝났는지. 뷰가 빈 화면과 첫 로딩을 구분하는 데 쓴다.
    private(set) var hasLoaded = false
    private(set) var errorMessage: String?

    @ObservationIgnored private let client: APIClient

    init(client: APIClient) {
        self.client = client
    }

    /// `/projects` 와 `/sessions` 를 병렬로 읽는다. 실패한 쪽은 이전 값을 유지하고 문구만 남긴다.
    func refresh() async {
        isLoading = true
        defer {
            isLoading = false
            hasLoaded = true
        }

        let client = self.client
        async let projectsResult = Self.capture { try await client.projects().projects }
        async let sessionsResult = Self.capture { try await client.sessions() }
        let (loadedProjects, loadedSessions) = await (projectsResult, sessionsResult)

        var failure: (any Error)?
        switch loadedProjects {
        case .success(let value): projects = value
        case .failure(let error): failure = error
        }
        switch loadedSessions {
        case .success(let value): sessions = value
        case .failure(let error): failure = failure ?? error
        }
        errorMessage = failure.map { ErrorMessages.message(for: $0) }
    }

    /// `POST /sessions`. 성공하면 목록 맨 앞에 넣고 돌려준다. 오류는 그대로 던진다(문구는 시트가 만든다).
    func create(agent: AgentKind, cwd: String, title: String?, mode: SessionMode) async throws -> Session {
        let request = CreateSessionRequest(agent: agent, cwd: cwd, title: title, mode: mode)
        let session = try await client.createSession(request)
        sessions.removeAll { $0.id == session.id }
        sessions.insert(session, at: 0)
        return session
    }

    /// `POST /sessions/:id/close`. 돌아온 세션으로 목록의 항목을 교체한다.
    func close(_ session: Session) async throws {
        let closed = try await client.closeSession(id: session.id)
        replace(closed)
    }

    /// `running` 또는 `waiting_approval`. 승인 대기가 먼저, 그다음 최근 갱신순.
    var active: [Session] {
        sessions
            .filter { $0.status == .running || $0.status == .waitingApproval }
            .sorted { lhs, rhs in
                if lhs.status != rhs.status { return lhs.status == .waitingApproval }
                return lhs.updatedAt > rhs.updatedAt
            }
    }

    /// 최근 갱신순 상위 `recentLimit` 개.
    var recent: [Session] {
        Array(sessions.sorted { $0.updatedAt > $1.updatedAt }.prefix(Self.recentLimit))
    }

    /// cwd 가 정확히 같은 세션(서버의 `sessionCount` 와 같은 기준). 최근 갱신순.
    func sessions(inProject path: String) -> [Session] {
        sessions.filter { $0.cwd == path }.sorted { $0.updatedAt > $1.updatedAt }
    }

    /// 모든 세션의 승인 대기 건수 합. 홈 배지에 쓴다.
    var pendingApprovalTotal: Int {
        sessions.reduce(0) { $0 + $1.pendingApprovals }
    }

    func session(id: String) -> Session? {
        sessions.first { $0.id == id }
    }

    /// throw 를 `Result` 로 바꿔 `async let` 두 개를 모두 기다릴 수 있게 한다.
    private static func capture<T: Sendable>(
        _ body: @Sendable () async throws -> T
    ) async -> Result<T, any Error> {
        do {
            return .success(try await body())
        } catch {
            return .failure(error)
        }
    }

    private func replace(_ session: Session) {
        if let index = sessions.firstIndex(where: { $0.id == session.id }) {
            sessions[index] = session
        } else {
            sessions.insert(session, at: 0)
        }
    }
}
