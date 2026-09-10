import SwiftUI

/// 공통 카드 컨테이너(IOS.md 5.3): 24pt 아이콘 열(`running` 이면 mini 진행 표시), 제목 한 줄, 오른쪽 위 시각, 본문 슬롯. 그림자 없음.
struct ItemCard<Content: View>: View {
    let item: TimelineItem
    let style: ItemStyle
    var title: String? = nil
    var titleMonospaced = false
    var badge: String? = nil
    var background: Color = Color(.secondarySystemGroupedBackground)
    @ViewBuilder var content: () -> Content

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            if !style.symbol.isEmpty {
                ZStack(alignment: .bottomTrailing) {
                    Image(systemName: style.symbol)
                        .foregroundStyle(style.tint(for: item.status))
                    if item.status == .running {
                        ProgressView().controlSize(.mini).offset(x: 8, y: 6)
                    }
                }
                .frame(width: 24, alignment: .center)
                .padding(.top, 2)
            }
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if let title {
                        Text(title)
                            .font(titleMonospaced ? .subheadline.monospaced() : .subheadline.weight(.semibold))
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    if let badge {
                        Text(badge)
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Color.red.opacity(0.15), in: Capsule())
                            .foregroundStyle(.red)
                    }
                    if item.status == .cancelled {
                        Text("취소됨").font(.caption2).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 8)
                    Text(Formatters.clock(item.createdAt))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                content()
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(background, in: RoundedRectangle(cornerRadius: 12))
    }
}
