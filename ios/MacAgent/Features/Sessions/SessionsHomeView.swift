import SwiftUI

/// 연결 후 첫 화면(IOS.md 4절). 진행 중 → 팀 → 프로젝트 → 최근 세션 순의 `List` 와 새 세션·새 팀(`+` 메뉴)·설정 진입.
/// 팀 행의 목적지는 step 5(방 목록) 전까지 `TeamSettingsView` 다.
/// 화면이 보이는 동안 `refreshInterval` 마다 `refresh()` 해 승인 대기 배지를 갱신한다(`.task` 가 사라지면 취소).
struct SessionsHomeView: View {
    static let refreshInterval: Duration = .seconds(15)

    /// iPad 사이드바 모드(`SplitRootView`): 값이 있으면 세션 행이 push 대신 이 선택을 바꾼다.
    var selection: Binding<String?>?

    init(selection: Binding<String?>? = nil) {
        self.selection = selection
    }

    @Environment(SessionsStore.self) private var store
    @Environment(TeamsStore.self) private var teamsStore
    @State private var path = NavigationPath()
    @State private var showsSettings = false
    @State private var showsNewSession = false
    @State private var createdSession: Session?
    @State private var showsNewTeam = false
    @State private var createdTeam: Team?

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
                        // `+` 는 메뉴다. 메뉴 항목 "새 세션"이 기존 새 세션 진입(UI 테스트가 `home.add` → "새 세션" 순으로 누른다).
                        Menu {
                            Button {
                                showsNewSession = true
                            } label: {
                                Label("새 세션", systemImage: "bubble.left.and.text.bubble.right")
                            }
                            .accessibilityIdentifier("home.newSession")
                            Button {
                                showsNewTeam = true
                            } label: {
                                Label("새 팀", systemImage: "person.3")
                            }
                            .accessibilityIdentifier("home.newTeam")
                        } label: {
                            Image(systemName: "plus")
                        }
                        .accessibilityLabel("추가")
                        .accessibilityIdentifier("home.add")
                    }
                }
                .navigationDestination(for: Project.self) { project in
                    ProjectSessionsView(project: project, path: $path, onSelect: selectHandler)
                }
                .navigationDestination(for: Session.self) { session in
                    TimelineView(sessionId: session.id)
                }
                .navigationDestination(for: Team.self) { team in
                    TeamSettingsView(teamId: team.id)
                }
                .sheet(isPresented: $showsSettings) {
                    SettingsView()
                }
                .sheet(isPresented: $showsNewSession, onDismiss: openCreatedSession) {
                    NewSessionSheet(initialCwd: nil) { createdSession = $0 }
                }
                .sheet(isPresented: $showsNewTeam, onDismiss: openCreatedTeam) {
                    NewTeamSheet(initialCwd: nil) { createdTeam = $0 }
                }
                .task { await refreshPeriodically() }
        }
    }

    @ViewBuilder
    private var content: some View {
        if store.projects.isEmpty, store.sessions.isEmpty, teamsStore.teams.isEmpty {
            if !store.hasLoaded, store.errorMessage == nil {
                ProgressView("세션을 불러오는 중…")
            } else if store.errorMessage != nil {
                List {
                    errorBanner
                    SessionsEmptyView()
                        .listRowBackground(Color.clear)
                }
                .listStyle(.insetGrouped)
                .refreshable { await refreshAll() }
            } else {
                List {}
                    .listStyle(.insetGrouped)
                    .overlay { SessionsEmptyView() }
                    .refreshable { await refreshAll() }
            }
        } else {
            List {
                errorBanner
                approvalSummary
                if !store.active.isEmpty {
                    Section("지금 진행 중") {
                        ForEach(store.active) { session in
                            row(session)
                        }
                    }
                }
                teamsSection
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
            .refreshable { await refreshAll() }
        }
    }

    /// "팀" 섹션(프로젝트 위). 팀이 없으면 행동 유도 문구(IOS.md 5.5).
    @ViewBuilder
    private var teamsSection: some View {
        Section("팀") {
            if teamsStore.teams.isEmpty {
                Text("아직 팀이 없습니다. + 에서 새 팀을 만드세요.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(teamsStore.teams) { team in
                    NavigationLink(value: team) {
                        TeamRow(team: team, activity: .of(team: team, sessions: store.sessions))
                    }
                }
            }
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

    /// 승인 대기가 있으면 맨 위에 노란 요약 행. 탭하면 가장 오래 기다린 세션으로 이동한다(푸시는 Phase 3).
    @ViewBuilder
    private var approvalSummary: some View {
        if store.pendingApprovalTotal > 0, let target = store.oldestWaitingSession {
            Section {
                Button {
                    open(target)
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "hand.raised.fill")
                            .foregroundStyle(.yellow)
                        Text("승인 대기 \(store.pendingApprovalTotal)건 · 탭하여 이동")
                            .font(.subheadline.weight(.semibold))
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .foregroundStyle(.primary)
                .listRowBackground(Color.yellow.opacity(0.18))
                .accessibilityLabel("승인 대기 \(store.pendingApprovalTotal)건, 탭하여 이동")
            }
        }
    }

    private func row(_ session: Session) -> some View {
        SessionRowView(
            session: session,
            onClose: { Task { await close(session) } },
            onSelect: selectHandler,
            isSelected: selection?.wrappedValue == session.id,
            teamBadge: TeamsStore.badge(for: session, teams: teamsStore.teams)
        )
    }

    /// 사이드바 모드에서만 행에 넘기는 선택 콜백.
    private var selectHandler: ((Session) -> Void)? {
        guard selection != nil else { return nil }
        return { session in open(session) }
    }

    /// compact 는 push, iPad 사이드바는 선택.
    private func open(_ session: Session) {
        if let selection {
            selection.wrappedValue = session.id
        } else {
            path.append(session)
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
        open(session)
    }

    /// 새 팀 시트가 닫힌 뒤 팀 화면으로 push 한다.
    private func openCreatedTeam() {
        guard let team = createdTeam else { return }
        createdTeam = nil
        path.append(team)
    }

    /// 세션·프로젝트와 팀을 함께 새로고침한다.
    private func refreshAll() async {
        await store.refresh()
        await teamsStore.refresh()
    }

    private func refreshPeriodically() async {
        await refreshAll()
        while !Task.isCancelled {
            do {
                try await Task.sleep(for: Self.refreshInterval)
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            await refreshAll()
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
