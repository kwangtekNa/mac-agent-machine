import SwiftUI

/// 세션 제목 아래 부제·게이지 상태(IOS.md 9.3). `subtitle == nil` 이면 기존 상태 텍스트를 쓴다.
/// 컨텍스트는 `idle`/`running` 일 때만 보인다. `waiting_approval`/`error` 는 상태 문구가 우선이다.
struct ContextGaugeState: Equatable, Sendable {
    /// `컨텍스트 21% · 42k/200k`. nil 이면 상태 텍스트.
    var subtitle: String?
    /// 0~100 으로 클램프한 게이지 값. nil 이면 게이지를 그리지 않는다.
    var percent: Int?

    init(subtitle: String? = nil, percent: Int? = nil) {
        self.subtitle = subtitle
        self.percent = percent
    }

    static func make(status: SessionStatus, context: ContextUsage?) -> ContextGaugeState {
        guard let context, status == .idle || status == .running else { return ContextGaugeState() }
        return ContextGaugeState(
            subtitle: Formatters.contextLine(tokens: context.tokens, window: context.window, percent: context.percent),
            percent: min(max(context.percent, 0), 100)
        )
    }
}

extension TimelineModel {
    /// 컨텍스트 게이지 색(`UsageLevel`). 컨텍스트를 모르면 기본 tint.
    var contextTint: Color {
        UsageLevel.tint(percent: contextUsage?.percent ?? 0)
    }
}

/// 툴바 principal: 제목 + 부제(컨텍스트 또는 상태) + 3pt 게이지. 탭하면 세션 정보 시트.
struct ContextGaugeView: View {
    let title: String
    let statusText: String
    let gauge: ContextGaugeState
    let tint: Color
    /// 부제 앞에 붙는 팀 배지(`🧑‍💻 지연 · backend`). 팀원 세션이 아니면 nil.
    var prefix: String? = nil
    let onTap: () -> Void

    /// 부제 한 줄: 팀 배지 · 컨텍스트(또는 상태).
    var subtitle: String {
        [prefix, gauge.subtitle ?? statusText].compactMap { $0 }.joined(separator: " · ")
    }

    var body: some View {
        Button(action: onTap) {
            VStack(spacing: 2) {
                Text(title).font(.headline).lineLimit(1)
                Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                if let percent = gauge.percent {
                    ProgressView(value: Double(percent), total: 100)
                        .progressViewStyle(.linear)
                        .tint(tint)
                        .frame(height: 3)
                }
            }
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title), \(subtitle)")
        .accessibilityHint("세션 정보 보기")
        .accessibilityIdentifier("timeline.contextGauge")
    }
}
