import SwiftUI

/// 팀 설정: 이름·설정 편집, 팀원(편집·기억 초기화·제거·추가), 베이스 브랜치·cwd(읽기 전용), 작업 전부 중단, 팀 삭제.
/// 삭제·제거의 409(커밋되지 않은 worktree 변경)는 "worktree 를 남기고" 재시도할지 묻는다. step 5 전까지는 팀 행의 목적지이기도 하다.
/// 섹션·다이얼로그는 타입 검사 시간을 위해 함수 단위로 나눠 둔다.
struct TeamSettingsView: View {
    @Environment(SessionsStore.self) private var store
    @Environment(TeamsStore.self) private var teamsStore
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss

    let teamId: String

    @State private var name = ""
    @State private var settings = TeamSettings.defaults
    @State private var didLoad = false
    @State private var isBusy = false
    @State private var errorMessage: String?
    @State private var editor: EditorTarget?
    @State private var confirmsStop = false
    @State private var confirmsDelete = false
    @State private var asksKeepWorktrees = false
    @State private var memberToRemove: TeamMember?
    @State private var memberToKeepWorktree: TeamMember?

    private enum EditorTarget: Identifiable {
        case add(MemberDraft)
        case edit(MemberDraft)

        var draft: MemberDraft {
            switch self {
            case .add(let draft), .edit(let draft): draft
            }
        }

        var id: UUID { draft.id }
    }

    var body: some View {
        if let team = teamsStore.team(id: teamId) {
            content(team)
        } else {
            ContentUnavailableView(
                "팀을 찾을 수 없습니다",
                systemImage: "person.3",
                description: Text("삭제됐거나 목록을 아직 읽지 못했습니다")
            )
        }
    }

