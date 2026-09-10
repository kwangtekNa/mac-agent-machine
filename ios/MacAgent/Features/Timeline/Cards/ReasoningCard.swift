import SwiftUI

/// 사고 요약: 기본 접힘 "생각 요약", 본문 `.secondary`.
struct ReasoningCard: View {
    let item: TimelineItem
    let payload: ReasoningPayload
    @State private var expanded = false

    var body: some View {
        ItemCard(item: item, style: ItemStyle.style(for: item)) {
            DisclosureGroup("생각 요약", isExpanded: $expanded) {
                Text(payload.text.isEmpty ? "…" : payload.text)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 4)
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
    }
}
