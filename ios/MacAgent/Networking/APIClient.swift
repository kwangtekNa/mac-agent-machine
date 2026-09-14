import Foundation

/// REST 호출 실패. 서버 오류는 PROTOCOL.md 0절의 `{ error: { code, message } }` 를 그대로 옮긴다.
enum APIError: Error {
    /// 2xx 가 아니고 본문이 `ErrorResponse` 였다(디코드 불가면 `code: .internalError`, message 는 "HTTP <status>").
    case server(code: ErrorCode, message: String, status: Int)
    /// 426: 서버가 이 앱의 `X-MAM-Protocol` 버전을 지원하지 않는다.
    case unsupportedProtocol
    /// URLSession 수준 실패(연결 불가, 타임아웃 등).
    case transport(Error)
    /// 2xx 본문을 기대한 타입으로 디코드하지 못했다(요청 본문 인코딩 실패 포함).
    case decoding(Error)
    /// baseURL 과 경로로 URL 을 만들 수 없다.
    case invalidURL
}

/// PROTOCOL.md 1절 REST 클라이언트. 신원 헤더는 보내지 않는다(CRITICAL 1). 응답은 step 1 모델로만 디코드한다.
struct APIClient: Sendable {
    static let protocolVersion = "1"
    static let apiPrefix = "/api/v1"
    static let defaultTimeout: TimeInterval = 30
    static let fileReadTimeout: TimeInterval = 60

    let baseURL: URL
    private let session: URLSession

    init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    // MARK: - 엔드포인트

    /// `GET /healthz` (prefix 없음). 2xx 면 true.
    func health() async throws -> Bool {
        let request = try makeRequest(method: "GET", path: "/healthz", prefixed: false)
        let (_, response) = try await perform(request, acceptAnyStatus: true)
        return (200..<300).contains(response.statusCode)
    }

    func me() async throws -> MeResponse {
        try await get(MeResponse.self, "/me")
    }

    func projects() async throws -> ProjectsResponse {
        try await get(ProjectsResponse.self, "/projects")
    }

    func sessions(cwd: String? = nil, status: SessionStatus? = nil) async throws -> [Session] {
        var query: [URLQueryItem] = []
        if let cwd { query.append(URLQueryItem(name: "cwd", value: cwd)) }
        if let status { query.append(URLQueryItem(name: "status", value: status.rawValue)) }
        return try await get(SessionsResponse.self, "/sessions", query: query).sessions
    }

    func createSession(_ req: CreateSessionRequest) async throws -> Session {
        try await send(Session.self, method: "POST", path: "/sessions", body: req)
    }

    func session(id: String) async throws -> SessionDetailResponse {
        try await get(SessionDetailResponse.self, "/sessions/\(id)")
    }

    /// `PATCH /sessions/:id`. `title`/`mode`/`model`/`effort` 중 nil 인 필드는 본문에서 생략된다.
    func patchSession(id: String, _ req: PatchSessionRequest) async throws -> Session {
        try await send(Session.self, method: "PATCH", path: "/sessions/\(id)", body: req)
    }

    func closeSession(id: String) async throws -> Session {
        let request = try makeRequest(method: "POST", path: "/sessions/\(id)/close")
        let (data, _) = try await perform(request)
        return try decode(Session.self, from: data)
    }

    func respondApproval(sessionId: String, approvalId: String, _ req: ApprovalRespondRequest) async throws {
        _ = try await send(OkResponse.self, method: "POST", path: "/sessions/\(sessionId)/approvals/\(approvalId)", body: req)
    }

    func listDirectory(path: String) async throws -> FsListResponse {
        try await get(FsListResponse.self, "/fs/list", query: [URLQueryItem(name: "path", value: path)])
    }

    func readFile(path: String) async throws -> FsReadResponse {
        try await get(
            FsReadResponse.self, "/fs/read",
            query: [URLQueryItem(name: "path", value: path)],
            timeout: Self.fileReadTimeout
        )
    }

