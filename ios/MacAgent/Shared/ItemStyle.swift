import SwiftUI

/// IOS.md 5.2 표의 단일 정의: 아이템 종류(도구별)마다 SF Symbol, 시스템 색, 기본 펼침 상태.
struct ItemStyle: Equatable {
    let symbol: String
    let tint: Color
    let defaultExpanded: Bool

    static func style(for item: TimelineItem) -> ItemStyle {
        switch item.payload {
        case .userMessage:
            return ItemStyle(symbol: "", tint: .accentColor, defaultExpanded: true)
        case .assistantMessage:
            return ItemStyle(symbol: "", tint: .primary, defaultExpanded: true)
        case .reasoning:
            return ItemStyle(symbol: "brain", tint: .secondary, defaultExpanded: false)
        case .toolCall(let payload):
            return toolStyle(payload.tool)
        case .fileChange:
            return ItemStyle(symbol: "plus.forwardslash.minus", tint: .teal, defaultExpanded: true)
        case .plan:
            return ItemStyle(symbol: "checklist", tint: .mint, defaultExpanded: true)
        case .approval(let payload):
            return payload.resolution == nil
                ? ItemStyle(symbol: "hand.raised.fill", tint: .yellow, defaultExpanded: true)
                : ItemStyle(symbol: "hand.raised", tint: .secondary, defaultExpanded: false)
        case .turnSummary:
            return ItemStyle(symbol: "clock", tint: .secondary, defaultExpanded: true)
        case .error:
            return ItemStyle(symbol: "exclamationmark.triangle.fill", tint: .red, defaultExpanded: true)
        case .system:
            return ItemStyle(symbol: "info.circle", tint: .secondary, defaultExpanded: true)
        }
    }

    private static func toolStyle(_ tool: ToolName) -> ItemStyle {
        switch tool {
        case .bash: return ItemStyle(symbol: "terminal", tint: .gray, defaultExpanded: false)
        case .read, .glob, .grep: return ItemStyle(symbol: "doc.text.magnifyingglass", tint: .gray, defaultExpanded: false)
        case .write, .edit: return ItemStyle(symbol: "pencil.line", tint: .orange, defaultExpanded: false)
        case .web: return ItemStyle(symbol: "globe", tint: .blue, defaultExpanded: false)
        case .mcp: return ItemStyle(symbol: "puzzlepiece.extension", tint: .purple, defaultExpanded: false)
        case .task: return ItemStyle(symbol: "person.2", tint: .indigo, defaultExpanded: false)
        case .other, .unknown: return ItemStyle(symbol: "wrench.and.screwdriver", tint: .gray, defaultExpanded: false)
        }
    }

    /// 방 항목(PROTOCOL.md 6.1 `RoomMessage.kind`)용. 메시지는 아이콘 없음, 승인·변경은 타임라인의 같은 종류와 같은 아이콘,
    /// 곁방 연결 카드는 말풍선 둘, system 은 `info.circle`.
    static func roomStyle(for entry: RoomEntry) -> ItemStyle {
        switch entry {
        case .message(let message):
            return message.author.kind == .user
                ? ItemStyle(symbol: "", tint: .accentColor, defaultExpanded: true)
                : ItemStyle(symbol: "", tint: .primary, defaultExpanded: true)
        case .approval(let message):
            return message.approval?.resolution == nil
                ? ItemStyle(symbol: "hand.raised.fill", tint: .yellow, defaultExpanded: true)
                : ItemStyle(symbol: "hand.raised", tint: .secondary, defaultExpanded: false)
        case .changes(let message):
            switch message.changes?.status {
            case .dismissed, .stale, .merged:
                return ItemStyle(symbol: "plus.forwardslash.minus", tint: .secondary, defaultExpanded: false)
            case .conflict:
                return ItemStyle(symbol: "plus.forwardslash.minus", tint: .red, defaultExpanded: true)
            default:
                return ItemStyle(symbol: "plus.forwardslash.minus", tint: .teal, defaultExpanded: true)
            }
        case .sideRoom:
            return ItemStyle(symbol: "bubble.left.and.bubble.right", tint: .secondary, defaultExpanded: true)
        case .system:
            return ItemStyle(symbol: "info.circle", tint: .secondary, defaultExpanded: true)
        }
    }

    /// 상태 오버라이드(5.2): `failed` 는 빨강, `cancelled` 는 `.secondary`.
    func tint(for status: ItemStatus) -> Color {
        switch status {
        case .failed: return .red
        case .cancelled: return .secondary
        default: return tint
        }
    }
}
