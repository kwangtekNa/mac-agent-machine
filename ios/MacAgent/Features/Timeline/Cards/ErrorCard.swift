import SwiftUI

/// 오류: 빨간 아이콘 + 메시지. recoverable 이면 "다시 시도"(컴포저에 포커스만).
struct ErrorCard: View {
    let item: TimelineItem
    let payload: ErrorPayload
    let onRetry: () -> Void

    var body: some View {
        ItemCard(item: item, style: ItemStyle.style(for: item), title: String(localized: "오류")) {
            Text(payload.message)
                .font(.subheadline)
                .textSelection(.enabled)
            if payload.recoverable {
                Button("다시 시도", action: onRetry)
                    .font(.caption)
                    .buttonStyle(.bordered)
            }
        }
    }
}
