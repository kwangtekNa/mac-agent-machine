import SwiftUI

/// 앱 루트. 연결 상태에 따라 ConnectView / 진행 표시 / 세션 홈(자리표시자)을 보여준다(IOS.md 4절).
struct RootView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        switch appState.connection {
        case .disconnected, .failed:
            ConnectView()
        case .connecting:
            ProgressView("서버에 연결하는 중…")
        case .connected(let me):
            SessionsHomePlaceholderView(me: me)
        }
    }
}

/// step 4(세션 목록)가 교체하는 임시 홈. 연결 요약과 설정 진입만 있다.
struct SessionsHomePlaceholderView: View {
    @Environment(AppState.self) private var appState
    let me: MeResponse
    @State private var showsSettings = false

    var body: some View {
        NavigationStack {
            ContentUnavailableView {
                Label("연결됨", systemImage: "checkmark.circle")
            } description: {
                Text("\(me.user) 계정으로 \(serverHost)에 연결했습니다.\n세션 목록은 곧 제공됩니다.")
            }
            .navigationTitle("세션")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showsSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("설정 열기")
                }
            }
            .sheet(isPresented: $showsSettings) {
                SettingsView()
            }
        }
    }

    private var serverHost: String {
        appState.configStore.config?.baseURL.host() ?? String(localized: "서버")
    }
}
