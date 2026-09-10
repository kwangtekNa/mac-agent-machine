import Foundation

// PROTOCOL.md 1절 REST 응답·요청 타입.

struct AgentInfo: Codable, Hashable, Sendable {
    var kind: AgentKind
    var available: Bool
    /// nullable
    var version: String?
    var loggedIn: Bool
    /// nullable
    var account: String?
}

struct ServerInfo: Codable, Hashable, Sendable {
    var version: String
    var protocolVersion: Int
}

/// `GET /me`
struct MeResponse: Codable, Hashable, Sendable {
    var user: String
    var email: String
    var home: String
    var workspaceRoot: String
    var agents: [AgentInfo]
    var server: ServerInfo
}

struct Project: Codable, Identifiable, Hashable, Sendable {
    var path: String
    var name: String
    var isGitRepo: Bool
    /// nullable
    var lastSessionAt: Date?
    var sessionCount: Int

    var id: String { path }
}

/// `GET /projects`
struct ProjectsResponse: Codable, Hashable, Sendable {
    var projects: [Project]
}

/// `GET /sessions`
struct SessionsResponse: Codable, Hashable, Sendable {
    var sessions: [Session]
}

/// `GET /sessions/:id`
struct SessionDetailResponse: Codable, Hashable, Sendable {
    var session: Session
    var items: [TimelineItem]
    var truncated: Bool
}

struct FsEntry: Codable, Identifiable, Hashable, Sendable {
    var name: String
    var path: String
    var type: FsEntryType
    /// nullable(디렉토리·심링크 등)
    var size: Int?
    var mtime: Date
    var isHidden: Bool
    /// nullable. `git status --porcelain` 이 준 값만 채운다.
    var gitStatus: GitStatusCode?

    var id: String { path }
}

/// `GET /fs/list`
struct FsListResponse: Codable, Hashable, Sendable {
    var path: String
    /// nullable(홈 루트)
    var parent: String?
    var isGitRepo: Bool
    var entries: [FsEntry]
}

/// `GET /fs/read`
struct FsReadResponse: Codable, Hashable, Sendable {
    var path: String
    var size: Int
    var mtime: Date
    var isBinary: Bool
    /// `utf8` | `base64`
    var encoding: String
    var content: String
    var truncated: Bool
    /// 확장자 기반 소문자 식별자(`typescript`, `swift`, `plaintext` 등)
    var language: String
}

struct GitStatusEntry: Codable, Hashable, Sendable {
    var path: String
    /// porcelain 한 글자
    var index: String
    /// porcelain 한 글자
    var worktree: String
}

/// `GET /git/status`
struct GitStatusResponse: Codable, Hashable, Sendable {
    var isRepo: Bool
    /// nullable
    var branch: String?
    var ahead: Int
    var behind: Int
    var entries: [GitStatusEntry]
}

/// `GET /git/diff`
struct GitDiffResponse: Codable, Hashable, Sendable {
    var patch: String
}

/// `POST /auth/:agent/login`
struct LoginStartResponse: Codable, Hashable, Sendable {
    var flowId: String
    var url: String
    var instructions: String
    var needsCode: Bool
}

/// `GET /auth/:agent/login/:flowId`
struct LoginStatusResponse: Codable, Hashable, Sendable {
    var status: LoginFlowStatus
    var message: String
}

/// `POST /auth/:agent/login/:flowId/code` 본문
struct LoginCodeRequest: Codable, Hashable, Sendable {
    var code: String

    init(code: String) {
        self.code = code
    }
}

/// `POST /sessions/:id/approvals/:approvalId` 본문. `approvalId` 는 URL 에 있으므로 생략 가능.
struct ApprovalRespondRequest: Codable, Hashable, Sendable {
    var approvalId: String?
    var optionId: String
    var inputs: [String: String]?
    var message: String?

    init(approvalId: String? = nil, optionId: String, inputs: [String: String]? = nil, message: String? = nil) {
        self.approvalId = approvalId
        self.optionId = optionId
        self.inputs = inputs
        self.message = message
    }
}

struct OkResponse: Codable, Hashable, Sendable {
    var ok: Bool
}

/// PROTOCOL.md 0절 오류 응답 `{ error: { code, message } }`.
struct ErrorResponse: Codable, Hashable, Sendable {
    struct Body: Codable, Hashable, Sendable {
        var code: ErrorCode
        var message: String
    }

    var error: Body
}
