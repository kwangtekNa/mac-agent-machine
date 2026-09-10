import SwiftUI

/// 연결 후 첫 화면(IOS.md 4절). 진행 중 → 프로젝트 → 최근 세션 순의 `List` 와 새 세션·설정 진입.
/// 화면이 보이는 동안 `refreshInterval` 마다 `refresh()` 해 승인 대기 배지를 갱신한다(`.task` 가 사라지면 취소).
struct SessionsHomeView: View {
    static let refreshInterval: Duration = .seconds(15)

    @Environment(SessionsStore.self) private var store
    @State private var path = NavigationPath()
    @State private var showsSettings = false
    @State private var showsNewSession = false
    @State private var createdSession: Session?

    var body: some View {
        NavigationStack(path: $path) {
            content
                .navigationTitle("세션")
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button {
                            showsSettings = true
                        } label: {
                            Image(systemName: "gearshape")
                        }
                        .accessibilityLabel("설정 열기")
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            showsNewSession = true
                        } label: {
                            Image(systemName: "plus")
                        }
                        .accessibilityLabel("새 세션")
                    }
                }
                .navigationDestination(for: Project.self) { project in
                    ProjectSessionsView(project: project, path: $path)
                }
                .navigationDestination(for: Session.self) { session in
                    TimelineView(sessionId: session.id)
                }
                .sheet(isPresented: $showsSettings) {
                    SettingsView()
                }
                .sheet(isPresented: $showsNewSession, onDismiss: openCreatedSession) {
                    NewSessionSheet(initialCwd: nil) { createdSession = $0 }
                }
                .task { await refreshPeriodically() }
        }
    }

    @ViewBuilder
    private var content: some View {
        if store.projects.isEmpty, store.sessions.isEmpty {
            if !store.hasLoaded, store.errorMessage == nil {
                ProgressView("세션을 불러오는 중…")
            } else if store.errorMessage != nil {
                List {
                    errorBanner
                    SessionsEmptyView()
                        .listRowBackground(Color.clear)
                }
                .listStyle(.insetGrouped)
                .refreshable { await store.refresh() }
            } else {
                List {}
                    .listStyle(.insetGrouped)
                    .overlay { SessionsEmptyView() }
                    .refreshable { await store.refresh() }
            }
        } else {
            List {
                errorBanner
                if !store.active.isEmpty {
                    Section("지금 진행 중") {
                        ForEach(store.active) { session in
                            row(session)
                        }
                    }
                }
                if !store.projects.isEmpty {
                    Section("프로젝트") {
                        ForEach(store.projects) { project in
                            NavigationLink(value: project) {
                                ProjectRow(project: project)
                            }
                        }
                    }
                }
                Section("최근 세션") {
                    if store.recent.isEmpty {
                        SessionsEmptyView()
                            .listRowBackground(Color.clear)
                    } else {
                        ForEach(store.recent) { session in
                            row(session)
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .refreshable { await store.refresh() }
        }
    }

    @ViewBuilder
    private var errorBanner: some View {
        if let message = store.errorMessage {
            Section {
                ErrorBannerRow(message: message) {
                    Task { await store.refresh() }
                }
            }
        }
    }

    private func row(_ session: Session) -> some View {
        SessionRowView(session: session) {
            Task { await close(session) }
        }
    }

    private func close(_ session: Session) async {
        do {
            try await store.close(session)
        } catch {
            // 닫기 실패는 다음 refresh 가 실제 상태로 되돌린다. 문구만 배너에 남긴다.
            await store.refresh()
        }
    }

    /// 새 세션 시트가 닫힌 뒤 타임라인으로 push 한다(시트 위에서 push 하지 않는다).
    private func openCreatedSession() {
        guard let session = createdSession else { return }
        createdSession = nil
        path.append(session)
    }

    private func refreshPeriodically() async {
        await store.refresh()
        while !Task.isCancelled {
            do {
                try await Task.sleep(for: Self.refreshInterval)
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            await store.refresh()
        }
    }
}

/// 프로젝트 행: 폴더 아이콘, 이름, 경로, git 표시, 세션 수.
private struct ProjectRow: View {
    let project: Project

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "folder")
                .foregroundStyle(.tint)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Text(project.name)
                        .lineLimit(1)
                    if project.isGitRepo {
                        Image(systemName: "arrow.triangle.branch")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .accessibilityLabel("git 저장소")
                    }
                }
                Text(project.path)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.head)
            }
            Spacer(minLength: 0)
            Text("\(project.sessionCount)")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .accessibilityLabel("세션 \(project.sessionCount)개")
        }
    }
}

/// IOS.md 5.5 의 빈 화면 문구.
struct SessionsEmptyView: View {
    var body: some View {
        ContentUnavailableView(
            "아직 세션이 없습니다",
            systemImage: "bubble.left.and.text.bubble.right",
            description: Text("오른쪽 위 + 로 시작하세요")
        )
    }
}

/// 리스트 상단 노란 오류 배너 + "다시 시도".
struct ErrorBannerRow: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.yellow)
            Text(message)
                .font(.subheadline)
            Spacer(minLength: 0)
            Button("다시 시도", action: retry)
                .font(.subheadline)
                .buttonStyle(.borderless)
        }
        .listRowBackground(Color.yellow.opacity(0.18))
    }
}
