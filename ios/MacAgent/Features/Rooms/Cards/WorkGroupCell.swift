import SwiftUI

/// 연속된 작업 카드를 접어 놓은 셀(IOS.md 10.12). 머리 줄을 탭하면 **그 자리에서** 펼쳐지고,
/// 펼친 모습은 개별 카드(`RoomApprovalCard`·`ChangesReadyCard`·시스템 행)를 `RoomEntryRow` 로 기존 뷰 그대로 그린다.
/// 펼침 상태는 `RoomView` 가 그룹 id 로 들고 있고(`Set<String>`) 이 뷰는 무상태다.
struct WorkGroupCell: View {
    /// 그룹 id(첫 항목의 id). 식별자와 펼침 상태의 열쇠.
    let id: String
    let entries: [RoomEntry]
    let summary: WorkGroupSummary
    let members: [TeamMember]
    let isExpanded: Bool
    let onToggle: () -> Void
    /// 펼친 승인 카드의 "자세히 보기"(approvalId).
    var onApprovalDetail: ((String) -> Void)? = nil
    var mergeSubmit: MergeSubmitState = .idle
    var onMerge: ((ChangeSet) -> Void)? = nil
    var onDismiss: ((ChangeSet) -> Void)? = nil

    var body: some View {
        VStack(spacing: 12) {
            Button(action: onToggle) { header }
                .buttonStyle(.plain)
                .accessibilityLabel(summary.accessibilityLabel)
                .accessibilityHint(isExpanded ? "두 번 탭하면 접습니다" : "두 번 탭하면 펼칩니다")
                .accessibilityIdentifier("room.workGroup.\(id)")
            if isExpanded {
                ForEach(entries) { entry in
                    RoomEntryRow(
                        entry: entry,
                        members: members,
                        onReply: { _ in },
                        onApprovalDetail: onApprovalDetail,
                        mergeSubmit: mergeSubmit,
                        onMerge: onMerge,
                        onDismiss: onDismiss
                    )
                    .id(entry.id)
                }
            }
        }
        .accessibilityElement(children: .contain)
    }

    /// 머지를 기다리는 변경이 있으면 `tray.full`(받아 둘 것이 쌓였다), 아니면 `hammer`.
    private var symbol: String {
        summary.mergeReady > 0 ? "tray.full" : "hammer"
    }

    private var header: some View {
        ItemCard(
            chrome: CardChrome(status: .completed, createdAt: entries.last?.createdAt ?? Date(), summary: nil),
            style: ItemStyle(symbol: symbol, tint: .secondary, defaultExpanded: false),
            title: summary.title
        ) {
            HStack(spacing: 6) {
                if !summary.detail.isEmpty {
                    Text(summary.detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                if let badge = summary.badge {
                    Label(badge, systemImage: "arrow.triangle.merge")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.yellow.opacity(0.18), in: Capsule())
                }
                Spacer(minLength: 4)
                Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
        }
    }
}
