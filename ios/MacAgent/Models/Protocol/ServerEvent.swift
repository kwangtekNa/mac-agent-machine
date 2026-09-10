import Foundation

// PROTOCOL.md 2절 서버 → 클라이언트 이벤트. 모든 이벤트는 `seq`, `sessionId`, `ts` 를 가진다.

struct SessionSnapshotEvent: Decodable, Hashable, Sendable {
    var seq: Int
    var sessionId: String
    var ts: Date
    var session: Session
    var items: [TimelineItem]
    var pendingApprovals: [Approval]
    var replayFrom: Int
    var truncated: Bool
}

/// `item.started` 와 `item.completed` 가 공유한다.
struct ItemEvent: Decodable, Hashable, Sendable {
    var seq: Int
    var sessionId: String
    var ts: Date
    var item: TimelineItem
}

struct ItemDeltaEvent: Decodable, Hashable, Sendable {
    var seq: Int
    var sessionId: String
    var ts: Date
    var itemId: String
    var field: ItemDeltaField
    var delta: String
}

struct ApprovalRequestedEvent: Decodable, Hashable, Sendable {
    var seq: Int
    var sessionId: String
    var ts: Date
    var approval: Approval
}

struct ApprovalResolvedEvent: Decodable, Hashable, Sendable {
    var seq: Int
    var sessionId: String
    var ts: Date
    var approvalId: String
    var optionId: String
    var by: ApprovalResolvedBy
}

struct SessionStatusEvent: Decodable, Hashable, Sendable {
    var seq: Int
    var sessionId: String
    var ts: Date
    var status: SessionStatus
    var mode: SessionMode
    var reason: String?
}

struct TurnCompletedEvent: Decodable, Hashable, Sendable {
    var seq: Int
    var sessionId: String
    var ts: Date
    var turnId: String
    var durationMs: Int
    var usage: Usage
    var costUsd: Double?
    var stopReason: String
}

struct ErrorEvent: Decodable, Hashable, Sendable {
    var seq: Int
    var sessionId: String
    var ts: Date
    var message: String
    var recoverable: Bool
}

struct PongEvent: Decodable, Hashable, Sendable {
    var seq: Int
    var sessionId: String
    var ts: Date
}

/// 서버 이벤트. `type` 판별자는 **엄격**하다: 모르는 값이면 `DecodingError`.
enum ServerEvent: Decodable, Hashable, Sendable {
    case sessionSnapshot(SessionSnapshotEvent)
    case itemStarted(ItemEvent)
    case itemDelta(ItemDeltaEvent)
    case itemCompleted(ItemEvent)
    case approvalRequested(ApprovalRequestedEvent)
    case approvalResolved(ApprovalResolvedEvent)
    case sessionStatus(SessionStatusEvent)
    case turnCompleted(TurnCompletedEvent)
    case error(ErrorEvent)
    case pong(PongEvent)

    /// wire 의 `type` 값.
    enum EventType: String, Codable, Hashable, Sendable, CaseIterable {
        case sessionSnapshot = "session.snapshot"
        case itemStarted = "item.started"
        case itemDelta = "item.delta"
        case itemCompleted = "item.completed"
        case approvalRequested = "approval.requested"
        case approvalResolved = "approval.resolved"
        case sessionStatus = "session.status"
        case turnCompleted = "turn.completed"
        case error
        case pong
    }

    private enum CodingKeys: String, CodingKey {
        case type
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(EventType.self, forKey: .type)
        self = switch type {
        case .sessionSnapshot: .sessionSnapshot(try SessionSnapshotEvent(from: decoder))
        case .itemStarted: .itemStarted(try ItemEvent(from: decoder))
        case .itemDelta: .itemDelta(try ItemDeltaEvent(from: decoder))
        case .itemCompleted: .itemCompleted(try ItemEvent(from: decoder))
        case .approvalRequested: .approvalRequested(try ApprovalRequestedEvent(from: decoder))
        case .approvalResolved: .approvalResolved(try ApprovalResolvedEvent(from: decoder))
        case .sessionStatus: .sessionStatus(try SessionStatusEvent(from: decoder))
        case .turnCompleted: .turnCompleted(try TurnCompletedEvent(from: decoder))
        case .error: .error(try ErrorEvent(from: decoder))
        case .pong: .pong(try PongEvent(from: decoder))
        }
    }

    var type: EventType {
        switch self {
        case .sessionSnapshot: .sessionSnapshot
        case .itemStarted: .itemStarted
        case .itemDelta: .itemDelta
        case .itemCompleted: .itemCompleted
        case .approvalRequested: .approvalRequested
        case .approvalResolved: .approvalResolved
        case .sessionStatus: .sessionStatus
        case .turnCompleted: .turnCompleted
        case .error: .error
        case .pong: .pong
        }
    }

    var seq: Int {
        switch self {
        case .sessionSnapshot(let e): e.seq
        case .itemStarted(let e), .itemCompleted(let e): e.seq
        case .itemDelta(let e): e.seq
        case .approvalRequested(let e): e.seq
        case .approvalResolved(let e): e.seq
        case .sessionStatus(let e): e.seq
        case .turnCompleted(let e): e.seq
        case .error(let e): e.seq
        case .pong(let e): e.seq
        }
    }

    var sessionId: String {
        switch self {
        case .sessionSnapshot(let e): e.sessionId
        case .itemStarted(let e), .itemCompleted(let e): e.sessionId
        case .itemDelta(let e): e.sessionId
        case .approvalRequested(let e): e.sessionId
        case .approvalResolved(let e): e.sessionId
        case .sessionStatus(let e): e.sessionId
        case .turnCompleted(let e): e.sessionId
        case .error(let e): e.sessionId
        case .pong(let e): e.sessionId
        }
    }

    var ts: Date {
        switch self {
        case .sessionSnapshot(let e): e.ts
        case .itemStarted(let e), .itemCompleted(let e): e.ts
        case .itemDelta(let e): e.ts
        case .approvalRequested(let e): e.ts
        case .approvalResolved(let e): e.ts
        case .sessionStatus(let e): e.ts
        case .turnCompleted(let e): e.ts
        case .error(let e): e.ts
        case .pong(let e): e.ts
        }
    }
}
