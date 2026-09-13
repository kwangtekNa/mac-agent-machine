import SwiftUI

/// 방의 팀원 시트(IOS.md 10.2)의 표시·요청 규칙. 모델·사고 수준은 `SessionInfoState`(9.3) 규칙 그대로이고 뷰는 이 값만 읽는다.
struct MemberControlState: Equatable, Sendable {
    /// `model`·`prompt` 변경 캡션(PROTOCOL.md 6.2 `appliesAt: "next_session"`).
    static let nextSessionCaption = String(localized: "다음 세션부터 적용됩니다(기억 초기화로 바로 적용)")

    let info: SessionInfoState
    let mode: SessionMode
    /// 모델을 바꾼 직후 `nextSessionCaption`, 아니면 nil.
    let modelCaption: String?

    static func make(member: TeamMember, models: [ModelOption], modelChanged: Bool = false) -> MemberControlState {
        MemberControlState(
            info: SessionInfoState(currentModel: member.model, currentEffort: member.effort, models: models),
            mode: member.mode,
            modelCaption: modelChanged ? nextSessionCaption : nil
        )
    }

    /// 바뀐 필드만 담은 PATCH 본문. 같은 값이거나 nil 이면 보낼 것이 없다(nil).
    func patch(mode next: SessionMode?) -> PatchMemberRequest? {
        guard let next, next != mode else { return nil }
        return PatchMemberRequest(mode: next)
    }

    func patch(model next: String?) -> PatchMemberRequest? {
        guard let next, next != info.selectedModelId else { return nil }
        return PatchMemberRequest(model: next)
    }

    func patch(effort next: String?) -> PatchMemberRequest? {
        guard let next, next != info.selectedEffort else { return nil }
        return PatchMemberRequest(effort: next)
    }
}

/// 모델 피커 행(IOS.md 9.3, `SessionInfoSheet` 와 같은 규칙): 목록이 비면 "현재: <id>" 또는 안내, 있으면 "기본"(선택이 nil 일 때만) ·
/// "현재: <id>"(목록에 없을 때) · 목록. 선택이 바뀌면 `onSelect` 만 부른다(값은 호출자가 정한다).
struct ModelPickerRow: View {
    let state: SessionInfoState
    let models: [ModelOption]
    var isLoading = false
    var isDisabled = false
    let identifier: String
    let onSelect: (String) -> Void

    var body: some View {
        if models.isEmpty {
            if isLoading {
                ProgressView()
            } else if let unlisted = state.unlistedCurrentModel {
                LabeledContent("현재", value: unlisted)
            } else {
                Text("선택할 수 있는 모델이 없습니다").foregroundStyle(.secondary)
            }
        } else {
            Picker("모델", selection: selection) {
                if state.selectedModelId == nil {
                    Text("기본").tag(String?.none)
                }
                if let unlisted = state.unlistedCurrentModel {
                    Text("현재: \(unlisted)").tag(String?.some(unlisted))
                }
                ForEach(models) { option in
                    Text(option.displayName).tag(String?.some(option.id))
                }
            }
            .disabled(isDisabled)
            .accessibilityIdentifier(identifier)
        }
    }

    private var selection: Binding<String?> {
        Binding(
            get: { state.selectedModelId },
            set: { newValue in
                guard let newValue, newValue != state.selectedModelId else { return }
                onSelect(newValue)
            }
        )
    }
}

/// 사고 수준 피커 행. 호출자가 `state.showsEffortSection` 일 때만 넣는다.
struct EffortPickerRow: View {
    let state: SessionInfoState
    var isDisabled = false
    let identifier: String
    let onSelect: (String) -> Void

    var body: some View {
        Picker("사고 수준", selection: selection) {
            if state.selectedEffort == nil {
                Text("기본").tag(String?.none)
            }
            if let unlisted = state.unlistedCurrentEffort {
                Text("현재: \(unlisted)").tag(String?.some(unlisted))
            }
            ForEach(state.efforts, id: \.self) { effort in
                Text(effort).tag(String?.some(effort))
            }
        }
        .disabled(isDisabled)
        .accessibilityIdentifier(identifier)
    }

