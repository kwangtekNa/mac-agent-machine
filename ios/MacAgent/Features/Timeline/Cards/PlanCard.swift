import SwiftUI

/// 계획: 단계 목록. completed 초록 체크, in_progress 점선 원 + 진행 표시, pending 원.
struct PlanCard: View {
    let item: TimelineItem
    let payload: PlanPayload

    var body: some View {
        ItemCard(item: item, style: ItemStyle.style(for: item), title: String(localized: "계획")) {
            ForEach(Array(payload.steps.enumerated()), id: \.offset) { _, step in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    switch step.status {
                    case .completed:
                        Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                    case .inProgress:
                        HStack(spacing: 4) {
                            Image(systemName: "circle.dotted")
                            ProgressView().controlSize(.mini)
                        }
                    default:
                        Image(systemName: "circle").foregroundStyle(.secondary)
                    }
                    Text(step.text)
                        .font(.subheadline)
                        .foregroundStyle(step.status == .completed ? .secondary : .primary)
                }
                .font(.subheadline)
            }
        }
    }
}
