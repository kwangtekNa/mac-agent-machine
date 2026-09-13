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

/// `POST /git/init` 본문(2026-09-13 추가). `~/` 허용. `dryRun` 이 nil 이면 키를 생략한다(실제 초기화).
struct GitInitRequest: Codable, Hashable, Sendable {
    var cwd: String
    var dryRun: Bool?

    init(cwd: String, dryRun: Bool? = nil) {
        self.cwd = cwd
        self.dryRun = dryRun
    }
}

/// `POST /git/init` → 201(초기화) / 200(`dryRun`). `branch` 는 항상 `main`.
/// `files`/`bytes` 는 첫 커밋에 담기는(담길) 기존 파일 수와 합계 크기(서버가 만든 `.gitignore` 는 제외, dryRun 과 실제가 같다).
struct GitInitResponse: Codable, Hashable, Sendable {
    /// 실제로 초기화했으면 true, `dryRun` 이면 false.
    var initialized: Bool
    var branch: String
    /// nullable. 첫 커밋 sha(40자). `dryRun` 이면 null.
    var commit: String?
    var files: Int
    var bytes: Int
    /// 기본 `.gitignore` 를 만들었(만들)는지. 이미 있으면 건드리지 않고 false.
    var createdGitignore: Bool
}

/// `POST /fs/mkdir` 본문(2026-09-10 추가). `~/` 로 시작하면 서버가 홈으로 치환한다.
struct FsMkdirRequest: Codable, Hashable, Sendable {
    var path: String

    init(path: String) {
        self.path = path
    }
}

/// `POST /fs/mkdir` → 201. 만든 디렉토리의 FsEntry.
struct FsMkdirResponse: Codable, Hashable, Sendable {
    var entry: FsEntry
}

/// 구독 사용 한도 창 하나(2026-09-10 추가). `usedPercent` 는 100 을 넘을 수 있다.
struct UsageLimit: Codable, Identifiable, Hashable, Sendable {
    /// `five_hour`, `seven_day`(Claude), `primary`, `secondary`(Codex) 등
    var id: String
    /// 표시용 라벨(`5시간`, `주간`)
    var label: String
    var usedPercent: Int
    /// nullable
    var windowMinutes: Int?
    /// nullable
    var resetsAt: Date?
    var status: UsageLimitStatus
}

/// 에이전트별 구독 사용 한도(2026-09-10 추가). 관측값이 없으면 `limits: []`, `observedAt: null`.
struct AgentUsage: Codable, Hashable, Sendable {
    var kind: AgentKind
    /// nullable
    var plan: String?
    /// Codex 는 호출 시점 조회(true), Claude 는 세션 실행 중 관측한 마지막 값(false).
    var live: Bool
    /// nullable
    var observedAt: Date?
    var limits: [UsageLimit]
}

/// `GET /usage`
struct UsageResponse: Codable, Hashable, Sendable {
    var agents: [AgentUsage]
}

/// `GET /models` 항목(2026-09-10 추가). `efforts` 가 비어 있으면 effort 조절을 지원하지 않는다.
struct ModelOption: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var displayName: String
    /// nullable
    var description: String?
    var isDefault: Bool
    var efforts: [String]
    /// nullable
    var defaultEffort: String?
}

/// `GET /models?agent=`
struct ModelsResponse: Codable, Hashable, Sendable {
    var models: [ModelOption]
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
