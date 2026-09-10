import Foundation

/// PROTOCOL.md 1절 `Session`.
struct Session: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var agent: AgentKind
    var cwd: String
    var title: String
    var mode: SessionMode
    /// nullable
    var model: String?
    var status: SessionStatus
    /// nullable
    var nativeId: String?
    var createdAt: Date
    var updatedAt: Date
    var lastSeq: Int
    var pendingApprovals: Int
    /// nullable
    var preview: String?

    init(
        id: String,
        agent: AgentKind,
        cwd: String,
        title: String,
        mode: SessionMode,
        model: String?,
        status: SessionStatus,
        nativeId: String?,
        createdAt: Date,
        updatedAt: Date,
        lastSeq: Int,
        pendingApprovals: Int,
        preview: String?
    ) {
        self.id = id
        self.agent = agent
        self.cwd = cwd
        self.title = title
        self.mode = mode
        self.model = model
        self.status = status
        self.nativeId = nativeId
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.lastSeq = lastSeq
        self.pendingApprovals = pendingApprovals
        self.preview = preview
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        agent = try c.decode(AgentKind.self, forKey: .agent)
        cwd = try c.decode(String.self, forKey: .cwd)
        title = try c.decode(String.self, forKey: .title)
        mode = try c.decode(SessionMode.self, forKey: .mode)
        model = try c.decodeIfPresent(String.self, forKey: .model)
        status = try c.decode(SessionStatus.self, forKey: .status)
        nativeId = try c.decodeIfPresent(String.self, forKey: .nativeId)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        updatedAt = try c.decode(Date.self, forKey: .updatedAt)
        lastSeq = try c.decode(Int.self, forKey: .lastSeq)
        pendingApprovals = try c.decode(Int.self, forKey: .pendingApprovals)
        preview = try c.decodeIfPresent(String.self, forKey: .preview)
    }
}

/// `POST /sessions` 본문.
struct CreateSessionRequest: Codable, Hashable, Sendable {
    var agent: AgentKind
    var cwd: String
    var title: String?
    var mode: SessionMode?
    var model: String?
    var resumeNativeId: String?

    init(
        agent: AgentKind,
        cwd: String,
        title: String? = nil,
        mode: SessionMode? = nil,
        model: String? = nil,
        resumeNativeId: String? = nil
    ) {
        self.agent = agent
        self.cwd = cwd
        self.title = title
        self.mode = mode
        self.model = model
        self.resumeNativeId = resumeNativeId
    }
}

/// `PATCH /sessions/:id` 본문.
struct PatchSessionRequest: Codable, Hashable, Sendable {
    var title: String?
    var mode: SessionMode?

    init(title: String? = nil, mode: SessionMode? = nil) {
        self.title = title
        self.mode = mode
    }
}

/// 턴 토큰 사용량. `cacheReadTokens` 는 optional(키 생략 가능).
struct Usage: Codable, Hashable, Sendable {
    var inputTokens: Int
    var outputTokens: Int
    var cacheReadTokens: Int?

    init(inputTokens: Int, outputTokens: Int, cacheReadTokens: Int? = nil) {
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cacheReadTokens = cacheReadTokens
    }
}

/// 사용자 메시지 첨부. 현재 `kind` 는 `image` 뿐이다.
struct Attachment: Codable, Hashable, Sendable {
    var kind: String
    var mediaType: String
    var base64: String

    init(kind: String = "image", mediaType: String, base64: String) {
        self.kind = kind
        self.mediaType = mediaType
        self.base64 = base64
    }
}

/// 사용자 턴 입력(`turn.start` 의 본문 필드).
struct TurnInput: Codable, Hashable, Sendable {
    var text: String
    var attachments: [Attachment]?

    init(text: String, attachments: [Attachment]? = nil) {
        self.text = text
        self.attachments = attachments
    }
}
