import Foundation

/// 마지막 턴 기준 컨텍스트 크기와 모델 컨텍스트 창(2026-09-10 추가). `percent` 는 정수 0~100.
struct ContextUsage: Codable, Hashable, Sendable {
    var tokens: Int
    var window: Int
    var percent: Int

    init(tokens: Int, window: Int, percent: Int) {
        self.tokens = tokens
        self.window = window
        self.percent = percent
    }
}

/// 세션 **누적** 토큰·비용과 현재 컨텍스트(2026-09-10 추가). `Session.usage` 와 `session.usage` 이벤트가 공유한다.
struct SessionUsage: Codable, Hashable, Sendable {
    var inputTokens: Int
    var outputTokens: Int
    var cacheReadTokens: Int
    var cacheWriteTokens: Int
    /// nullable. 어댑터가 추정값을 주지 않으면(Codex 구독 계정) `null`.
    var costUsd: Double?
    var turns: Int
    /// nullable. 모르면 `null`.
    var context: ContextUsage?
    var updatedAt: Date

    init(
        inputTokens: Int,
        outputTokens: Int,
        cacheReadTokens: Int,
        cacheWriteTokens: Int,
        costUsd: Double?,
        turns: Int,
        context: ContextUsage?,
        updatedAt: Date
    ) {
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cacheReadTokens = cacheReadTokens
        self.cacheWriteTokens = cacheWriteTokens
        self.costUsd = costUsd
        self.turns = turns
        self.context = context
        self.updatedAt = updatedAt
    }

    private enum CodingKeys: String, CodingKey {
        case inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, turns, context, updatedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        inputTokens = try c.decode(Int.self, forKey: .inputTokens)
        outputTokens = try c.decode(Int.self, forKey: .outputTokens)
        cacheReadTokens = try c.decode(Int.self, forKey: .cacheReadTokens)
        cacheWriteTokens = try c.decode(Int.self, forKey: .cacheWriteTokens)
        costUsd = try c.decodeIfPresent(Double.self, forKey: .costUsd)
        turns = try c.decode(Int.self, forKey: .turns)
        context = try c.decodeIfPresent(ContextUsage.self, forKey: .context)
        updatedAt = try c.decode(Date.self, forKey: .updatedAt)
    }
}

/// PROTOCOL.md 1절 `Session`.
struct Session: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var agent: AgentKind
    var cwd: String
    var title: String
    var mode: SessionMode
    /// nullable
    var model: String?
    /// nullable(2026-09-10 추가). 어댑터가 보고한 사고 수준. 서버가 채우기 전 응답은 키 자체가 없을 수 있다.
    var effort: String?
    var status: SessionStatus
    /// nullable
    var nativeId: String?
    var createdAt: Date
    var updatedAt: Date
    var lastSeq: Int
    var pendingApprovals: Int
    /// nullable
    var preview: String?
    /// nullable(2026-09-10 추가). 첫 턴 전에는 `null`. 키 생략 허용 사유는 `effort` 와 같다.
    var usage: SessionUsage?

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
        preview: String?,
        effort: String? = nil,
        usage: SessionUsage? = nil
    ) {
        self.id = id
        self.agent = agent
        self.cwd = cwd
        self.title = title
        self.mode = mode
        self.model = model
        self.effort = effort
        self.status = status
        self.nativeId = nativeId
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.lastSeq = lastSeq
        self.pendingApprovals = pendingApprovals
        self.preview = preview
        self.usage = usage
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        agent = try c.decode(AgentKind.self, forKey: .agent)
        cwd = try c.decode(String.self, forKey: .cwd)
        title = try c.decode(String.self, forKey: .title)
        mode = try c.decode(SessionMode.self, forKey: .mode)
        model = try c.decodeIfPresent(String.self, forKey: .model)
        effort = try c.decodeIfPresent(String.self, forKey: .effort)
        status = try c.decode(SessionStatus.self, forKey: .status)
        nativeId = try c.decodeIfPresent(String.self, forKey: .nativeId)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        updatedAt = try c.decode(Date.self, forKey: .updatedAt)
        lastSeq = try c.decode(Int.self, forKey: .lastSeq)
        pendingApprovals = try c.decode(Int.self, forKey: .pendingApprovals)
        preview = try c.decodeIfPresent(String.self, forKey: .preview)
        usage = try c.decodeIfPresent(SessionUsage.self, forKey: .usage)
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

/// `PATCH /sessions/:id` 본문. nil 필드는 키를 생략한다(합성 `encodeIfPresent`).
/// `model`/`effort` 는 `GET /models` 가 준 값이어야 하며(400), 적용 시점은 어댑터가 정한다.
struct PatchSessionRequest: Codable, Hashable, Sendable {
    var title: String?
    var mode: SessionMode?
    var model: String?
    var effort: String?

    init(title: String? = nil, mode: SessionMode? = nil, model: String? = nil, effort: String? = nil) {
        self.title = title
        self.mode = mode
        self.model = model
        self.effort = effort
    }
}

/// 턴 토큰 사용량. `cacheReadTokens`, `cacheWriteTokens` 는 optional(키 생략 가능).
struct Usage: Codable, Hashable, Sendable {
    var inputTokens: Int
    var outputTokens: Int
    var cacheReadTokens: Int?
    var cacheWriteTokens: Int?

    init(inputTokens: Int, outputTokens: Int, cacheReadTokens: Int? = nil, cacheWriteTokens: Int? = nil) {
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cacheReadTokens = cacheReadTokens
        self.cacheWriteTokens = cacheWriteTokens
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
