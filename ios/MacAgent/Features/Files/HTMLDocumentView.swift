import SwiftUI
import WebKit

/// `GET /fs/render` 가 준 자체 완결 HTML(한글 문서)을 보여준다(ADR-012: 새 패키지 없이 `WebKit` 만).
/// 스크립트는 꺼져 있고 링크 탭은 무시한다(외부 브라우저로 넘기지 않는다). 다크 모드는 CSS `color-scheme` 로 따라간다.
struct HTMLDocumentView: View {
    let document: FsRenderResponse

    var body: some View {
        VStack(spacing: 0) {
            if let warning = Self.warningText(document.warnings) {
                Label(warning, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(.secondarySystemGroupedBackground))
                    .accessibilityIdentifier("documentViewer.warnings")
            }
            WebDocumentView(html: Self.document(html: document.html))
                .ignoresSafeArea(edges: .bottom)
        }
    }

    /// 변환하지 못한 부분 안내(IOS.md 5.5: 원인 한 문장). 없으면 배너를 띄우지 않는다.
    static func warningText(_ warnings: [String]) -> String? {
        guard !warnings.isEmpty else { return nil }
        return String(localized: "일부 요소는 표시되지 않았습니다: \(warnings.joined(separator: ", "))")
    }

    /// 서버 HTML 앞에 다크 모드·가로 맞춤 CSS 만 넣는다(스크립트는 넣지 않는다).
    static func document(html: String) -> String {
        """
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>:root{color-scheme: light dark;}body{margin:0;padding:12px;font:-apple-system-body;}\
        img,table{max-width:100%;}table{overflow-x:auto;display:block;}</style>
        """ + html
    }

    /// `loadHTMLString` 자체(`.other`)만 허용하고 링크 탭·폼 전송은 막는다.
    static func allowsNavigation(_ type: WKNavigationType) -> Bool {
        type == .other
    }
}

/// 정적 HTML 전용 WKWebView. 스크립트 비활성, 이동 금지.
private struct WebDocumentView: UIViewRepresentable {
    let html: String

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.scrollView.backgroundColor = .systemBackground
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard context.coordinator.loaded != html else { return }
        context.coordinator.loaded = html
        webView.loadHTMLString(html, baseURL: nil)
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        var loaded: String?

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
        ) {
            decisionHandler(HTMLDocumentView.allowsNavigation(navigationAction.navigationType) ? .allow : .cancel)
        }
    }
}
