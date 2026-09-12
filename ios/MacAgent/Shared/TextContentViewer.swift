import SwiftUI

/// 전체 화면 텍스트 뷰어. 카드의 상자(도구 출력·입력 JSON·파일 변경 diff)를 더블 탭하면 `fullScreenCover` 로 열린다.
/// 텍스트·코드는 파일 뷰어와 같은 `HighlightedCodeView`(UITextView, 선택 가능, 줄바꿈 토글)로, diff 는 `DiffTextView`(줄 색)로 그린다.
/// 실행 중인 도구의 출력이 늘어나면 그대로 따라간다(부모가 새 `content` 를 넘긴다).
struct TextContentViewer: View {
    enum Content: Equatable {
        /// 하이라이트 없는 monospaced 텍스트(도구 출력).
        case text(String)
        /// 언어 하이라이트가 있는 코드(도구 입력 JSON 등). `language` 는 서버 언어 식별자.
        case code(String, language: String)
        /// unified diff.
        case diff(String)

        /// 공유·복사용 원문.
        var rawText: String {
            switch self {
            case .text(let text), .diff(let text): return text
            case .code(let text, _): return text
            }
        }

        /// diff 는 줄 단위 색 뷰라 줄바꿈 토글이 없다.
        var allowsWrapToggle: Bool {
            if case .diff = self { return false }
            return true
        }
    }

    let title: String
    /// 제목 아래 캡션: "도구 출력", "도구 입력", "변경 내용".
    let subtitle: String
    let content: Content
    /// 서버가 잘라낸 내용이면 상단 배너.
    let truncated: Bool

    @Environment(\.dismiss) private var dismiss
    @State private var wrapLines = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if truncated {
                    Label("출력 일부만 표시", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .padding(8)
                        .frame(maxWidth: .infinity)
                        .background(Color(.secondarySystemGroupedBackground))
                }
                contentView
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 0) {
                        Text(title).font(.headline.monospaced()).lineLimit(1).truncationMode(.middle)
                        Text(subtitle).font(.caption).foregroundStyle(.secondary)
                    }
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if content.allowsWrapToggle {
                        Button {
                            wrapLines.toggle()
                        } label: {
                            Image(systemName: "return")
                                .symbolVariant(wrapLines ? .fill : .none)
                        }
                        .tint(wrapLines ? .accentColor : .secondary)
                        .accessibilityLabel(wrapLines ? "줄바꿈 끄기" : "줄바꿈 켜기")
                    }
                    ShareLink(item: content.rawText) {
                        Image(systemName: "square.and.arrow.up")
                    }
                    .accessibilityLabel("공유")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("완료") { dismiss() }
                        .accessibilityIdentifier("textViewer.done")
                }
            }
        }
    }

    @ViewBuilder
    private var contentView: some View {
        switch content {
        case .text(let text):
            HighlightedCodeView(text: text, language: nil, highlightEnabled: false, wrapLines: wrapLines)
                .ignoresSafeArea(edges: .bottom)
        case .code(let text, let language):
            HighlightedCodeView(
                text: text,
                language: HighlightrLanguage.name(for: language),
                highlightEnabled: FileViewerLogic.shouldHighlight(size: text.utf8.count, language: language),
                wrapLines: wrapLines
            )
            .ignoresSafeArea(edges: .bottom)
        case .diff(let patch):
            ScrollView {
                DiffTextView(patch: patch)
                    .padding(.vertical, 8)
            }
            .background(Color(.systemBackground))
        }
    }
}
