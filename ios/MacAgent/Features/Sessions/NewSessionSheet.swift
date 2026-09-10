import SwiftUI

/// 새 세션 시트의 디렉토리 선택 상태(IOS.md 9.2). 세 진입점(프로젝트 메뉴 · 찾아보기 · 직접 입력)이 하나의 `selectedPath` 를 갱신한다.
struct NewSessionFormState: Equatable, Sendable {
    /// 세션 cwd 로 보낼 경로. 비어 있으면 제출할 수 없다.
    var selectedPath = ""
    /// 직접 입력 필드의 원문(다듬기 전).
    var customPath = ""
    var showsCustomInput = false

    /// 첫 표시: 미리 채워진 cwd 가 프로젝트면 선택, 아니면 직접 입력. cwd 가 없으면 첫 프로젝트, 프로젝트도 없으면 입력 필드를 연다.
    static func initial(initialCwd: String?, projects: [Project]) -> NewSessionFormState {
        var form = NewSessionFormState()
        if let initialCwd {
            if projects.contains(where: { $0.path == initialCwd }) {
                form.chooseProject(initialCwd)
            } else {
                form.showsCustomInput = true
                form.setCustomPath(initialCwd)
            }
        } else if let first = projects.first {
            form.chooseProject(first.path)
        } else {
            form.showsCustomInput = true
        }
        return form
    }

    /// 프로젝트 메뉴에서 선택. 직접 입력은 닫힌다.
    mutating func chooseProject(_ path: String) {
        selectedPath = path
        customPath = path
        showsCustomInput = false
    }

    /// 찾아보기(`DirectoryPickerView`)에서 선택.
    mutating func pick(_ path: String) {
        chooseProject(path)
    }

    /// 직접 입력 열기/닫기. 열 때는 현재 선택 경로에서 시작한다. 닫아도 선택은 남는다.
    mutating func toggleCustomInput() {
        showsCustomInput.toggle()
        if showsCustomInput { customPath = selectedPath }
    }

    mutating func setCustomPath(_ text: String) {
        customPath = text
        selectedPath = text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// 선택 경로가 프로젝트 목록에 있으면 그 경로(메뉴의 현재 값), 아니면 nil.
    func selectedProjectPath(in projects: [Project]) -> String? {
        projects.first { $0.path == selectedPath }?.path
    }

    /// 찾아보기 시작 경로: 선택된 프로젝트 경로 또는 홈.
    func browseStartPath(in projects: [Project]) -> String {
        selectedProjectPath(in: projects) ?? DirectoryPickerView.homePath
    }

    func canSubmit(agentAvailable: Bool, isSubmitting: Bool) -> Bool {
        !isSubmitting && agentAvailable && !selectedPath.isEmpty
    }
}

/// 새 세션 시트: 에이전트 · 디렉토리 · 모드 · 제목. `full-auto` 는 여기 없다(ADR-015, 타임라인의 모드 메뉴에서만).
/// 성공하면 `onCreated` 로 세션을 넘기고 닫는다. push 는 시트가 닫힌 뒤 부모가 한다.
struct NewSessionSheet: View {
    @Environment(AppState.self) private var appState
    @Environment(SessionsStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    let initialCwd: String?
    let onCreated: (Session) -> Void

    @State private var agent: AgentKind = .claude
    @State private var form = NewSessionFormState()
    @State private var showsPicker = false
    @State private var mode: SessionMode = .ask
    @State private var title = ""
    @State private var isSubmitting = false
    @State private var errorMessage: String?
    @State private var didPrepare = false

    /// 새 세션 시트에서 고를 수 있는 모드. `full-auto` 제외.
    static let selectableModes: [SessionMode] = [.ask, .autoEdit, .plan]

    var body: some View {
        NavigationStack {
            Form {
                agentSection
                directorySection
                modeSection
                Section("제목") {
                    TextField("제목 (선택)", text: $title)
                        .submitLabel(.done)
                }
                Section {
                    Button {
                        Task { await submit() }
                    } label: {
                        HStack {
                            Text("세션 시작")
                            if isSubmitting {
                                Spacer()
                                ProgressView()
                            }
                        }
                    }
                    .disabled(!canSubmit)
                    if let errorMessage {
                        Text(errorMessage)
                            .font(.caption)
                            .foregroundStyle(.red)
                            .accessibilityLabel("오류: \(errorMessage)")
                    }
                }
            }
            .navigationTitle("새 세션")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                        .disabled(isSubmitting)
                }
            }
            .interactiveDismissDisabled(isSubmitting)
        }
        .sheet(isPresented: $showsPicker) {
            if let client = appState.client {
                DirectoryPickerView(client: client, initialPath: form.browseStartPath(in: store.projects)) { path in
                    form.pick(path)
                }
            }
        }
        .onAppear(perform: prepare)
    }

