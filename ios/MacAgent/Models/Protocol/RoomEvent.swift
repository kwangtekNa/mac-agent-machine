import Foundation

// PROTOCOL.md 6.3 방 WebSocket 서버 → 클라이언트 이벤트(2026-09-12 추가).
// 세션 WS(`ServerEvent`)와 **별도 스트림**이며 `seq` 는 방 내 단조 증가(세션 seq 와 별개).
// 모든 이벤트는 `seq`, `roomId`, `teamId`, `ts` 를 가진다.

struct RoomSnapshotEvent: Decodable, Hashable, Sendable {
    var seq: Int
    var roomId: String
    var teamId: String
    var ts: Date
    var room: Room
    /// `since` 뒤의 메시지(갱신 반영된 현재 상태).
    var messages: [RoomMessage]
    /// 이 방에 미러링된 승인 중 `resolution` 이 `null` 인 것.
    var pendingApprovals: [RoomApproval]
    var dispatch: DispatchState
    var members: [RoomMemberStatus]
    var replayFrom: Int
    var truncated: Bool
}

/// `room.message` 와 `room.message.updated` 가 공유한다. 갱신은 `message.id` 로 교체하고 `message.seq` 는 원래 값이다.
struct RoomMessageEvent: Decodable, Hashable, Sendable {
    var seq: Int
    var roomId: String
    var teamId: String
    var ts: Date
    var message: RoomMessage
}

struct RoomStatusEvent: Decodable, Hashable, Sendable {
    var seq: Int
    var roomId: String
    var teamId: String
    var ts: Date
    var dispatch: DispatchState
    var members: [RoomMemberStatus]
}

struct RoomErrorEvent: Decodable, Hashable, Sendable {
    var seq: Int
    var roomId: String
    var teamId: String
    var ts: Date
    var message: String
    var recoverable: Bool
}

struct RoomPongEvent: Decodable, Hashable, Sendable {
    var seq: Int
    var roomId: String
    var teamId: String
    var ts: Date
}

/// 방 이벤트. `type` 판별자는 **엄격**하다: 모르는 값(세션 이벤트 type 포함)이면 `DecodingError`.
enum RoomEvent: Decodable, Hashable, Sendable {
    case roomSnapshot(RoomSnapshotEvent)
    case roomMessage(RoomMessageEvent)
    case roomMessageUpdated(RoomMessageEvent)
    case roomStatus(RoomStatusEvent)
    case roomError(RoomErrorEvent)
    case pong(RoomPongEvent)

    /// wire 의 `type` 값.
    enum EventType: String, Codable, Hashable, Sendable, CaseIterable {
        case roomSnapshot = "room.snapshot"
        case roomMessage = "room.message"
        case roomMessageUpdated = "room.message.updated"
        case roomStatus = "room.status"
        case roomError = "room.error"
        case pong
    }

    private enum CodingKeys: String, CodingKey {
        case type
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(EventType.self, forKey: .type)
        self = switch type {
        case .roomSnapshot: .roomSnapshot(try RoomSnapshotEvent(from: decoder))
        case .roomMessage: .roomMessage(try RoomMessageEvent(from: decoder))
        case .roomMessageUpdated: .roomMessageUpdated(try RoomMessageEvent(from: decoder))
        case .roomStatus: .roomStatus(try RoomStatusEvent(from: decoder))
        case .roomError: .roomError(try RoomErrorEvent(from: decoder))
        case .pong: .pong(try RoomPongEvent(from: decoder))
        }
    }

    var type: EventType {
        switch self {
        case .roomSnapshot: .roomSnapshot
        case .roomMessage: .roomMessage
        case .roomMessageUpdated: .roomMessageUpdated
        case .roomStatus: .roomStatus
        case .roomError: .roomError
        case .pong: .pong
        }
    }

    var seq: Int {
        switch self {
        case .roomSnapshot(let e): e.seq
        case .roomMessage(let e), .roomMessageUpdated(let e): e.seq
        case .roomStatus(let e): e.seq
        case .roomError(let e): e.seq
        case .pong(let e): e.seq
        }
    }

    var roomId: String {
        switch self {
        case .roomSnapshot(let e): e.roomId
        case .roomMessage(let e), .roomMessageUpdated(let e): e.roomId
        case .roomStatus(let e): e.roomId
        case .roomError(let e): e.roomId
        case .pong(let e): e.roomId
        }
    }

    var teamId: String {
        switch self {
        case .roomSnapshot(let e): e.teamId
        case .roomMessage(let e), .roomMessageUpdated(let e): e.teamId
        case .roomStatus(let e): e.teamId
        case .roomError(let e): e.teamId
        case .pong(let e): e.teamId
        }
    }

    var ts: Date {
        switch self {
        case .roomSnapshot(let e): e.ts
        case .roomMessage(let e), .roomMessageUpdated(let e): e.ts
        case .roomStatus(let e): e.ts
        case .roomError(let e): e.ts
        case .pong(let e): e.ts
        }
    }
}
