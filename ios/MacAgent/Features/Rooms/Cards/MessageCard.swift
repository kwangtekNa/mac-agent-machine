import MarkdownUI
import SwiftUI

/// 방의 `kind: text` 메시지 카드. 사용자는 `UserMessageCard` 와 같은 accent 10% 배경의 평문,
/// 에이전트는 상단 `MemberChip` + Markdown(`Theme.macAgent`). 오른쪽 위 시각. 길게 누르면 "@이름에게 답장"(에이전트만)·"복사".
struct MessageCard: View {
    enum Role: Equatable {
        case user
        /// 팀원을 모르면(팀 목록을 아직 못 읽었거나 제거됨) nil.
        case agent(member: TeamMember?)
    }

    let message: RoomMessage
    let role: Role
    /// 컨텍스트 메뉴 "@이름에게 답장". nil 이면 메뉴에 없다.
    var onReply: ((TeamMember) -> Void)? = nil

    /// VoiceOver: "지연(개발자): 본문", 사용자는 "나: 본문", 모르는 팀원은 "팀원: 본문".
    static func accessibilityLabel(message: RoomMessage, role: Role) -> String {
        switch role {
        case .user:
            return "\(String(localized: "나")): \(message.text)"
        case .agent(let member):
            guard let member else { return "\(String(localized: "팀원")): \(message.text)" }
            return "\(member.name)(\(member.roleLabel)): \(message.text)"
        }
    }

    /// 에이전트 카드 상단 칩의 텍스트(`MemberChip.text`). 사용자·모르는 팀원은 nil.
    static func chipText(for role: Role) -> String? {
        guard case .agent(let member) = role, let member else { return nil }
        return MemberChip.text(for: member)
    }

    var body: some View {
        Group {
            switch role {
            case .user:
                userCard
            case .agent(let member):
                agentCard(member)
            }
        }
        .contextMenu {
            if case .agent(let member) = role, let member, let onReply {
                Button {
                    onReply(member)
                } label: {
                    Label("@\(member.name)에게 답장", systemImage: "arrowshape.turn.up.left")
                }
            }
            Button {
                UIPasteboard.general.string = message.text
            } label: {
                Label("복사", systemImage: "doc.on.doc")
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Self.accessibilityLabel(message: message, role: role))
        .accessibilityIdentifier("room.message.\(message.id)")
    }

    private var userCard: some View {
        ItemCard(
            chrome: CardChrome(status: .completed, createdAt: message.createdAt, summary: nil),
            style: ItemStyle.roomStyle(for: .message(message)),
            background: Color.accentColor.opacity(0.10)
        ) {
            Text(message.text)
                .font(.body)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func agentCard(_ member: TeamMember?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if let member {
                    MemberChip(member: member)
                } else {
                    Text("팀원")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                Text(Formatters.clock(message.createdAt))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Markdown(message.text)
                .markdownTheme(Theme.macAgent(dimmed: false))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
    }
}