    // MARK: - 섹션

    private var agentSection: some View {
        Section {
            Picker("에이전트", selection: $agent) {
                ForEach([AgentKind.claude, .codex]) { kind in
                    Text(kind.displayName)
                        .tag(kind)
                        .disabled(availability(of: kind) != nil)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            if let reason = availability(of: agent) {
                Label(reason, systemImage: "exclamationmark.circle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("에이전트")
        }
    }

    /// 디렉토리(IOS.md 9.2): 선택 경로 표시 행 + 세 진입점(프로젝트 메뉴 · 찾아보기 · 직접 입력).
    private var directorySection: some View {
        Section("디렉토리") {
            LabeledContent("선택한 경로") {
                if form.selectedPath.isEmpty {
                    Text("선택 안 됨").foregroundStyle(.secondary)
                } else {
                    Text(form.selectedPath)
                        .font(.caption.monospaced())
                        .lineLimit(2)
                        .truncationMode(.head)
                        .multilineTextAlignment(.trailing)
                }
            }
            .accessibilityIdentifier("newSession.selectedPath")
            Picker("프로젝트에서 선택", selection: projectSelection) {
                Text("선택").tag(String?.none)
                ForEach(store.projects) { project in
                    Text(project.name).tag(String?.some(project.path))
                }
            }
            .pickerStyle(.menu)
            .disabled(store.projects.isEmpty)
            .accessibilityIdentifier("newSession.directory")
            Button {
                showsPicker = true
            } label: {
                Label("찾아보기…", systemImage: "folder")
            }
            .accessibilityIdentifier("newSession.browse")
            Button {
                form.toggleCustomInput()
            } label: {
                Label(form.showsCustomInput ? "직접 입력 닫기" : "직접 입력", systemImage: "keyboard")
            }
            .accessibilityIdentifier("newSession.customToggle")
            if form.showsCustomInput {
                TextField("~/work/my-app", text: customPathBinding)
                    .accessibilityIdentifier("newSession.customPath")
                    .font(.body.monospaced())
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.done)
                    .accessibilityLabel("디렉토리 경로")
            }
        }
    }

    private var modeSection: some View {
        Section("모드") {
            Picker("모드", selection: $mode) {
                ForEach(Self.selectableModes, id: \.self) { mode in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(mode.rawValue)
                        Text(mode.summary)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .tag(mode)
                }
            }
            .pickerStyle(.inline)
            .labelsHidden()
        }
    }

    // MARK: - 상태

    private var projectSelection: Binding<String?> {
        Binding(
            get: { form.selectedProjectPath(in: store.projects) },
            set: { path in
                if let path { form.chooseProject(path) }
            }
        )
    }

    private var customPathBinding: Binding<String> {
        Binding(get: { form.customPath }, set: { form.setCustomPath($0) })
    }

    private var me: MeResponse? {
        if case .connected(let me) = appState.connection { return me }
        return nil
    }

    /// 쓸 수 없는 이유. nil 이면 사용 가능.
    private func availability(of kind: AgentKind) -> String? {
        guard let info = me?.agents.first(where: { $0.kind == kind }), info.available else {
            return String(localized: "설치되지 않음")
        }
        return info.loggedIn ? nil : String(localized: "로그인 필요")
    }

    private var canSubmit: Bool {
        form.canSubmit(agentAvailable: availability(of: agent) == nil, isSubmitting: isSubmitting)
    }

    /// 첫 표시: 사용 가능한 에이전트와 디렉토리 초기 상태.
    private func prepare() {
        guard !didPrepare else { return }
        didPrepare = true
        if let usable = [AgentKind.claude, .codex].first(where: { availability(of: $0) == nil }) {
            agent = usable
        }
        form = .initial(initialCwd: initialCwd, projects: store.projects)
    }

    private func submit() async {
        guard canSubmit else { return }
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let session = try await store.create(
                agent: agent, cwd: form.selectedPath, title: trimmedTitle.isEmpty ? nil : trimmedTitle, mode: mode
            )
            onCreated(session)
            dismiss()
        } catch {
            errorMessage = ErrorMessages.sessionCreateMessage(for: error, agent: agent)
        }
    }
}

extension SessionMode {
    /// 새 세션 시트의 한 줄 설명.
    var summary: String {
        switch self {
        case .ask: return String(localized: "명령 실행과 파일 변경 전에 묻습니다")
        case .autoEdit: return String(localized: "파일 변경은 바로 적용하고 명령 실행만 묻습니다")
        case .plan: return String(localized: "읽고 계획만 세웁니다. 파일을 바꾸지 않습니다")
        case .fullAuto: return String(localized: "확인 없이 명령을 실행하고 파일을 수정합니다")
        case .unknown: return ""
        }
    }
}
