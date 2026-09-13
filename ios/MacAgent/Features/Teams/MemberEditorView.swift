import SwiftUI

/// 역할 피커: 서버 프리셋("기본 프리셋") + 앱 로컬 프리셋("내 프리셋").
struct RolePresetPicker: View {
    enum Choice: Hashable {
        case server(RoleId)
        case local(UUID)
    }

    let presets: [RolePreset]
    let localPresets: [LocalRolePreset]
    @Binding var selection: Choice?

    var body: some View {
        Picker("역할", selection: $selection) {
            Section("기본 프리셋") {
                ForEach(presets) { preset in
                    Text("\(preset.emoji) \(preset.label)").tag(Choice?.some(.server(preset.id)))
                }
            }
            if !localPresets.isEmpty {
                Section("내 프리셋") {
                    ForEach(localPresets) { preset in
                        Text("\(preset.emoji) \(preset.label)").tag(Choice?.some(.local(preset.id)))
                    }
                }
            }
        }
        .pickerStyle(.menu)
        .accessibilityIdentifier("memberEditor.role")
    }
}

/// 팀원 편집기. 새 팀원(`.create`)은 프리셋·에이전트·팀장까지 고르고, 기존 팀원(`.edit`)은 `PATCH` 가 받는 필드만 바꾼다
/// (역할·에이전트·팀장은 고정). 모드는 `ask / auto-edit / plan` 뿐이다(`full-auto` 없음).
struct MemberEditorView: View {
    enum Context: Equatable {
        case create
        case edit(original: MemberDraft)
    }

    @Environment(TeamsStore.self) private var teamsStore
    @Environment(RolePresetStore.self) private var presetStore
    @Environment(\.dismiss) private var dismiss

    let context: Context
    /// 중복 이름 검사 대상(자기 자신 제외).
    let others: [MemberDraft]
    /// 에이전트를 쓸 수 없는 이유. nil 이면 사용 가능(`NewSessionSheet.availability(of:me:)`).
    let availability: (AgentKind) -> String?
    let onSave: (MemberDraft) -> Void

    @State private var draft: MemberDraft
    @State private var savedPreset = false

    init(
        draft: MemberDraft,
        context: Context,
        others: [MemberDraft],
        availability: @escaping (AgentKind) -> String?,
        onSave: @escaping (MemberDraft) -> Void
    ) {
        _draft = State(initialValue: draft)
        self.context = context
        self.others = others
        self.availability = availability
        self.onSave = onSave
    }

    private var original: MemberDraft? {
        if case .edit(let original) = context { return original }
        return nil
    }

    private var isEditing: Bool { original != nil }

    /// 기존 팀원은 에이전트를 바꿀 수 없으므로 지금 쓸 수 없어도 막지 않는다.
    private var availableAgents: Set<AgentKind> {
        var set = Set([AgentKind.claude, .codex].filter { availability($0) == nil })
        if isEditing { set.insert(draft.agent) }
        return set
    }

    private var errors: [MemberDraft.ValidationError] {
        draft.validate(existing: others, availableAgents: availableAgents)
    }

    var body: some View {
        NavigationStack {
            Form {
                roleSection
                memberSection
                promptSection
                if !isEditing {
                    Section {
                        Toggle("팀장", isOn: $draft.isLead)
                            .accessibilityIdentifier("memberEditor.lead")
                    } footer: {
                        Text("멘션이 없는 메시지를 받는 팀원입니다. 팀에 한 명만 있습니다.")
                    }
                }
                if draft.isCustom {
                    presetSaveSection
                }
                if !errors.isEmpty {
                    Section {
                        ForEach(errors, id: \.self) { error in
                            Text(error.message)
                                .font(.caption)
                                .foregroundStyle(.red)
                        }
                    }
                }
            }
            .navigationTitle(isEditing ? "팀원 편집" : "팀원 추가")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("완료") {
                        onSave(draft)
                        dismiss()
                    }
                    .disabled(!errors.isEmpty)
                    .accessibilityIdentifier("memberEditor.save")
                }
            }
        }
    }

    // MARK: - 섹션

    @ViewBuilder
    private var roleSection: some View {
        if isEditing {
            Section("역할") {
                LabeledContent("역할", value: draft.roleLabel)
                LabeledContent("에이전트", value: draft.agent.displayName)
            }
        } else {
            Section("역할") {
                if teamsStore.presets.isEmpty, presetStore.presets.isEmpty {
                    Text("역할 프리셋을 아직 불러오지 못했습니다. 기본 개발자 역할로 만듭니다.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    RolePresetPicker(presets: teamsStore.presets, localPresets: presetStore.presets, selection: presetSelection)
                }
                if draft.isCustom {
                    TextField("역할 이름", text: $draft.roleLabel)
                        .accessibilityIdentifier("memberEditor.roleLabel")
                }
            }
        }
    }

    private var memberSection: some View {
        Section("팀원") {
            TextField("이름 (@멘션에 쓰입니다)", text: $draft.name)
                .textInputAutocapitalization(.never)
                .accessibilityIdentifier("memberEditor.name")
            TextField("이모지 한 글자", text: $draft.emoji)
                .accessibilityIdentifier("memberEditor.emoji")
            if !isEditing {
                Picker("에이전트", selection: $draft.agent) {
                    ForEach([AgentKind.claude, .codex]) { kind in
                        Text(kind.displayName).tag(kind)
                    }
                }
                .pickerStyle(.segmented)
                if let reason = availability(draft.agent) {
                    Label(reason, systemImage: "exclamationmark.circle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Picker("모드", selection: $draft.mode) {
                ForEach(MemberDraft.selectableModes, id: \.self) { mode in
                    Text(mode.rawValue).tag(mode)
                }
            }
            .accessibilityIdentifier("memberEditor.mode")
        }
    }

    private var promptSection: some View {
        Section {
            TextEditor(text: $draft.prompt)
                .font(.body)
                .frame(minHeight: 120)
                .accessibilityIdentifier("memberEditor.prompt")
        } header: {
            Text("지시문")
        } footer: {
            if let original, draft.appliesNextSession(from: original) {
                Text("다음 세션부터 적용됩니다(기억 초기화로 바로 적용)")
            } else {
                Text("역할 지시문입니다. 서버가 팀 규칙을 덧붙여 세션에 넘깁니다.")
            }
        }
    }

    private var presetSaveSection: some View {
        Section {
            Button {
                let preset = draft.localPreset()
                presetStore.save(preset)
                draft.localPresetId = preset.id
                savedPreset = true
            } label: {
                Label("프리셋으로 저장", systemImage: "square.and.arrow.down")
            }
            .disabled(draft.trimmedRoleLabel.isEmpty)
            .accessibilityIdentifier("memberEditor.savePreset")
            if savedPreset {
                Text("내 프리셋에 저장했습니다. 다음 팀을 만들 때 고를 수 있습니다.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - 상태

    private var presetSelection: Binding<RolePresetPicker.Choice?> {
        Binding(
            get: { draft.localPresetId.map { RolePresetPicker.Choice.local($0) } ?? .server(draft.role) },
            set: { choice in
                switch choice {
                case .server(let id)?:
                    if let preset = teamsStore.presets.first(where: { $0.id == id }) { draft.apply(preset: preset) }
                case .local(let id)?:
                    if let preset = presetStore.preset(id: id) { draft.apply(localPreset: preset) }
                case nil:
                    break
                }
            }
        )
    }
}
