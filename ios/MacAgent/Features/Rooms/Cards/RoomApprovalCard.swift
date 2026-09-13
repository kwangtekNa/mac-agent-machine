import SwiftUI

/// 방 승인 카드에 무엇을 그릴지(순수). 옵션 버튼은 카드에 없다(응답은 배너·시트, `ApprovalCard` 와 같은 규칙).
struct RoomApprovalCardState: Equatable {
    /// `approval.title`. 미러링 payload 가 빠졌으면 메시지 본문.
    let title: String
    /// `🧑‍💻 지연 · 개발자`. 팀원을 모르면 nil.
    let subtitle: String?
    /// 해결됐으면 `항상 허용됨 · 12:03`.
    let resolutionLine: String?
    let isPending: Bool

    static func make(message: RoomMessage, member: TeamMember?) -> RoomApprovalCardState {
        let subtitle = member.map { "\($0.emoji) \($0.name) · \($0.roleLabel)" }
        guard let mirrored = message.approval else {
            return RoomApprovalCardState(title: message.text, subtitle: subtitle, resolutionLine: nil, isPending: false)
        }
        let resolutionLine = mirrored.resolution.map {
            "\(ApprovalCardBody.resolutionLabel($0.optionId)) · \(Formatters.clock($0.at))"
        }
        return RoomApprovalCardState(
            title: mirrored.approval.title,
            subtitle: subtitle,
            resolutionLine: resolutionLine,
            isPending: mirrored.resolution == nil
        )
    }
}

/// 방에 미러링된 승인(PROTOCOL.md 6.4). `ItemCard` + 팀원 칩 + `ApprovalCardBody`(타임라인 `ApprovalCard` 와 같은 본문).
/// 대기 중은 노란 배경·`hand.raised.fill`, 해결되면 "허용됨 · 12:03" 한 줄. 상세는 `ApprovalSheet`(배너와 같은 모델).
struct RoomApprovalCard: View {
    let message: RoomMessage
    let member: TeamMember?
    var onShowDetail: (() -> Void)? = nil

    var body: some View {
        let state = RoomApprovalCardState.make(message: message, member: member)
        ItemCard(
            chrome: CardChrome(status: .completed, createdAt: message.createdAt, summary: nil),
            style: ItemStyle.roomStyle(for: .approval(message)),
            title: state.title,
            background: state.isPending ? Color.yellow.opacity(0.18) : Color(.secondarySystemGroupedBackground)
        ) {
            if let member {
                MemberChip(member: member)
            }
            if let mirrored = message.approval {
                ApprovalCardBody(
                    approval: mirrored.approval,
                    resolution: mirrored.resolution,
                    onShowDetail: state.isPending ? onShowDetail : nil
                )
            }
        }
        .accessibilityIdentifier("room.approval.\(message.id)")
    }
}
