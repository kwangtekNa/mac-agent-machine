import SwiftUI

/// 시스템 행(카드 아님): `info.circle` + 캡션 한 줄.
struct SystemRow: View {
    let payload: SystemPayload

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "info.circle")
            Text(payload.text).lineLimit(1)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity)
    }
}
