import SwiftUI

/// 카드 컨테이너가 `TimelineItem` 에서 실제로 쓰는 것: 상태(아이콘 색·진행 표시·"취소됨"), 시각, 접근성 요약.
/// 방 카드(step 6)처럼 `TimelineItem` 이 없는 곳에서도 같은 컨테이너를 쓰기 위한 값이다.
struct CardChrome: Equatable {
    var status: ItemStatus
    var createdAt: Date
    /// VoiceOver 요약("도구 실행 npm test, 완료"). nil 이면 합쳐진 자식 텍스트가 그대로 읽힌다.
    var summary: String?
}

/// 공통 카드 컨테이너(IOS.md 5.3): 24pt 아이콘 열(`running` 이면 mini 진행 표시), 제목 한 줄, 오른쪽 위 시각, 본문 슬롯. 그림자 없음.
/// 접근성: 카드 하나가 한 요소로 읽힌다. 제목이 있는 종류(도구·파일 변경·계획 등)는 "도구 실행 npm test, 완료" 식 요약 라벨을 쓰고,
/// 메시지 카드는 본문이 그대로 읽히도록 합쳐진 자식 텍스트를 유지한다.
struct ItemCard<Content: View>: View {
    let chrome: CardChrome
    let style: ItemStyle
    let title: String?
    let titleMonospaced: Bool
    let badge: String?
    let background: Color
    let content: () -> Content

    init(
        chrome: CardChrome,
        style: ItemStyle,
        title: String? = nil,
        titleMonospaced: Bool = false,
        badge: String? = nil,
        background: Color = Color(.secondarySystemGroupedBackground),
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.chrome = chrome
        self.style = style
        self.title = title
        self.titleMonospaced = titleMonospaced
        self.badge = badge
        self.background = background
        self.content = content
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            if !style.symbol.isEmpty {
                ZStack(alignment: .bottomTrailing) {
                    Image(systemName: style.symbol)
                        .foregroundStyle(style.tint(for: chrome.status))
                    if chrome.status == .running {
                        ProgressView().controlSize(.mini).offset(x: 8, y: 6)
                    }
                }
                .frame(width: 24, alignment: .center)
                .padding(.top, 2)
                .accessibilityHidden(true)
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
                    if chrome.status == .cancelled {
                        Text("취소됨").font(.caption2).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 8)
                    Text(Formatters.clock(chrome.createdAt))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                content()
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(background, in: RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .combine)
        .modifier(SummaryLabel(summary: chrome.summary))
    }
}

extension ItemCard {
    /// 타임라인 아이템용. `CardChrome` 을 만들어 위임하며 접근성 요약은 `ItemAccessibility.summary` 그대로다.
    init(
        item: TimelineItem,
        style: ItemStyle,
        title: String? = nil,
        titleMonospaced: Bool = false,
        badge: String? = nil,
        background: Color = Color(.secondarySystemGroupedBackground),
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.init(
            chrome: CardChrome(
                status: item.status,
                createdAt: item.createdAt,
                summary: ItemAccessibility.summary(for: item, title: title)
            ),
            style: style,
            title: title,
            titleMonospaced: titleMonospaced,
            badge: badge,
            background: background,
            content: content
        )
    }
}

/// 요약이 있을 때만 라벨을 덮어쓴다(없으면 합쳐진 자식 텍스트가 그대로 읽힌다).
private struct SummaryLabel: ViewModifier {
    let summary: String?

    func body(content: Content) -> some View {
        if let summary {
            content.accessibilityLabel(summary)
        } else {
            content
        }
    }
}

/// 타임라인 카드의 VoiceOver 요약 규칙.
enum ItemAccessibility {
    /// 종류 이름. 메시지 종류는 본문을 읽어야 하므로 nil.
    static func kindLabel(for item: TimelineItem) -> String? {
        switch item.payload {
        case .userMessage, .assistantMessage, .turnSummary, .system, .approval: return nil
        case .reasoning: return String(localized: "생각")
        case .toolCall: return String(localized: "도구 실행")
        case .fileChange: return String(localized: "파일 변경")
        case .plan: return String(localized: "계획")
        case .error: return String(localized: "오류")
        }
    }

    static func statusLabel(_ status: ItemStatus) -> String? {
        switch status {
        case .running: return String(localized: "진행 중")
        case .completed: return String(localized: "완료")
        case .failed: return String(localized: "실패")
        case .cancelled: return String(localized: "취소됨")
        case .unknown: return nil
        }
    }

    /// "도구 실행 npm test, 완료". 종류 라벨이 없으면 nil(합쳐진 본문을 읽는다).
    static func summary(for item: TimelineItem, title: String?) -> String? {
        guard let kind = kindLabel(for: item) else { return nil }
        var head = kind
        if let title, !title.isEmpty { head += " " + title }
        if let status = statusLabel(item.status) { return head + ", " + status }
        return head
    }
}
