import SwiftUI

/// 턴 요약(카드 아님): 가운데 정렬 캡션 `12초 · 1.2k 토큰 · $0.03`.
struct TurnSummaryRow: View {
    let payload: TurnSummaryPayload

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "clock")
            Text(text)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity)
    }

    private var text: String {
        var parts = [
            Formatters.duration(ms: payload.durationMs),
            String(localized: "\(Formatters.tokens(payload.usage.inputTokens + payload.usage.outputTokens)) 토큰"),
        ]
        if let cost = payload.costUsd { parts.append(Formatters.usd(cost)) }
        return parts.joined(separator: " · ")
    }
}
