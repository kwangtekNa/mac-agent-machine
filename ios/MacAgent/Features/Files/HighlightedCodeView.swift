import Highlightr
import SwiftUI
import UIKit

/// Highlightr 호출을 감싼 순수 함수. 백그라운드(`Task.detached`)에서 부른다.
enum CodeHighlighter {
    static let lightTheme = "xcode"
    static let darkTheme = "atom-one-dark"

    static func highlight(_ code: String, language: String, dark: Bool, fontSize: CGFloat) -> AttributedString? {
        guard let highlightr = Highlightr() else { return nil }
        highlightr.setTheme(to: dark ? darkTheme : lightTheme)
        highlightr.theme.setCodeFont(UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular))
        guard let result = highlightr.highlight(code, as: language, fastRender: true) else { return nil }
        return AttributedString(result)
    }
}

/// 줄바꿈을 끄면 가장 긴 줄 너비만큼 contentSize 를 넓혀 가로 스크롤이 되게 한다(UITextView 는 기본적으로 너비를 bounds 에 맞춘다).
final class CodeTextView: UITextView {
    var wrapsLines = true {
        didSet { if wrapsLines != oldValue { setNeedsLayout() } }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard !wrapsLines else { return }
        layoutManager.ensureLayout(for: textContainer)
        let used = layoutManager.usedRect(for: textContainer)
        let width = ceil(used.width + textContainerInset.left + textContainerInset.right + textContainer.lineFragmentPadding * 2)
        if width > bounds.width, abs(contentSize.width - width) > 0.5 {
            contentSize.width = width
        }
    }
}

/// 비편집·선택 가능 UITextView. plain 텍스트를 먼저 그리고, 하이라이트는 백그라운드에서 만들어 결과만 메인에 적용한다.
struct HighlightedCodeView: UIViewRepresentable {
    let text: String
    /// Highlightr 언어 이름. nil 이면 하이라이트 없음.
    let language: String?
    let highlightEnabled: Bool
    let wrapLines: Bool

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    @MainActor
    final class Coordinator {
        var task: Task<Void, Never>?
        var appliedKey: String?
        var pendingKey: String?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> CodeTextView {
        let textView = CodeTextView()
        // TextKit 1 로 고정: 줄바꿈을 끈 상태의 가로 contentSize 계산이 안정적이다.
        _ = textView.layoutManager
        textView.isEditable = false
        textView.isSelectable = true
        textView.isScrollEnabled = true
        textView.alwaysBounceVertical = true
        textView.dataDetectorTypes = []
        textView.adjustsFontForContentSizeCategory = false
        textView.backgroundColor = .systemBackground
        textView.textContainerInset = UIEdgeInsets(top: 8, left: 8, bottom: 8, right: 8)
        return textView
    }

    func updateUIView(_ textView: CodeTextView, context: Context) {
        applyWrapping(to: textView)

        let bodySize = UIFont.preferredFont(forTextStyle: .body, compatibleWith: textView.traitCollection).pointSize
        let fontSize = FileViewerLogic.codeFontSize(bodyPointSize: bodySize)
        let dark = colorScheme == .dark
        let key = "\(text.hashValue)|\(text.utf8.count)|\(language ?? "")|\(highlightEnabled)|\(dark)|\(fontSize)"
        let coordinator = context.coordinator
        guard coordinator.appliedKey != key, coordinator.pendingKey != key else { return }

        coordinator.task?.cancel()
        coordinator.pendingKey = nil
        textView.font = UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
        textView.textColor = .label
        textView.text = text
        textView.setNeedsLayout()

        guard highlightEnabled, let language else {
            coordinator.appliedKey = key
            return
        }
        coordinator.pendingKey = key
        let code = text
        coordinator.task = Task { @MainActor in
            let result = await Task.detached(priority: .userInitiated) {
                CodeHighlighter.highlight(code, language: language, dark: dark, fontSize: fontSize)
            }.value
            guard !Task.isCancelled, coordinator.pendingKey == key else { return }
            coordinator.pendingKey = nil
            coordinator.appliedKey = key
            if let result {
                textView.attributedText = NSAttributedString(result)
                textView.setNeedsLayout()
            }
        }
    }

    static func dismantleUIView(_ textView: CodeTextView, coordinator: Coordinator) {
        coordinator.task?.cancel()
    }

    private func applyWrapping(to textView: CodeTextView) {
        textView.wrapsLines = wrapLines
        let container = textView.textContainer
        if wrapLines {
            container.widthTracksTextView = true
            container.lineBreakMode = .byCharWrapping
            let insets = textView.textContainerInset
            container.size = CGSize(
                width: max(textView.bounds.width - insets.left - insets.right, 0),
                height: CGFloat.greatestFiniteMagnitude
            )
        } else {
            container.widthTracksTextView = false
            container.lineBreakMode = .byClipping
            container.size = CGSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        }
        textView.showsHorizontalScrollIndicator = !wrapLines
    }
}
