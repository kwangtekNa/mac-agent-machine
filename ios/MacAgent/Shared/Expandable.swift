import SwiftUI

/// 카드 안의 상자(도구 출력·입력 JSON·diff)에 "전체 화면으로 보기" 동작을 붙인다:
/// 더블 탭, 오른쪽 위 펼침 버튼, VoiceOver 접근성 동작. 더블 탭은 눈에 보이지 않는 동작이라 버튼을 같이 둔다.
struct ExpandableModifier: ViewModifier {
    static let actionName = String(localized: "전체 화면으로 보기")

    let onExpand: () -> Void

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .topTrailing) {
                Button(action: onExpand) {
                    Image(systemName: "arrow.up.left.and.arrow.down.right")
                        .font(.caption.weight(.semibold))
                        .padding(6)
                        .background(Color(.secondarySystemGroupedBackground).opacity(0.9), in: Circle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .padding(4)
                .accessibilityLabel(Self.actionName)
                .accessibilityIdentifier("expandable.button")
            }
            .contentShape(Rectangle())
            .onTapGesture(count: 2, perform: onExpand)
            .accessibilityAction(named: Self.actionName, onExpand)
    }
}

extension View {
    /// `onExpand` 가 nil 이면 아무것도 붙이지 않는다.
    @ViewBuilder
    func expandable(onExpand: (() -> Void)?) -> some View {
        if let onExpand {
            modifier(ExpandableModifier(onExpand: onExpand))
        } else {
            self
        }
    }
}
