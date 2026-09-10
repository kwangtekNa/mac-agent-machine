import SwiftUI

/// 프로젝트 하나의 세션 목록. `+` 는 이 프로젝트의 cwd 가 채워진 새 세션 시트를 연다.
struct ProjectSessionsView: View {
    @Environment(SessionsStore.self) private var store
    let project: Project
    @Binding var path: NavigationPath
    @State private var showsNewSession = false
    @State private var createdSession: Session?

    var body: some View {
        List {
            if let message = store.errorMessage {
                Section {
                    ErrorBannerRow(message: message) {
                        Task { await store.refresh() }
                    }
                }
            }
            let sessions = store.sessions(inProject: project.path)
            if sessions.isEmpty {
                SessionsEmptyView()
                    .listRowBackground(Color.clear)
            } else {
                Section {
                    ForEach(sessions) { session in
                        SessionRowView(session: session) {
                            Task { await close(session) }
                        }
                    }
                } header: {
                    Text(project.path)
                        .textCase(nil)
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(project.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showsNewSession = true
                } label: {
                    Image(systemName: "plus")
                }
                .accessibilityLabel("이 프로젝트에서 새 세션")
            }
        }
        .sheet(isPresented: $showsNewSession, onDismiss: openCreatedSession) {
            NewSessionSheet(initialCwd: project.path) { createdSession = $0 }
        }
        .refreshable { await store.refresh() }
    }

    private func close(_ session: Session) async {
        do {
            try await store.close(session)
        } catch {
            await store.refresh()
        }
    }

    private func openCreatedSession() {
        guard let session = createdSession else { return }
        createdSession = nil
        path.append(session)
    }
}