    /// `POST /fs/mkdir` → 201. 홈 밖은 403, 이미 있으면 409 `conflict`, 잘못된 이름은 400.
    func makeDirectory(path: String) async throws -> FsEntry {
        try await send(FsMkdirResponse.self, method: "POST", path: "/fs/mkdir", body: FsMkdirRequest(path: path)).entry
    }

    /// `GET /usage` 에이전트별 구독 사용 한도.
    func usage() async throws -> UsageResponse {
        try await get(UsageResponse.self, "/usage")
    }

    /// `GET /models?agent=` 선택 가능한 모델과 effort 목록.
    func models(agent: AgentKind) async throws -> [ModelOption] {
        try await get(ModelsResponse.self, "/models", query: [URLQueryItem(name: "agent", value: agent.rawValue)]).models
    }

    /// `GET /net/ports` 사용자 프로세스가 LISTEN 중인 TCP 포트 목록(미리보기). 서버는 이 포트를 프록시하지 않는다.
    func listeningPorts() async throws -> [NetPort] {
        try await get(NetPortsResponse.self, "/net/ports").ports
    }

    func gitStatus(cwd: String) async throws -> GitStatusResponse {
        try await get(GitStatusResponse.self, "/git/status", query: [URLQueryItem(name: "cwd", value: cwd)])
    }

    /// `POST /git/init` → 201(초기화) / 200(`dryRun`). 홈 밖 403, 디렉토리가 아니거나 없음 400, 이미 저장소(또는 상위가 저장소) 409.
    /// `dryRun` 이 false 면 본문에서 키를 생략한다.
    func initRepository(cwd: String, dryRun: Bool = false) async throws -> GitInitResponse {
        try await send(GitInitResponse.self, method: "POST", path: "/git/init", body: GitInitRequest(cwd: cwd, dryRun: dryRun ? true : nil))
    }

    func gitDiff(cwd: String, path: String?, staged: Bool) async throws -> GitDiffResponse {
        var query = [URLQueryItem(name: "cwd", value: cwd)]
        if let path { query.append(URLQueryItem(name: "path", value: path)) }
        query.append(URLQueryItem(name: "staged", value: staged ? "true" : "false"))
        return try await get(GitDiffResponse.self, "/git/diff", query: query)
    }

    func startLogin(agent: AgentKind) async throws -> LoginStartResponse {
        let request = try makeRequest(method: "POST", path: "/auth/\(agent.rawValue)/login")
        let (data, _) = try await perform(request)
        return try decode(LoginStartResponse.self, from: data)
    }

    func submitLoginCode(agent: AgentKind, flowId: String, code: String) async throws {
        _ = try await send(
            OkResponse.self, method: "POST",
            path: "/auth/\(agent.rawValue)/login/\(flowId)/code",
            body: LoginCodeRequest(code: code)
        )
    }

    func loginStatus(agent: AgentKind, flowId: String) async throws -> LoginStatusResponse {
        try await get(LoginStatusResponse.self, "/auth/\(agent.rawValue)/login/\(flowId)")
    }

    // MARK: - 팀·방 (PROTOCOL.md 6.2, 2026-09-12 추가)

    func teamRoles() async throws -> [RolePreset] {
        try await get(TeamRolesResponse.self, "/team-roles").roles
    }

    /// `GET /teams?cwd=`. `cwd` 생략 시 전체.
    func teams(cwd: String? = nil) async throws -> [Team] {
        var query: [URLQueryItem] = []
        if let cwd { query.append(URLQueryItem(name: "cwd", value: cwd)) }
        return try await get(TeamsResponse.self, "/teams", query: query).teams
    }

    /// `POST /teams` → 201 Team. 홈 밖 cwd 는 403, git 저장소가 아니면 400, 이름·handle 중복은 409.
    func createTeam(_ req: CreateTeamRequest) async throws -> Team {
        try await send(Team.self, method: "POST", path: "/teams", body: req)
    }

    func team(id: String) async throws -> TeamDetailResponse {
        try await get(TeamDetailResponse.self, "/teams/\(id)")
    }

    func patchTeam(id: String, _ req: PatchTeamRequest) async throws -> Team {
        try await send(Team.self, method: "PATCH", path: "/teams/\(id)", body: req)
    }

