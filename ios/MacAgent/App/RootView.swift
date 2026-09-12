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

/// 연결된 동안 살아 있는 `SessionsStore`·`TeamsStore`(서버별)와 `RolePresetStore`(앱 로컬)를 만들고 환경에 넣는다.
/// 가로 크기 클래스가 regular(iPad) 면 3열 분리 뷰, 아니면 compact `NavigationStack` 흐름. 크기가 바뀌어도 store 는 유지된다.
private struct ConnectedRootView: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var store: SessionsStore
    @State private var teams: TeamsStore
    @State private var rolePresets = RolePresetStore()

    init(client: APIClient) {
        _store = State(initialValue: SessionsStore(client: client))
        _teams = State(initialValue: TeamsStore(client: client))
    }

    var body: some View {
        Group {
            if horizontalSizeClass == .regular {
                SplitRootView()
            } else {
                SessionsHomeView()
            }
        }
        .environment(store)
        .environment(teams)
        .environment(rolePresets)
    }
}
