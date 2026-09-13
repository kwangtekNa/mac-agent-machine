import SwiftUI

/// 새 팀 시트: 템플릿(있을 때) → 이름 → 디렉토리(새 세션과 같은 `DirectoryFormSection`) → 팀원 → 고급 설정 → "팀 만들기".
/// 성공하면 `onCreated` 로 팀을 넘기고 닫는다. push 는 시트가 닫힌 뒤 부모가 한다. 버튼 규칙은 전부 `NewTeamFormState` 에 있다.
struct NewTeamSheet: View {
    @Environment(AppState.self) private var appState
    @Environment(SessionsStore.self) private var store
    @Environment(TeamsStore.self) private var teamsStore
    @Environment(\.dismiss) private var dismiss

    let initialCwd: String?
    let onCreated: (Team) -> Void

    @State private var form = NewTeamFormState()
    @State private var showsPicker = false
    @State private var editingMember: MemberDraft?
    @State private var showsAdvanced = false
    @State private var isSubmitting = false
    @State private var errorMessage: String?
    @State private var didPrepare = false
    /// 선택한 디렉토리의 저장소 확인·초기화 흐름(PROTOCOL.md `POST /git/init`). 클라이언트가 준비되면 `prepare()` 가 만든다.
    @State private var gitInit: GitInitModel?