    /// `DELETE /teams/:id`. 커밋되지 않은 worktree 변경이 있으면 409. `keepWorktrees` 가 true 일 때만 `?keepWorktrees=true`.
    func deleteTeam(id: String, keepWorktrees: Bool = false) async throws {
        _ = try await call(
            OkResponse.self, method: "DELETE", path: "/teams/\(id)",
            query: keepWorktrees ? [URLQueryItem(name: "keepWorktrees", value: "true")] : []
        )
    }

    /// `POST /teams/:id/members` → 201 Team.
    func addMember(teamId: String, _ req: MemberInput) async throws -> Team {
        try await send(Team.self, method: "POST", path: "/teams/\(teamId)/members", body: req)
    }

    /// `PATCH /teams/:id/members/:memberId`. nil 필드는 본문에서 생략. `prompt`·`model` 은 다음 세션부터 적용.
    func patchMember(teamId: String, memberId: String, _ req: PatchMemberRequest) async throws -> Team {
        try await send(Team.self, method: "PATCH", path: "/teams/\(teamId)/members/\(memberId)", body: req)
    }

    /// `DELETE /teams/:id/members/:memberId`. `keepWorktree` 가 true 일 때만 `?keepWorktree=true`.
    func removeMember(teamId: String, memberId: String, keepWorktree: Bool = false) async throws -> Team {
        try await call(
            Team.self, method: "DELETE", path: "/teams/\(teamId)/members/\(memberId)",
            query: keepWorktree ? [URLQueryItem(name: "keepWorktree", value: "true")] : []
        )
    }

    /// 기억 초기화: 세션을 닫고 `sessionId: null`. worktree 와 브랜치는 그대로.
    func resetMember(teamId: String, memberId: String) async throws -> Team {
        try await call(Team.self, method: "POST", path: "/teams/\(teamId)/members/\(memberId)/reset")
    }

    /// 실행 중 턴 전부 중단, 대기열 비움. → 비워진 DispatchState.
    func stopTeam(id: String) async throws -> DispatchState {
        try await call(DispatchState.self, method: "POST", path: "/teams/\(id)/stop")
    }

    /// `GET /teams/:id/rooms/:roomId?limit=`. `limit` 생략 시 서버 기본(최근 200).
    func room(teamId: String, roomId: String, limit: Int? = nil) async throws -> RoomDetailResponse {
        var query: [URLQueryItem] = []
        if let limit { query.append(URLQueryItem(name: "limit", value: String(limit))) }
        return try await get(RoomDetailResponse.self, "/teams/\(teamId)/rooms/\(roomId)", query: query)
    }

    /// `POST /teams/:id/rooms/:roomId/messages` → 201. 방이 없으면 404.
    func postRoomMessage(teamId: String, roomId: String, _ req: PostRoomMessageRequest) async throws -> PostRoomMessageResponse {
        try await send(PostRoomMessageResponse.self, method: "POST", path: "/teams/\(teamId)/rooms/\(roomId)/messages", body: req)
    }

    func changes(teamId: String) async throws -> [ChangeSet] {
        try await get(ChangesResponse.self, "/teams/\(teamId)/changes").changes
    }

    /// `status` 가 `ready` 가 아니면 409. 충돌은 200 과 `status: "conflict"`, `mergeCommit: null`.
    func mergeChange(teamId: String, changeId: String) async throws -> MergeResult {
        try await call(MergeResult.self, method: "POST", path: "/teams/\(teamId)/changes/\(changeId)/merge")
    }

    /// `ready`·`conflict` → `dismissed`. 그 외 상태면 409.
    func dismissChange(teamId: String, changeId: String) async throws -> ChangeSet {
        try await call(ChangeSet.self, method: "POST", path: "/teams/\(teamId)/changes/\(changeId)/dismiss")
    }

    func teamTemplates() async throws -> [TeamTemplate] {
        try await get(TeamTemplatesResponse.self, "/team-templates").templates
    }

