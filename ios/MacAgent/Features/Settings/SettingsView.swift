import SwiftUI

/// 서버·에이전트·앱 정보. 연결된 상태에서만 열린다.
struct SettingsView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
    @State private var loginAgent: AgentKind?
    /// 구독 사용 한도 요약(설정 행 인라인)과 상세 화면이 같은 모델을 쓴다.
    @State private var usageModel: UsageLimitsModel?

    var body: some View {
        NavigationStack {
            Form {
                if case .connected(let me) = appState.connection {
                    serverSection(me)
                    agentsSection(me)
                    usageSection
                }
                infoSection
            }
            .navigationTitle("설정")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("닫기") { dismiss() }
                }
            }
            .sheet(item: $loginAgent) { agent in
                AgentLoginView(agent: agent)
            }
            .task {
                guard usageModel == nil, let client = appState.client else { return }
                let model = UsageLimitsModel(client: client)
                usageModel = model
                await model.load()
            }
        }
    }

    private func serverSection(_ me: MeResponse) -> some View {
        Section("서버") {
            LabeledContent("주소", value: appState.configStore.config?.baseURL.absoluteString ?? "")
            LabeledContent("사용자 이름", value: me.user)
            LabeledContent("이메일", value: me.email)
            LabeledContent("서버 버전", value: me.server.version)
            Button("연결 해제", role: .destructive) {
                appState.disconnect()
                dismiss()
            }
        }
    }

    private func agentsSection(_ me: MeResponse) -> some View {
        Section("에이전트") {
            ForEach([AgentKind.claude, .codex], id: \.self) { kind in
                AgentRow(
                    kind: kind,
                    info: me.agents.first { $0.kind == kind },
                    login: { loginAgent = kind }
                )
            }
        }
    }

    /// "구독 사용 한도" → 상세 화면. 인라인 요약은 에이전트별 가장 높은 `usedPercent` 한 줄(IOS.md 9.3).
    @ViewBuilder
    private var usageSection: some View {
        if let usageModel {
            Section("구독 사용 한도") {
                NavigationLink {
                    UsageLimitsView(model: usageModel)
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("사용 한도 보기")
                        if let summary = UsageLimitsModel.summaryLine(usageModel.agents) {
                            Text(summary).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                .accessibilityIdentifier("settings.usageLimits")
            }
        }
    }

    private var infoSection: some View {
        Section("정보") {
            LabeledContent("앱 버전", value: Self.appVersion)
            LabeledContent("프로토콜", value: APIClient.protocolVersion)
        }
    }

    static var appVersion: String {
        let short = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
        switch (short, build) {
        case (let s?, let b?): return "\(s) (\(b))"
        case (let s?, nil): return s
        default: return "-"
        }
    }
}

extension AgentKind: Identifiable {
    var id: String { rawValue }

    /// 사용자에게 보이는 이름.
    var displayName: String {
        switch self {
        case .claude: return "Claude Code"
        case .codex: return "Codex"
        case .unknown: return rawValue
        }
    }
}

private struct AgentRow: View {
    let kind: AgentKind
    let info: AgentInfo?
    let login: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(kind.displayName)
                    .font(.headline)
                Spacer()
                availabilityBadge
            }
            if let info {
                if let version = info.version {
                    LabeledContent("버전", value: version)
                        .font(.subheadline)
                }
                LabeledContent("로그인") {
                    if info.loggedIn {
                        Text(info.account ?? String(localized: "로그인됨"))
                    } else {
                        Text("로그인 필요")
                            .foregroundStyle(.secondary)
                    }
                }
                .font(.subheadline)
                if info.available, !info.loggedIn {
                    Button("로그인", action: login)
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                        .padding(.top, 2)
                }
            }
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private var availabilityBadge: some View {
        if let info, info.available {
            Label("사용 가능", systemImage: "checkmark.circle.fill")
                .font(.caption)
                .foregroundStyle(.green)
        } else {
            Label("설치되지 않음", systemImage: "xmark.circle")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}
