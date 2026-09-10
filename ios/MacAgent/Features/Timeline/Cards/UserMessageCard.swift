import SwiftUI

/// 사용자 메시지: 옅은 accent 배경, 마크다운 아님, 선택 가능, 첨부 이미지 썸네일.
struct UserMessageCard: View {
    let item: TimelineItem
    let payload: UserMessagePayload

    var body: some View {
        ItemCard(item: item, style: ItemStyle.style(for: item), background: Color.accentColor.opacity(0.10)) {
            Text(payload.text)
                .font(.body)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            if !payload.attachments.isEmpty {
                HStack(spacing: 8) {
                    ForEach(Array(payload.attachments.enumerated()), id: \.offset) { _, attachment in
                        if let data = Data(base64Encoded: attachment.base64), let image = UIImage(data: data) {
                            Image(uiImage: image)
                                .resizable()
                                .scaledToFill()
                                .frame(width: 72, height: 72)
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                    }
                }
            }
        }
    }
}