    /// `POST /team-templates` → 201.
    func createTeamTemplate(_ req: CreateTeamTemplateRequest) async throws -> TeamTemplate {
        try await send(TeamTemplate.self, method: "POST", path: "/team-templates", body: req)
    }

    func patchTeamTemplate(id: String, _ req: PatchTeamTemplateRequest) async throws -> TeamTemplate {
        try await send(TeamTemplate.self, method: "PATCH", path: "/team-templates/\(id)", body: req)
    }

    func deleteTeamTemplate(id: String) async throws {
        _ = try await call(OkResponse.self, method: "DELETE", path: "/team-templates/\(id)")
    }

    // MARK: - 공통

    private func get<T: Decodable>(
        _ type: T.Type, _ path: String, query: [URLQueryItem] = [], timeout: TimeInterval = APIClient.defaultTimeout
    ) async throws -> T {
        let request = try makeRequest(method: "GET", path: path, query: query, timeout: timeout)
        let (data, _) = try await perform(request)
        return try decode(T.self, from: data)
    }

    /// 본문 없는 POST/DELETE. 응답만 디코드한다.
    private func call<T: Decodable>(
        _ type: T.Type, method: String, path: String, query: [URLQueryItem] = []
    ) async throws -> T {
        let request = try makeRequest(method: method, path: path, query: query)
        let (data, _) = try await perform(request)
        return try decode(T.self, from: data)
    }

    private func send<T: Decodable, Body: Encodable>(
        _ type: T.Type, method: String, path: String, body: Body
    ) async throws -> T {
        let encoded: Data
        do {
            encoded = try JSONCoding.encoder.encode(body)
        } catch {
            throw APIError.decoding(error)
        }
        let request = try makeRequest(method: method, path: path, body: encoded)
        let (data, _) = try await perform(request)
        return try decode(T.self, from: data)
    }

    /// 요청 조립. 쿼리는 `URLComponents.queryItems` 로 넣는다(한글·공백·`~` 안전). 문자열 연결로 URL 을 만들지 않는다.
    private func makeRequest(
        method: String,
        path: String,
        query: [URLQueryItem] = [],
        body: Data? = nil,
        timeout: TimeInterval = APIClient.defaultTimeout,
        prefixed: Bool = true
    ) throws -> URLRequest {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw APIError.invalidURL
        }
        var basePath = components.path
        while basePath.hasSuffix("/") { basePath.removeLast() }
        components.path = basePath + (prefixed ? Self.apiPrefix : "") + path
        components.queryItems = query.isEmpty ? nil : query
        // URLComponents 는 `+` 를 인코딩하지 않는데 서버(fast-querystring)는 `+` 를 공백으로 읽는다. 명시적으로 %2B 로 바꾼다.
        if let encodedQuery = components.percentEncodedQuery {
            components.percentEncodedQuery = encodedQuery.replacingOccurrences(of: "+", with: "%2B")
        }
        guard let url = components.url else { throw APIError.invalidURL }

        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = method
        request.setValue(Self.protocolVersion, forHTTPHeaderField: "X-MAM-Protocol")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    /// 전송 후 상태 검사. 2xx 가 아니면 `APIError.server` / `.unsupportedProtocol`.
    private func perform(_ request: URLRequest, acceptAnyStatus: Bool = false) async throws -> (Data, HTTPURLResponse) {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.transport(error)
        }
        guard let http = response as? HTTPURLResponse else {
            throw APIError.transport(URLError(.badServerResponse))
        }
        if !acceptAnyStatus, !(200..<300).contains(http.statusCode) {
            throw Self.serverError(status: http.statusCode, body: data)
        }
        return (data, http)
    }

    static func serverError(status: Int, body: Data) -> APIError {
        if status == 426 { return .unsupportedProtocol }
        if let parsed = try? JSONCoding.decoder.decode(ErrorResponse.self, from: body) {
            return .server(code: parsed.error.code, message: parsed.error.message, status: status)
        }
        return .server(code: .internalError, message: "HTTP \(status)", status: status)
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try JSONCoding.decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decoding(error)
        }
    }
}
