import SwiftUI

/// 그룹방(또는 다른 곁방)에 남는 곁방 연결 카드의 문구(순수, PROTOCOL.md 6.6).
/// 이름은 메시지 본문이 아니라 **현재 팀원 목록**에서 만든다(팀원 이름이 바뀌어도 맞는다). 모르는 참가자는 일반 이름으로 부른다.
struct SideRoomCardState: Equatable {
    /// `카파시 ↔ icml 곁방을 열었습니다` / `… 곁방 대화 7건`. 모르는 `kind` 는 서버 문구 그대로.
    let title: String
    /// `closed` 의 결론 한 줄(`text` 에서 `결론: ` 뒤). 없으면 nil.
    let detail: String?
    let isClosed: Bool
    /// 탭하면 열 곁방.
    let roomId: String
    /// 아바타로 그릴 참가자(아는 팀원만, 서버가 준 순서).
    let participants: [TeamMember]
    let createdAt: Date

    private static let conclusionPrefix = "결론: "

    /// VoiceOver: 제목 + 결론.
    var accessibilityLabel: String {
        detail.map { "\(title), \($0)" } ?? title
    }

    /// `message.sideRoom` 이 없으면 곁방 카드가 아니다(nil).
    static func make(message: RoomMessage, members: [TeamMember]) -> SideRoomCardState? {
        guard let link = message.sideRoom else { return nil }
        let known = link.participants.compactMap { id in members.first { $0.id == id } }
        let names = link.participants
            .map { id in members.first { $0.id == id }?.name ?? String(localized: "팀원") }
            .joined(separator: " ↔ ")

        let title: String
        let detail: String?
        switch link.kind {
        case .opened:
            title = String(localized: "\(names) 곁방을 열었습니다")
            detail = nil
        case .closed:
            title = String(localized: "\(names) 곁방 대화 \(link.messages)건")
            detail = conclusion(in: message.text)
        case .unknown:
            title = message.text
            detail = nil
        }
        return SideRoomCardState(
            title: title,
            detail: detail,
            isClosed: link.kind == .closed,
            roomId: link.roomId,
            participants: known,
            createdAt: message.createdAt
        )
    }

    /// `… · 결론: 린트 오류 3건을 고쳤습니다` → `린트 오류 3건을 고쳤습니다`.
    private static func conclusion(in text: String) -> String? {
        guard let range = text.range(of: conclusionPrefix) else { return nil }
        let tail = text[range.upperBound...].trimmingCharacters(in: .whitespacesAndNewlines)
        return tail.isEmpty ? nil : tail
    }
}

/// 곁방 연결 카드: 전체가 버튼이며 탭하면 그 곁방으로 들어간다(사람도 곁방에서 직접 쓸 수 있다, PROTOCOL.md 6.6).
/// 아이콘·색은 `ItemStyle.roomStyle(for: .sideRoom)`(말풍선 둘 · `.secondary`).
struct SideRoomCard: View {
    let state: SideRoomCardState
    let onOpen: (String) -> Void

    var body: some View {
        Button {
            onOpen(state.roomId)
        } label: {
            ItemCard(
                chrome: CardChrome(status: .completed, createdAt: state.createdAt, summary: nil),
                style: ItemStyle(symbol: "bubble.left.and.bubble.right", tint: .secondary, defaultExpanded: true),
                title: state.title
            ) {
                HStack(spacing: 6) {
                    HStack(spacing: -6) {
                        ForEach(state.participants) { member in
                            MemberAvatar(member: member, size: 20)
                        }
                    }
                    Spacer(minLength: 4)
                    Image(systemName: "chevron.right")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                if let detail = state.detail {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(state.accessibilityLabel)
        .accessibilityHint("곁방 열기")
        .accessibilityIdentifier("room.sideRoom.\(state.roomId)")
    }
}