    private var selection: Binding<String?> {
        Binding(
            get: { state.selectedEffort },
            set: { newValue in
                guard let newValue, newValue != state.selectedEffort else { return }
                onSelect(newValue)
            }
        )
    }
}

/// 방의 팀원 시트(IOS.md 10.2): 헤더(칩·상태) → 권한 → 모델 → 사고 수준 → 브랜치 → 타임라인 열기 · 기억 초기화.
/// 변경은 즉시 `PATCH /teams/:id/members/:memberId`(낙관적 갱신 없음, 응답 `Team` 으로 `TeamsStore` 교체) 뒤 `onChanged`(방의 팀원 재조회).
/// `full-auto` 는 `ModeMenu` 와 같은 확인 다이얼로그를 거친 뒤에만 보낸다(ADR-015). 실패는 시트 안 빨간 캡션.
struct MemberControlSheet: View {
    /// 섹션 제목(렌더 테스트가 확인한다). 헤더 · 권한 · 모델 · (사고 수준) · 브랜치 · 동작 순서.
    static let modeSectionTitle = String(localized: "권한")
    static let modelSectionTitle = String(localized: "모델")
    static let branchSectionTitle = String(localized: "브랜치")

    @Environment(TeamsStore.self) private var teamsStore
    @Environment(\.dismiss) private var dismiss

    let teamId: String
    let member: TeamMember
    /// 방 이벤트·세션 조인으로 구한 상태. nil 이면 `member.state`.
    var state: TeamMemberState? = nil
    var onChanged: (@MainActor () async -> Void)? = nil
    var onOpenTimeline: ((String) -> Void)? = nil

    @State private var models: [ModelOption] = []
    @State private var isLoadingModels = false
    @State private var isPatching = false
    @State private var confirmsFullAuto = false
    @State private var confirmsReset = false
    @State private var didChangeModel = false
    @State private var errorMessage: String?

    /// 서버 응답으로 갱신된 팀원(`TeamsStore`). 목록에 없으면 열 때 받은 값.
    private var current: TeamMember {
        teamsStore.team(id: teamId)?.members.first { $0.id == member.id } ?? member
    }

    private var controlState: MemberControlState {
        MemberControlState.make(member: current, models: models, modelChanged: didChangeModel)
    }

    private var memberState: TeamMemberState {
        state ?? current.state
    }

