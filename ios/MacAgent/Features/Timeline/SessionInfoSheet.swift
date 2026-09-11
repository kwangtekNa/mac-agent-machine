import SwiftUI

/// 세션 정보 시트의 모델·사고 수준·구독 한도 표시 규칙(IOS.md 9.3). 뷰는 이 값만 읽는다.
struct SessionInfoState: Equatable, Sendable {
    /// 피커 선택값. 목록에 없어도 현재 값을 유지한다(빈 선택이 되지 않게).
    var selectedModelId: String?
    /// 현재 모델이 `GET /models` 목록에 없으면 그 id("현재: <id>" 행으로 보인다).
    var unlistedCurrentModel: String?
    /// 현재 모델의 effort 목록. 비어 있으면 "사고 수준" 섹션을 숨긴다.
    var efforts: [String]
    var selectedEffort: String?
    /// 현재 effort 가 목록에 없으면 그 값("현재: <effort>" 행).
    var unlistedCurrentEffort: String?

    init(currentModel: String?, currentEffort: String?, models: [ModelOption]) {
        selectedModelId = currentModel
        let listed = currentModel.flatMap { id in models.first { $0.id == id } }
        unlistedCurrentModel = currentModel != nil && listed == nil ? currentModel : nil
        efforts = listed?.efforts ?? []
        selectedEffort = currentEffort
        if let currentEffort, !efforts.isEmpty, !efforts.contains(currentEffort) {
            unlistedCurrentEffort = currentEffort
        } else {
            unlistedCurrentEffort = nil
        }
    }

    var showsEffortSection: Bool {
        !efforts.isEmpty
    }

    /// 구독 한도 요약 최대 2줄: `5시간 42% · 3시간 후 초기화`. 관측값이 없으면 빈 배열.
    static func limitLines(_ agent: AgentUsage?, now: Date = .now, calendar: Calendar = .current) -> [String] {
        guard let agent else { return [] }
        return agent.limits.prefix(2).map { limit in
            let line = Formatters.resetLine(usedPercent: limit.usedPercent, resetsAt: limit.resetsAt, now: now, calendar: calendar)
            return "\(limit.label) \(line)"
        }
    }
}

/// 세션 정보 시트(IOS.md 9.3): 세션 → 사용량 → 모델 → 사고 수준 → 구독 한도 → 세션 닫기.
/// 모델·사고 수준 변경은 `TimelineModel.setModel/setEffort`(PATCH 응답으로 교체, 낙관적 갱신 없음).
struct SessionInfoSheet: View {
    @Environment(\.dismiss) private var dismiss
    let model: TimelineModel
    let session: Session?
    let client: APIClient
    let onClose: () async -> Void
    @State private var isClosing = false
    @State private var agentUsage: AgentUsage?
    @State private var usageError: String?

