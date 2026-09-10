import Foundation

/// 타임라인 아이템 판별자. **엄격**하다: 모르는 값이면 `DecodingError`(PROTOCOL.md 0절).
enum TimelineItemKind: String, Codable, Hashable, Sendable, CaseIterable {
    case userMessage = "user_message"
    case assistantMessage = "assistant_message"
    case reasoning
    case toolCall = "tool_call"
    case fileChange = "file_change"
    case plan
    case approval
    case turnSummary = "turn_summary"
    case error
    case system
}

// MARK: - kind 별 payload

struct UserMessagePayload: Codable, Hashable, Sendable {
    var text: String
    var attachments: [Attachment]

    init(text: String, attachments: [Attachment] = []) {
        self.text = text
        self.attachments = attachments
    }
}

struct AssistantMessagePayload: Codable, Hashable, Sendable {
    /// 마크다운
    var text: String
    var phase: AssistantMessagePhase

    init(text: String, phase: AssistantMessagePhase) {
        self.text = text
        self.phase = phase
    }
}

struct ReasoningPayload: Codable, Hashable, Sendable {
    var text: String

    init(text: String) {
        self.text = text
    }
}

struct ToolCallPayload: Codable, Hashable, Sendable {
    var tool: ToolName
    /// 어댑터의 원래 도구 이름(예: `Bash`)
    var name: String
    var title: String
    /// 임의 JSON
    var input: [String: JSONValue]
    var output: String
    /// nullable
    var exitCode: Int?
    var truncated: Bool

    init(
        tool: ToolName,
        name: String,
        title: String,
        input: [String: JSONValue],
        output: String,
        exitCode: Int?,
        truncated: Bool
    ) {
        self.tool = tool
        self.name = name
        self.title = title
        self.input = input
        self.output = output
        self.exitCode = exitCode
        self.truncated = truncated
    }
}

struct FileChangeEntry: Codable, Hashable, Sendable {
    var path: String
    var kind: FileChangeKind
    var additions: Int
    var deletions: Int

    init(path: String, kind: FileChangeKind, additions: Int, deletions: Int) {
        self.path = path
        self.kind = kind
        self.additions = additions
        self.deletions = deletions
    }
}

struct FileChangePayload: Codable, Hashable, Sendable {
    var files: [FileChangeEntry]
    /// unified diff
    var patch: String

    init(files: [FileChangeEntry], patch: String) {
        self.files = files
        self.patch = patch
    }
}

struct PlanStep: Codable, Hashable, Sendable {
    var text: String
    var status: PlanStepStatus

    init(text: String, status: PlanStepStatus) {
        self.text = text
        self.status = status
    }
}

struct PlanPayload: Codable, Hashable, Sendable {
    var steps: [PlanStep]

    init(steps: [PlanStep]) {
        self.steps = steps
    }
}

struct TurnSummaryPayload: Codable, Hashable, Sendable {
    var durationMs: Int
    var usage: Usage
    var costUsd: Double?
    var stopReason: String

    init(durationMs: Int, usage: Usage, costUsd: Double? = nil, stopReason: String) {
        self.durationMs = durationMs
        self.usage = usage
        self.costUsd = costUsd
        self.stopReason = stopReason
    }
}

struct ErrorPayload: Codable, Hashable, Sendable {
    var message: String
    var recoverable: Bool

    init(message: String, recoverable: Bool) {
        self.message = message
        self.recoverable = recoverable
    }
}

struct SystemPayload: Codable, Hashable, Sendable {
    var text: String

    init(text: String) {
        self.text = text
    }
}

/// `kind` 별 연관값. `TimelineItem.init(from:)` 이 `kind` 를 먼저 읽고 알맞은 타입으로 디코드한다.
enum TimelinePayload: Hashable, Sendable {
    case userMessage(UserMessagePayload)
    case assistantMessage(AssistantMessagePayload)
    case reasoning(ReasoningPayload)
    case toolCall(ToolCallPayload)
    case fileChange(FileChangePayload)
    case plan(PlanPayload)
    case approval(ApprovalPayload)
    case turnSummary(TurnSummaryPayload)
    case error(ErrorPayload)
    case system(SystemPayload)

