import SwiftUI

/// 앱 루트. step 3(Connect 흐름)에서 실제 화면으로 교체된다.
struct RootView: View {
    var body: some View {
        NavigationStack {
            ContentUnavailableView(
                "서버에 연결",
                systemImage: "network",
                description: Text("설정에서 Mac 서버 주소를 입력하세요")
            )
        }
    }
}

#Preview {
    RootView()
}