    var body: some View {
        NavigationStack {
            Form {
                if let session {
                    sessionSection(session)
                    usageSection(session)
                    modelSections(session)
                    limitsSection(session)
                    if session.status != .closed {
                        closeSection
                    }
                } else {
                    ContentUnavailableView("세션을 찾을 수 없습니다", systemImage: "questionmark.circle")
                }
            }
            .navigationTitle("세션 정보")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("완료") { dismiss() }
                }
            }
            .task {
                // 서버의 model/effort 는 WS 이벤트로 오지 않으므로(session.usage 는 usage 만) 열 때 세션을 다시 읽는다.
                await model.refreshDetail()
                await model.loadModels()
                await loadUsage()
            }
        }
    }

    // MARK: - 섹션

    private func sessionSection(_ session: Session) -> some View {
        Section("세션") {
            LabeledContent("디렉토리") {
                Text(session.cwd).font(.caption.monospaced()).multilineTextAlignment(.trailing)
            }
            LabeledContent("에이전트", value: session.agent.displayName)
            LabeledContent("모드", value: session.mode.rawValue)
            LabeledContent("상태", value: session.status.label)
            LabeledContent("네이티브 ID") {
                Text(session.nativeId ?? String(localized: "없음")).font(.caption.monospaced())
            }
            LabeledContent("생성", value: session.createdAt.formatted(date: .abbreviated, time: .shortened))
        }
    }

    private func usageSection(_ session: Session) -> some View {
        Section("사용량") {
            if let usage = session.usage {
                LabeledContent("입력 토큰", value: Formatters.tokens(usage.inputTokens))
                LabeledContent("출력 토큰", value: Formatters.tokens(usage.outputTokens))
                LabeledContent("캐시 읽기", value: Formatters.tokens(usage.cacheReadTokens))
                LabeledContent("캐시 쓰기", value: Formatters.tokens(usage.cacheWriteTokens))
                LabeledContent("비용(추정)") {
                    if let cost = usage.costUsd {
                        Text(Formatters.usd(cost))
                    } else {
                        Text("구독 요금제라 표시 안 함").foregroundStyle(.secondary)
                    }
                }
                LabeledContent("턴", value: "\(usage.turns)")
                if let context = usage.context {
                    VStack(alignment: .leading, spacing: 6) {
                        LabeledContent(
                            "컨텍스트",
                            value: Formatters.contextDetail(tokens: context.tokens, window: context.window, percent: context.percent)
                        )
                        ProgressView(value: Double(min(max(context.percent, 0), 100)), total: 100)
                            .tint(UsageLevel.tint(percent: context.percent))
                    }
                }
                LabeledContent("마지막 갱신", value: Formatters.relativeTime(usage.updatedAt))
            } else {
                Text("아직 사용량이 없습니다").foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private func modelSections(_ session: Session) -> some View {
        let state = SessionInfoState(currentModel: session.model, currentEffort: session.effort, models: model.models)
        Section {
            if model.models.isEmpty {
                if let error = model.modelsError {
                    Text(error).foregroundStyle(.secondary)
                } else if model.isLoadingModels {
                    ProgressView()
                } else if let unlisted = state.unlistedCurrentModel {
                    LabeledContent("현재", value: unlisted)
                } else {
                    Text("선택할 수 있는 모델이 없습니다").foregroundStyle(.secondary)
                }
            } else {
                Picker("모델", selection: modelSelection(state)) {
                    if state.selectedModelId == nil {
                        Text("기본").tag(String?.none)
                    }
                    if let unlisted = state.unlistedCurrentModel {
                        Text("현재: \(unlisted)").tag(String?.some(unlisted))
                    }
                    ForEach(model.models) { option in
                        Text(option.displayName).tag(String?.some(option.id))
                    }
                }
                .disabled(model.isPatching)
                .accessibilityIdentifier("sessionInfo.model")
            }
        } header: {
            Text("모델")
        } footer: {
            if let description = model.models.first(where: { $0.id == state.selectedModelId })?.description {
                Text(description)
            }
        }
        if state.showsEffortSection {
            Section {
                Picker("사고 수준", selection: effortSelection(state)) {
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
                .disabled(model.isPatching)
                .accessibilityIdentifier("sessionInfo.effort")
            } header: {
                Text("사고 수준")
            } footer: {
                Text("다음 턴부터 적용됩니다")
            }
        }
    }

    private func limitsSection(_ session: Session) -> some View {
        Section("구독 한도") {
            let lines = SessionInfoState.limitLines(agentUsage)
            if let usageError {
                Text(usageError).foregroundStyle(.secondary)
            } else if lines.isEmpty {
                Text("아직 관측되지 않았습니다").foregroundStyle(.secondary)
            } else {
                ForEach(lines, id: \.self) { line in
                    Text(line)
                }
            }
            NavigationLink("설정에서 자세히") {
                UsageLimitsView(client: client)
            }
        }
    }

    private var closeSection: some View {
        Section {
            Button("세션 닫기", role: .destructive) {
                Task {
                    isClosing = true
                    await onClose()
                    isClosing = false
                }
            }
            .disabled(isClosing)
        }
    }

    // MARK: - 바인딩·로드

    /// 선택이 바뀌면 PATCH 만 보낸다. 값은 응답 Session 으로 돌아온다.
    private func modelSelection(_ state: SessionInfoState) -> Binding<String?> {
        Binding(
            get: { state.selectedModelId },
            set: { newValue in
                guard let newValue, newValue != state.selectedModelId else { return }
                Task { await model.setModel(newValue) }
            }
        )
    }

    private func effortSelection(_ state: SessionInfoState) -> Binding<String?> {
        Binding(
            get: { state.selectedEffort },
            set: { newValue in
                guard let newValue, newValue != state.selectedEffort else { return }
                Task { await model.setEffort(newValue) }
            }
        )
    }

    private func loadUsage() async {
        guard let agent = session?.agent else { return }
        do {
            let response = try await client.usage()
            agentUsage = response.agents.first { $0.kind == agent }
            usageError = nil
        } catch {
            if Task.isCancelled { return }
            usageError = ErrorMessages.message(for: error)
        }
    }
}