    var kind: TimelineItemKind {
        switch self {
        case .userMessage: .userMessage
        case .assistantMessage: .assistantMessage
        case .reasoning: .reasoning
        case .toolCall: .toolCall
        case .fileChange: .fileChange
        case .plan: .plan
        case .approval: .approval
        case .turnSummary: .turnSummary
        case .error: .error
        case .system: .system
        }
    }
}

/// PROTOCOL.md 3절 `TimelineItem`.
struct TimelineItem: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var seq: Int
    /// nullable. 턴 밖 아이템(예: `system`)은 `null`.
    var turnId: String?
    var kind: TimelineItemKind
    var status: ItemStatus
    var createdAt: Date
    /// nullable
    var completedAt: Date?
    var payload: TimelinePayload

    init(
        id: String,
        seq: Int,
        turnId: String?,
        status: ItemStatus,
        createdAt: Date,
        completedAt: Date?,
        payload: TimelinePayload
    ) {
        self.id = id
        self.seq = seq
        self.turnId = turnId
        self.kind = payload.kind
        self.status = status
        self.createdAt = createdAt
        self.completedAt = completedAt
        self.payload = payload
    }

    private enum CodingKeys: String, CodingKey {
        case id, seq, turnId, kind, status, createdAt, completedAt, payload
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        seq = try c.decode(Int.self, forKey: .seq)
        turnId = try c.decodeIfPresent(String.self, forKey: .turnId)
        kind = try c.decode(TimelineItemKind.self, forKey: .kind)
        status = try c.decode(ItemStatus.self, forKey: .status)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        completedAt = try c.decodeIfPresent(Date.self, forKey: .completedAt)
        payload = switch kind {
        case .userMessage: .userMessage(try c.decode(UserMessagePayload.self, forKey: .payload))
        case .assistantMessage: .assistantMessage(try c.decode(AssistantMessagePayload.self, forKey: .payload))
        case .reasoning: .reasoning(try c.decode(ReasoningPayload.self, forKey: .payload))
        case .toolCall: .toolCall(try c.decode(ToolCallPayload.self, forKey: .payload))
        case .fileChange: .fileChange(try c.decode(FileChangePayload.self, forKey: .payload))
        case .plan: .plan(try c.decode(PlanPayload.self, forKey: .payload))
        case .approval: .approval(try c.decode(ApprovalPayload.self, forKey: .payload))
        case .turnSummary: .turnSummary(try c.decode(TurnSummaryPayload.self, forKey: .payload))
        case .error: .error(try c.decode(ErrorPayload.self, forKey: .payload))
        case .system: .system(try c.decode(SystemPayload.self, forKey: .payload))
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(seq, forKey: .seq)
        try c.encode(turnId, forKey: .turnId)
        try c.encode(kind, forKey: .kind)
        try c.encode(status, forKey: .status)
        try c.encode(createdAt, forKey: .createdAt)
        try c.encode(completedAt, forKey: .completedAt)
        switch payload {
        case .userMessage(let p): try c.encode(p, forKey: .payload)
        case .assistantMessage(let p): try c.encode(p, forKey: .payload)
        case .reasoning(let p): try c.encode(p, forKey: .payload)
        case .toolCall(let p): try c.encode(p, forKey: .payload)
        case .fileChange(let p): try c.encode(p, forKey: .payload)
        case .plan(let p): try c.encode(p, forKey: .payload)
        case .approval(let p): try c.encode(p, forKey: .payload)
        case .turnSummary(let p): try c.encode(p, forKey: .payload)
        case .error(let p): try c.encode(p, forKey: .payload)
        case .system(let p): try c.encode(p, forKey: .payload)
        }
    }
}
