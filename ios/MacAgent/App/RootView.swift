import SwiftUI

/// 앱 루트. 연결 상태에 따라 ConnectView / 진행 표시 / 세션 홈을 보여준다(IOS.md 4절).
struct RootView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        switch appState.connection {
        case .disconnected, .failed:
            ConnectView()
        case .connecting:
            ProgressView("서버에 연결하는 중…")
        case .connected:
            if let client = appState.client {
                // 서버 주소가 바뀌면 `id` 가 바뀌어 SessionsStore 를 새로 만든다.
                ConnectedRootView(client: client)
                    .id(client.baseURL)
            } else {
                ConnectView()
            }
        }
    }
}

/// 연결된 동안 살아 있는 `SessionsStore` 를 만들고 환경에 넣는다.
private struct ConnectedRootView: View {
    @State private var store: SessionsStore

    init(client: APIClient) {
        _store = State(initialValue: SessionsStore(client: client))
    }

    var body: some View {
        SessionsHomeView()
            .environment(store)
    }
}