    var body: some View {
        NavigationStack {
            Form {
                headerSection
                modeSection
                modelSections
                branchSection
                actionsSection
                errorSection
            }
            .navigationTitle("팀원")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("완료") { dismiss() }
                }
            }
            .task {
                isLoadingModels = true
                models = await teamsStore.models(for: member.agent)
                isLoadingModels = false
            }
            .confirmationDialog(
                "에이전트가 확인 없이 명령을 실행하고 파일을 수정합니다",
                isPresented: $confirmsFullAuto,
                titleVisibility: .visible
            ) {
                Button("full-auto로 전환", role: .destructive) {
                    let request = controlState.patch(mode: .fullAuto)
                    Task { await send(request) }
                }
            }
            .confirmationDialog("기억을 초기화할까요?", isPresented: $confirmsReset, titleVisibility: .visible) {
                Button("기억 초기화", role: .destructive) { Task { await reset() } }
            } message: {
                Text("세션을 닫고 다음 지시부터 새 세션으로 시작합니다. worktree 와 브랜치는 그대로입니다.")
            }
        }
    }

    // MARK: - 섹션

    private var headerSection: some View {
        Section {
            HStack(spacing: 10) {
                MemberChip(member: current)
                if current.isLead { LeadBadge() }
                Spacer(minLength: 0)
                MemberStatusDot(state: memberState)
                Text(memberState.label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(MemberChip.text(for: current)), \(memberState.label)")
        }
    }

    private var modeSection: some View {
        Section {
            Picker("권한", selection: modeSelection) {
                ForEach(MemberDraft.selectableModes, id: \.self) { mode in
                    Label(mode.rawValue, systemImage: mode.symbol).tag(mode)
                }
            }
            .disabled(isPatching)
            .accessibilityIdentifier("memberControl.mode")
        } header: {
            Text(Self.modeSectionTitle)
        } footer: {
            Text("바로 적용됩니다. full-auto 는 확인 뒤에만 켜집니다.")
        }
    }

    @ViewBuilder
    private var modelSections: some View {
        let state = controlState
        Section {
            ModelPickerRow(
                state: state.info, models: models, isLoading: isLoadingModels, isDisabled: isPatching, identifier: "memberControl.model"
            ) { id in
                let request = state.patch(model: id)
                Task { await send(request, changesModel: true) }
            }
        } header: {
            Text(Self.modelSectionTitle)
        } footer: {
            if let caption = state.modelCaption {
                Text(caption)
            } else if let description = models.first(where: { $0.id == state.info.selectedModelId })?.description {
                Text(description)
            }
        }
        if state.info.showsEffortSection {
            Section {
                EffortPickerRow(state: state.info, isDisabled: isPatching, identifier: "memberControl.effort") { effort in
                    let request = state.patch(effort: effort)
                    Task { await send(request) }
                }
            } header: {
                Text("사고 수준")
            } footer: {
                Text("다음 턴부터 적용됩니다")
            }
        }
    }

    private var branchSection: some View {
        Section(Self.branchSectionTitle) {
            LabeledContent("브랜치") {
                Text(current.branch)
                    .font(.caption.monospaced())
                    .multilineTextAlignment(.trailing)
            }
            LabeledContent("에이전트", value: current.agent.displayName)
        }
    }

    private var actionsSection: some View {
        Section {
            Button {
                guard let sessionId = current.sessionId else { return }
                onOpenTimeline?(sessionId)
                dismiss()
            } label: {
                Label("타임라인 열기", systemImage: "list.bullet.rectangle")
            }
            .disabled(current.sessionId == nil)
            .accessibilityIdentifier("memberControl.openTimeline")
            Button(role: .destructive) {
                confirmsReset = true
            } label: {
                Label("기억 초기화", systemImage: "arrow.counterclockwise")
            }
            .disabled(isPatching)
            .accessibilityIdentifier("memberControl.reset")
        } footer: {
            if current.sessionId == nil {
                Text("아직 세션이 없습니다. 첫 지시를 받으면 타임라인이 생깁니다.")
            }
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

    // MARK: - 바인딩·동작 (확정은 서버 응답 Team)

    /// `full-auto` 는 확인 다이얼로그만 띄운다(피커는 서버 값을 그대로 보여준다). 그 외는 즉시 PATCH.
    private var modeSelection: Binding<SessionMode> {
        Binding(
            get: { controlState.mode },
            set: { next in
                let state = controlState
                guard next != state.mode else { return }
                if MemberDraft.modeChangeNeedsConfirmation(from: state.mode, to: next) {
                    confirmsFullAuto = true
                } else {
                    let request = state.patch(mode: next)
                    Task { await send(request) }
                }
            }
        )
    }

    private func send(_ request: PatchMemberRequest?, changesModel: Bool = false) async {
        guard let request, !isPatching else { return }
        isPatching = true
        errorMessage = nil
        defer { isPatching = false }
        do {
            try await teamsStore.patchMember(teamId: teamId, memberId: member.id, request)
            if changesModel { didChangeModel = true }
            await onChanged?()
        } catch {
            errorMessage = ErrorMessages.teamMessage(for: error)
        }
    }

    private func reset() async {
        guard !isPatching else { return }
        isPatching = true
        errorMessage = nil
        defer { isPatching = false }
        do {
            try await teamsStore.resetMember(teamId: teamId, memberId: member.id)
            didChangeModel = false
            await onChanged?()
        } catch {
            errorMessage = ErrorMessages.teamMessage(for: error)
        }
    }
}
