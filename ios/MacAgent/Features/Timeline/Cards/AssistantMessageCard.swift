import MarkdownUI
import SwiftUI

/// 에이전트 메시지: MarkdownUI. 스트리밍 중(`running`)에는 50ms 디바운스로 렌더하고,
/// 끝난 아이템은 항상 `payload.text` 를 그대로 그린다(디바운스가 마지막 델타를 놓치지 않도록). `commentary` 는 `.secondary`.
struct AssistantMessageCard: View {
    static let debounce: Duration = .milliseconds(50)

    let item: TimelineItem
    let payload: AssistantMessagePayload
    /// 스트리밍 중 마지막으로 그린 텍스트.
    @State private var streamed = ""
    /// 본문의 `localhost` 링크를 Mac 주소로 바꿀 기준(앱 루트가 넣는다). 없으면 시스템이 그대로 연다.
    @Environment(\.previewServerURL) private var previewServerURL
    /// 변환된 링크를 여는 앱 안 브라우저.
    @State private var safariLink: SafariLink?

    var body: some View {
        ItemCard(item: item, style: ItemStyle.style(for: item)) {
            Markdown(item.status == .running ? streamed : payload.text)
                .markdownTheme(Theme.macAgent(dimmed: payload.phase == .commentary))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .previewLinks(serverURL: previewServerURL, into: $safariLink)
        }
        .safariSheet(link: $safariLink)
        .task(id: payload.text) {
            guard item.status == .running else { return }
            try? await Task.sleep(for: Self.debounce)
            guard !Task.isCancelled else { return }
            streamed = payload.text
        }
    }
}

extension Theme {
    /// `.gitHub` 기반, 폰트는 시스템 `.body`, 코드블록은 monospaced + 가로 스크롤 + tertiary 배경.
    @MainActor
    static func macAgent(dimmed: Bool) -> Theme {
        Theme.gitHub
            .text {
                ForegroundColor(dimmed ? .secondary : .primary)
                FontSize(UIFont.preferredFont(forTextStyle: .body).pointSize)
            }
            .codeBlock { configuration in
                ScrollView(.horizontal, showsIndicators: false) {
                    configuration.label
                        .relativeLineSpacing(.em(0.225))
                        .markdownTextStyle {
                            FontFamilyVariant(.monospaced)
                            FontSize(.em(0.85))
                        }
                        .padding(12)
                }
                .background(Color(.tertiarySystemGroupedBackground))
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .markdownMargin(top: 0, bottom: 16)
            }
    }
}
