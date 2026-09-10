import SwiftUI

/// 승인 아이템(읽기 전용). 대기 중이면 노란 카드 + "자세히 보기"(시트). 허용/거절 버튼은 배너에만 있다.
/// 처리됐으면 "허용됨 · 12:03" 한 줄.
struct ApprovalCard: View {
    let item: TimelineItem
    let payload: ApprovalPayload
    var onShowDetail: (() -> Void)? = nil

    var body: some View {
        if let resolution = payload.resolution {
            ItemCard(item: item, style: ItemStyle.style(for: item), title: payload.approval.title) {
                Text("\(Self.resolutionLabel(resolution.optionId)) · \(Formatters.clock(resolution.at))")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        } else {
            ItemCard(item: item, style: ItemStyle.style(for: item), title: payload.approval.title, background: Color.yellow.opacity(0.18)) {
                Text(payload.approval.prompt)
                    .font(.subheadline)
                    .textSelection(.enabled)
                if let onShowDetail {
                    Button("자세히 보기", action: onShowDetail)
                        .font(.caption)
                        .buttonStyle(.borderless)
                }
            }
        }
    }

    static func resolutionLabel(_ optionId: String) -> String {
        switch optionId {
        case "allow": return String(localized: "허용됨")
        case "allow_session": return String(localized: "항상 허용됨")
        case "deny": return String(localized: "거절됨")
        case "abort": return String(localized: "중단됨")
        default: return optionId
        }
    }
}