    private func content(_ team: Team) -> some View {
        let base = form(team)
            .navigationTitle(team.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("저장") { Task { await save(team) } }
                        .disabled(!hasChanges(team) || isBusy)
                        .accessibilityIdentifier("teamSettings.save")
                }
            }
            .onAppear { load(team) }
            .sheet(item: $editor) { target in memberEditor(target, team: team) }
        return memberDialogs(teamDialogs(base))
    }

    private func form(_ team: Team) -> some View {
        Form {
            teamSection(team)
            settingsSection
            membersSection(team)
            stopSection
            deleteSection
            errorSection
        }
    }

    // MARK: - 섹션

    private func teamSection(_ team: Team) -> some View {
        Section("팀") {
            TextField("이름", text: $name)
                .accessibilityIdentifier("teamSettings.name")
            LabeledContent("디렉토리") {
                Text(team.cwd)
                    .font(.caption.monospaced())
                    .multilineTextAlignment(.trailing)
            }
            LabeledContent("베이스 브랜치", value: team.baseBranch)
        }
    }

    private var settingsSection: some View {
        Section {
            Stepper("연쇄 상한 \(settings.maxHops)", value: $settings.maxHops, in: TeamSettings.maxHopsRange)
            Stepper("동시 실행 \(settings.maxConcurrent)", value: $settings.maxConcurrent, in: TeamSettings.maxConcurrentRange)
        } header: {
            Text("설정")
        } footer: {
            Text("바꾼 이름과 설정은 오른쪽 위 저장으로 적용됩니다.")
        }
    }

    private func membersSection(_ team: Team) -> some View {
        Section {
            ForEach(team.members) { member in
                memberRow(member)
            }
            Button {
                editor = .add(MemberDraft.defaultDraft(presets: teamsStore.presets))
            } label: {
                Label("팀원 추가", systemImage: "person.badge.plus")
            }
            .disabled(isBusy)
            .accessibilityIdentifier("teamSettings.addMember")
        } header: {
            Text("팀원")
        } footer: {
            Text("행을 밀어 기억 초기화(세션을 새로 열어 지시문·모델 변경을 바로 적용)나 제거를 할 수 있습니다. 팀장은 제거할 수 없습니다.")
        }
    }

    private func memberRow(_ member: TeamMember) -> some View {
        Button {
            editor = .edit(MemberDraft.from(member: member))
        } label: {
            TeamMemberRow(member: member, state: TeamActivity.state(of: member, sessions: store.sessions))
        }
        .buttonStyle(.plain)
        .swipeActions(edge: .trailing) {
            if !member.isLead {
                Button("제거", systemImage: "person.badge.minus", role: .destructive) { memberToRemove = member }
            }
            Button("기억 초기화", systemImage: "arrow.counterclockwise") { Task { await reset(member) } }
                .tint(.orange)
        }
    }

    private var stopSection: some View {
        Section {
            Button("작업 전부 중단", systemImage: "stop.circle", role: .destructive) { confirmsStop = true }
                .disabled(isBusy)
        } footer: {
            Text("실행 중인 팀원 턴을 모두 끊고 대기열을 비웁니다.")
        }
    }

    private var deleteSection: some View {
        Section {
            Button("팀 삭제", systemImage: "trash", role: .destructive) { confirmsDelete = true }
                .disabled(isBusy)
                .accessibilityIdentifier("teamSettings.delete")
        } footer: {
            Text("팀원 세션과 방 대화가 함께 지워집니다. 커밋되지 않은 변경이 있으면 worktree 를 남길지 묻습니다.")
        }
    }

    @ViewBuilder
    private var errorSection: some View {
        if let errorMessage {
            Section {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .accessibilityLabel("오류: \(errorMessage)")
            }
        }
    }

    // MARK: - 시트·다이얼로그

    private func memberEditor(_ target: EditorTarget, team: Team) -> some View {
        MemberEditorView(
            draft: target.draft,
            context: editorContext(target),
            others: team.members.filter { $0.id != target.draft.memberId }.map(MemberDraft.from(member:)),
            availability: availability
        ) { saved in
            Task { await apply(target, saved: saved) }
        }
    }

    /// 중단·삭제·worktree 유지 확인.
    private func teamDialogs<Content: View>(_ content: Content) -> some View {
        content
            .confirmationDialog("실행 중인 팀원 턴을 전부 중단할까요?", isPresented: $confirmsStop, titleVisibility: .visible) {
                Button("작업 전부 중단", role: .destructive) { Task { await stop() } }
            }
            .confirmationDialog("팀을 삭제할까요? 방 대화도 함께 지워집니다.", isPresented: $confirmsDelete, titleVisibility: .visible) {
                Button("팀 삭제", role: .destructive) { Task { await delete(keepWorktrees: false) } }
            }
            .alert("커밋되지 않은 변경이 남아 있습니다", isPresented: $asksKeepWorktrees) {
                Button("worktree 남기고 삭제", role: .destructive) { Task { await delete(keepWorktrees: true) } }
                Button("취소", role: .cancel) {}
            } message: {
                Text(ErrorMessages.teamDirtyWorktree)
            }
    }

    /// 팀원 제거·worktree 유지 확인.
    private func memberDialogs<Content: View>(_ content: Content) -> some View {
        content
            .confirmationDialog(
                "팀원을 제거할까요?", isPresented: isPresent($memberToRemove), titleVisibility: .visible, presenting: memberToRemove
            ) { member in
                Button("\(member.name) 제거", role: .destructive) { Task { await remove(member, keepWorktree: false) } }
            } message: { member in
                Text("\(member.name)의 세션을 닫고 브랜치와 worktree 를 지웁니다.")
            }
            .alert("커밋되지 않은 변경이 남아 있습니다", isPresented: isPresent($memberToKeepWorktree), presenting: memberToKeepWorktree) { member in
                Button("worktree 남기고 제거", role: .destructive) { Task { await remove(member, keepWorktree: true) } }
                Button("취소", role: .cancel) {}
            } message: { _ in
                Text("worktree 를 남기고 팀원만 뺄까요?")
            }
    }

    // MARK: - 상태

    private func load(_ team: Team) {
        guard !didLoad else { return }
        didLoad = true
        name = team.name
        settings = team.settings
    }

    private func hasChanges(_ team: Team) -> Bool {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let nameChanged = !trimmed.isEmpty && trimmed.count <= NewTeamFormState.nameMaxLength && trimmed != team.name
        return nameChanged || settings != team.settings
    }

    private func editorContext(_ target: EditorTarget) -> MemberEditorView.Context {
        switch target {
        case .add: .create
        case .edit(let original): .edit(original: original)
        }
    }

    private var me: MeResponse? {
        if case .connected(let me) = appState.connection { return me }
        return nil
    }

    private func availability(_ kind: AgentKind) -> String? {
        NewSessionSheet.availability(of: kind, me: me)
    }

    private func isPresent<T>(_ value: Binding<T?>) -> Binding<Bool> {
        Binding(get: { value.wrappedValue != nil }, set: { if !$0 { value.wrappedValue = nil } })
    }

    // MARK: - 동작 (확정은 서버 응답 Team)

    private func save(_ team: Team) async {
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            try await teamsStore.patch(
                id: teamId,
                PatchTeamRequest(name: trimmed != team.name ? trimmed : nil, settings: settings != team.settings ? settings : nil)
            )
        } catch {
            errorMessage = ErrorMessages.teamMessage(for: error)
        }
    }

    private func apply(_ target: EditorTarget, saved: MemberDraft) async {
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }
        do {
            switch target {
            case .add:
                try await teamsStore.addMember(teamId: teamId, saved.memberInput())
            case .edit(let original):
                guard let memberId = original.memberId, let request = saved.patchRequest(from: original) else { return }
                try await teamsStore.patchMember(teamId: teamId, memberId: memberId, request)
            }
        } catch {
            errorMessage = ErrorMessages.teamMessage(for: error)
        }
    }

    private func stop() async {
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }
        do {
            _ = try await teamsStore.stop(id: teamId)
            await teamsStore.refresh()
        } catch {
            errorMessage = ErrorMessages.message(for: error)
        }
    }

    private func reset(_ member: TeamMember) async {
        errorMessage = nil
        do {
            try await teamsStore.resetMember(teamId: teamId, memberId: member.id)
        } catch {
            errorMessage = ErrorMessages.message(for: error)
        }
    }

    private func remove(_ member: TeamMember, keepWorktree: Bool) async {
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }
        do {
            try await teamsStore.removeMember(teamId: teamId, memberId: member.id, keepWorktree: keepWorktree)
        } catch let error where !keepWorktree && TeamsStore.isDirtyWorktreeConflict(error) {
            memberToKeepWorktree = member
        } catch {
            errorMessage = ErrorMessages.message(for: error)
        }
    }

    private func delete(keepWorktrees: Bool) async {
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }
        do {
            try await teamsStore.delete(id: teamId, keepWorktrees: keepWorktrees)
            dismiss()
        } catch let error where !keepWorktrees && TeamsStore.isDirtyWorktreeConflict(error) {
            asksKeepWorktrees = true
        } catch {
            errorMessage = ErrorMessages.message(for: error)
        }
    }
}

/// 팀 설정의 팀원 행: 이모지 · 이름(팀장 배지) · 역할 · 에이전트 · 상태, 오른쪽에 상태 점.
struct TeamMemberRow: View {
    let member: TeamMember
    let state: TeamMemberState

    var body: some View {
        HStack(spacing: 10) {
            Text(member.emoji)
                .font(.title3)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(member.name).lineLimit(1)
                    if member.isLead { LeadBadge() }
                }
                Text("\(member.roleLabel) · \(member.agent.shortName) · \(state.label)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            Circle()
                .fill(state.color)
                .frame(width: 10, height: 10)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(member.name), \(member.roleLabel), \(state.label)")
    }
}
