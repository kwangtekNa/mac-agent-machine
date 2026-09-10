import SwiftUI

/// iPad(regular) 3열(IOS.md 4절): 사이드바 세션 목록, 콘텐츠 타임라인, 디테일 파일 브라우저.
/// 선택과 세션별 모델은 `AppState` 가 들고 있어 회전·멀티태스킹으로 뷰가 다시 만들어져도 유지된다.
struct SplitRootView: View {
    @Environment(AppState.self) private var appState
    @Environment(SessionsStore.self) private var store
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    /// 타임라인 툴바 "파일" 버튼이 토글한다. 꺼지면 디테일 열에 안내만 남는다.
    @State private var showsFiles = true

    var body: some View {
        @Bindable var appState = appState
        NavigationSplitView(columnVisibility: $columnVisibility) {
            SessionsHomeView(selection: $appState.selectedSessionId)
                .navigationSplitViewColumnWidth(min: 280, ideal: 340, max: 420)
        } content: {
            if let sessionId = appState.selectedSessionId {
                NavigationStack {
                    TimelineView(sessionId: sessionId) { showsFiles.toggle() }
                }
                .navigationSplitViewColumnWidth(min: 360, ideal: 520)
            } else {
                ContentUnavailableView(
                    "세션을 선택하세요",
                    systemImage: "sidebar.left",
                    description: Text("왼쪽 목록에서 세션을 고르면 여기에 타임라인이 열립니다")
                )
            }
        } detail: {
            detail
        }
        .navigationSplitViewStyle(.balanced)
    }

    @ViewBuilder
    private var detail: some View {
        if let sessionId = appState.selectedSessionId {
            if showsFiles, let cwd = cwd(for: sessionId), let model = appState.fileBrowserModel(for: sessionId, cwd: cwd) {
                FileBrowserView(model: model, showsCloseButton: false)
            } else {
                ContentUnavailableView(
                    "파일 브라우저가 닫혀 있습니다",
                    systemImage: "folder",
                    description: Text("타임라인 툴바의 파일 버튼으로 엽니다")
                )
            }
        } else {
            ContentUnavailableView(
                "파일",
                systemImage: "folder",
                description: Text("세션을 선택하면 작업 디렉토리를 볼 수 있습니다")
            )
        }
    }

    private func cwd(for sessionId: String) -> String? {
        store.session(id: sessionId)?.cwd ?? appState.timelineModels[sessionId]?.session?.cwd
    }
}
