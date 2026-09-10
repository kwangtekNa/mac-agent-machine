import SwiftUI

/// 새 세션 시트: 에이전트 · 디렉토리 · 모드 · 제목. `full-auto` 는 여기 없다(ADR-015, 타임라인의 모드 메뉴에서만).
/// 성공하면 `onCreated` 로 세션을 넘기고 닫는다. push 는 시트가 닫힌 뒤 부모가 한다.
struct NewSessionSheet: View {
    @Environment(AppState.self) private var appState
    @Environment(SessionsStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    let initialCwd: String?
    let onCreated: (Session) -> Void

    @State private var agent: AgentKind = .claude
    @State private var directory: DirectoryChoice = .custom
    @State private var customPath = ""
    @State private var mode: SessionMode = .ask
    @State private var title = ""
    @State private var isSubmitting = false
    @State private var errorMessage: String?
    @State private var didPrepare = false

    /// 프로젝트 목록에서 고르거나 직접 입력한다. 파일 브라우저는 step 7.
    enum DirectoryChoice: Hashable {
        case project(String)
        case custom
    }

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

    private var directorySection: some View {
        Section("디렉토리") {
            Picker("프로젝트", selection: $directory) {
                ForEach(store.projects) { project in
                    Text(project.name).tag(DirectoryChoice.project(project.path))
                }
                Text("다른 경로").tag(DirectoryChoice.custom)
            }
            if case .project(let path) = directory {
                Text(path)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.head)
            } else {
                TextField("~/work/my-app", text: $customPath)
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

    private var resolvedCwd: String {
        switch directory {
        case .project(let path): return path
        case .custom: return customPath.trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }

    private var canSubmit: Bool {
        !isSubmitting && availability(of: agent) == nil && !resolvedCwd.isEmpty
    }

    /// 첫 표시: 사용 가능한 에이전트, 미리 채워진 cwd(프로젝트면 선택, 아니면 직접 입력) 로 초기화한다.
    private func prepare() {
        guard !didPrepare else { return }
        didPrepare = true
        if let usable = [AgentKind.claude, .codex].first(where: { availability(of: $0) == nil }) {
            agent = usable
        }
        if let initialCwd {
            if store.projects.contains(where: { $0.path == initialCwd }) {
                directory = .project(initialCwd)
            } else {
                directory = .custom
                customPath = initialCwd
            }
        } else if let first = store.projects.first {
            directory = .project(first.path)
        } else {
            directory = .custom
        }
    }

    private func submit() async {
        guard canSubmit else { return }
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let session = try await store.create(
                agent: agent, cwd: resolvedCwd, title: trimmedTitle.isEmpty ? nil : trimmedTitle, mode: mode
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
