import Foundation

/// 방 화면의 한 줄. `RoomMessage.kind` 와 payload 조합으로 분류한다. 모르는 kind 나 payload 가 빠진 카드는 `.system` 으로 강등.
enum RoomEntry: Identifiable, Hashable, Sendable {
    /// `kind: text`. 작성자는 user/agent/system.
    case message(RoomMessage)
    /// `kind: approval`, `message.approval` 필수.
    case approval(RoomMessage)
    /// `kind: changes`, `message.changes` 필수.
    case changes(RoomMessage)
    /// `kind: system` 또는 강등된 카드.
    case system(RoomMessage)

    var message: RoomMessage {
        switch self {
        case .message(let m), .approval(let m), .changes(let m), .system(let m): m
        }
    }

    var id: String { message.id }
    var seq: Int { message.seq }
    var createdAt: Date { message.createdAt }

    static func make(_ message: RoomMessage) -> RoomEntry {
        switch message.kind {
        case .text:
            return .message(message)
        case .approval where message.approval != nil:
            return .approval(message)
        case .changes where message.changes != nil:
            return .changes(message)
        case .approval, .changes, .system, .unknown:
            return .system(message)
        }
    }
}