    var body: some View {
        NavigationStack {
            Form {
                templateSection
                Section("이름") {
                    TextField("팀 이름", text: $form.name)
                        .submitLabel(.done)
                        .accessibilityIdentifier("newTeam.name")
                }
                DirectoryFormSection(form: $form.directory, projects: store.projects, identifierPrefix: "newTeam") {
                    showsPicker = true
                }
                gitSection
                membersSection
                advancedSection
                submitSection
            }
            .navigationTitle("새 팀")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                        .disabled(isSubmitting)
                }
            }
            .interactiveDismissDisabled(isSubmitting)
            .confirmationDialog(
                "git 저장소를 만들까요?", isPresented: gitInitConfirmPresented, titleVisibility: .visible, presenting: gitPhase.preview
            ) { _ in
                Button("초기화") { Task { await gitInit?.confirm(cwd: form.directory.selectedPath) } }
                Button("취소", role: .cancel) { gitInit?.cancelPreview() }
            } message: { preview in
                Text(GitInitFlow.confirmMessage(preview))
            }
            // 디렉토리를 고르거나 직접 입력이 멈추면 저장소 여부를 확인한다. 직접 입력은 타이핑이 끝날 때까지 잠시 기다린다.
            .task(id: form.directory.selectedPath) {
                let cwd = form.directory.selectedPath
                if form.directory.showsCustomInput, !cwd.isEmpty {
                    try? await Task.sleep(for: .milliseconds(600))
                    if Task.isCancelled { return }
                }
                await gitInit?.check(cwd: cwd)
            }
        }
        .sheet(isPresented: $showsPicker) {
            if let client = appState.client {
                DirectoryPickerView(client: client, initialPath: form.directory.browseStartPath(in: store.projects)) { path in
                    form.directory.pick(path)
                }
            }
        }
        .sheet(item: $editingMember) { draft in
            MemberEditorView(
                draft: draft, context: .create, others: form.members.filter { $0.id != draft.id }, availability: availability
            ) { saved in
                form.upsert(saved)
            }
        }
        .onAppear(perform: prepare)
    }

    // MARK: - 섹션

    @ViewBuilder
    private var templateSection: some View {
        if !teamsStore.templates.isEmpty {
            Section("템플릿") {
                Picker("템플릿에서 시작", selection: templateSelection) {
                    Text("선택 안 함").tag(String?.none)
                    ForEach(teamsStore.templates) { template in
                        Text(template.name).tag(String?.some(template.id))
                    }
                }
                .pickerStyle(.menu)
                .accessibilityIdentifier("newTeam.template")
            }
        }
    }

    /// 디렉토리 행 아래: 저장소가 아니면 경고 + "저장소 초기화", 초기화가 끝나면 "git 저장소 (main)" 캡션, 실패면 문구 + 다시 시도.
    @ViewBuilder
    private var gitSection: some View {
        if let gitInit, !form.directory.selectedPath.isEmpty {
            switch gitInit.flow.phase {
            case .idle, .checking:
                EmptyView()
            case .notRepo, .previewing, .confirming, .initializing:
                Section {
                    Label("git 저장소가 아닙니다", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                    gitInitButton(gitInit)
                } footer: {
                    Text("팀원은 이 저장소의 브랜치에서 일합니다. 초기화하면 기존 파일이 첫 커밋에 담깁니다.")
                }
            case .done(let result):
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Label("git 저장소 (\(result.branch))", systemImage: "checkmark.circle")
                            .foregroundStyle(.green)
                        Text(GitInitFlow.doneMessage(result))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .accessibilityIdentifier("newTeam.gitReady")
                }
            case .failed(let message):
                Section {
                    Label(message, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                        .accessibilityLabel("오류: \(message)")
                    gitInitButton(gitInit)
                }
            }
        }
    }

    private func gitInitButton(_ gitInit: GitInitModel) -> some View {
        Button {
            Task { await gitInit.preview(cwd: form.directory.selectedPath) }
        } label: {
            HStack {
                Label("저장소 초기화", systemImage: "arrow.triangle.branch")
                if gitInit.flow.phase.isBusy {
                    Spacer()
                    ProgressView()
                }
            }
        }
        .disabled(gitInit.flow.phase.isBusy || isSubmitting)
        .accessibilityIdentifier("newTeam.gitInit")
    }

    private var membersSection: some View {
        Section {
            ForEach(form.members) { member in
                Button {
                    editingMember = member
                } label: {
                    MemberDraftRow(draft: member, errors: memberErrors[member.id] ?? [])
                }
                .buttonStyle(.plain)
                .swipeActions(edge: .trailing) {
                    Button("삭제", systemImage: "trash", role: .destructive) { form.remove(id: member.id) }
                    if !member.isLead {
                        Button("팀장으로", systemImage: "star") { form.setLead(id: member.id) }
                            .tint(.indigo)
                    }
                }
            }
            Button {
                editingMember = MemberDraft.defaultDraft(presets: teamsStore.presets)
            } label: {
                Label("팀원 추가", systemImage: "person.badge.plus")
            }
            .accessibilityIdentifier("newTeam.addMember")
        } header: {
            Text("팀원")
        } footer: {
            Text("팀장은 정확히 한 명입니다. 멘션이 없는 메시지는 팀장에게 갑니다. 행을 밀어 팀장을 바꾸거나 삭제합니다.")
        }
    }

    private var advancedSection: some View {
        Section {
            DisclosureGroup("고급 설정", isExpanded: $showsAdvanced) {
                Stepper("연쇄 상한 \(form.settings.maxHops)", value: $form.settings.maxHops, in: TeamSettings.maxHopsRange)
                Stepper("동시 실행 \(form.settings.maxConcurrent)", value: $form.settings.maxConcurrent, in: TeamSettings.maxConcurrentRange)
            }
        } footer: {
            Text("연쇄 상한은 메시지 한 건에서 팀원끼리 이어 부르는 횟수, 동시 실행은 한 번에 일하는 팀원 수입니다.")
        }
    }

    private var submitSection: some View {
        Section {
            Button {
                Task { await submit() }
            } label: {
                HStack {
                    Text("팀 만들기")
                    if isSubmitting {
                        Spacer()
                        ProgressView()
                    }
                }
            }
            .disabled(!canSubmit)
            .accessibilityIdentifier("newTeam.submit")
            if !isSubmitting, let reason = form.blockingReason(availableAgents: availableAgents, gitPhase: gitPhase) {
                Text(reason)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let errorMessage {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .accessibilityLabel("오류: \(errorMessage)")
            }
        }
    }

    // MARK: - 상태

    private var templateSelection: Binding<String?> {
        Binding(
            get: { form.templateId },
            set: { id in
                if let id, let template = teamsStore.templates.first(where: { $0.id == id }) {
                    form.apply(template: template)
                } else {
                    form.clearTemplate()
                }
            }
        )
    }

    private var memberErrors: [UUID: [MemberDraft.ValidationError]] {
        form.memberErrors(availableAgents: availableAgents)
    }

    private var me: MeResponse? {
        if case .connected(let me) = appState.connection { return me }
        return nil
    }

    private func availability(_ kind: AgentKind) -> String? {
        NewSessionSheet.availability(of: kind, me: me)
    }

    private var availableAgents: Set<AgentKind> {
        Set([AgentKind.claude, .codex].filter { availability($0) == nil })
    }

    private var gitPhase: GitInitFlow.Phase {
        gitInit?.flow.phase ?? .idle
    }

    private var gitInitConfirmPresented: Binding<Bool> {
        Binding(get: { gitPhase.preview != nil }, set: { if !$0 { gitInit?.cancelPreview() } })
    }

    private var canSubmit: Bool {
        form.canSubmit(availableAgents: availableAgents, gitPhase: gitPhase, isSubmitting: isSubmitting)
    }

    private func prepare() {
        guard !didPrepare else { return }
        didPrepare = true
        if let client = appState.client { gitInit = GitInitModel(client: client) }
        form = .initial(initialCwd: initialCwd, projects: store.projects)
    }

    private func submit() async {
        guard canSubmit else { return }
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }
        do {
            let team = try await teamsStore.create(form.request())
            onCreated(team)
            dismiss()
        } catch {
            errorMessage = ErrorMessages.teamMessage(for: error)
            // 확인을 건너뛰었거나 그 사이 바뀐 경우: 서버가 "git 저장소가 아니다" 라면 같은 행·버튼을 보여준다.
            if errorMessage == ErrorMessages.teamNotGitRepo, let gitInit {
                await gitInit.check(cwd: form.directory.selectedPath)
                if gitInit.flow.phase == .notRepo { errorMessage = nil }
            }
        }
    }
}

/// 새 팀 시트의 팀원 행: 이모지 · 이름(팀장 배지) · 역할 · 에이전트 · 모드, 검증 오류가 있으면 첫 줄만 빨갛게.
struct MemberDraftRow: View {
    let draft: MemberDraft
    var errors: [MemberDraft.ValidationError] = []

    var body: some View {
        HStack(spacing: 10) {
            Text(draft.emoji.isEmpty ? "❔" : draft.emoji)
                .font(.title3)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(draft.trimmedName.isEmpty ? String(localized: "이름 없음") : draft.trimmedName)
                        .lineLimit(1)
                    if draft.isLead { LeadBadge() }
                }
                Text("\(draft.roleLabel) · \(draft.agent.shortName) · \(draft.mode.rawValue)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if let first = errors.first {
                    Text(first.message)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
    }
}

/// "팀장" 캡슐.
struct LeadBadge: View {
    var body: some View {
        Text("팀장")
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Color.indigo.opacity(0.18), in: Capsule())
    }
}
