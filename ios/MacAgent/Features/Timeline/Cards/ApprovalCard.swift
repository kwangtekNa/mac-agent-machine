import SwiftUI

/// 승인 아이템(읽기 전용). 대기 중이면 노란 카드 + "아래 배너에서 응답하세요"(응답 버튼은 step 6),
/// 처리됐으면 "허용됨 · 12:03" 한 줄.
struct ApprovalCard: View {
    let item: TimelineItem
    let payload: ApprovalPayload

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
                Text("아래 배너에서 응답하세요")
                    .font(.caption)
                    .foregroundStyle(.secondary)
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
