import SafariServices
import SwiftUI

/// `.sheet(item:)` 에 넣는 URL 래퍼(URL 자체는 `Identifiable` 이 아니다).
struct SafariLink: Identifiable, Hashable, Sendable {
    let url: URL

    var id: String { url.absoluteString }

    init(_ url: URL) {
        self.url = url
    }
}

/// 앱 안 브라우저. ADR-012 대로 새 패키지 없이 `SafariServices` 만 쓴다(WKWebView 로 자체 브라우저를 만들지 않는다).
/// 닫으면 시트가 사라지고 원래 화면으로 돌아간다.
struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let controller = SFSafariViewController(url: url)
        controller.dismissButtonStyle = .close
        return controller
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}

extension View {
    /// 앱 안 브라우저 시트. 값이 들어오면 열리고, 닫으면 nil 로 돌아간다.
    func safariSheet(link: Binding<SafariLink?>) -> some View {
        sheet(item: link) { item in
            SafariView(url: item.url).ignoresSafeArea()
        }
    }

    /// 마크다운 링크 탭 가로채기: `localhost` 계열이면 Mac 주소로 바꿔 앱 안 브라우저로, 그 외는 시스템이 연다.
    /// `serverURL` 이 없으면(연결 전·테스트) 아무것도 바꾸지 않는다.
    func previewLinks(serverURL: URL?, into link: Binding<SafariLink?>) -> some View {
        environment(\.openURL, OpenURLAction { url in
            guard let serverURL, let rewritten = PreviewLink.rewrite(url, serverURL: serverURL) else {
                return .systemAction
            }
            link.wrappedValue = SafariLink(rewritten)
            return .handled
        })
    }
}

/// 저장된 서버 URL. 앱 루트가 넣고 카드가 링크 변환 기준으로 읽는다(카드가 `AppState` 에 직접 매달리지 않게).
private struct PreviewServerURLKey: EnvironmentKey {
    static let defaultValue: URL? = nil
}

extension EnvironmentValues {
    var previewServerURL: URL? {
        get { self[PreviewServerURLKey.self] }
        set { self[PreviewServerURLKey.self] = newValue }
    }
}
