import SwiftUI

/// 설정 > 구독 사용 한도(IOS.md 9.3). 에이전트별 카드, 창마다 게이지와 `42% · 3시간 후 초기화`.
/// 등장 시 1회 읽고 60초마다 갱신(사라지면 중단), 당겨서 새로고침. Codex(`live`)는 툴바 새로고침 버튼으로 즉시 재조회.
struct UsageLimitsView: View {
    @State private var model: UsageLimitsModel

    init(model: UsageLimitsModel) {
        _model = State(initialValue: model)
    }

    init(client: APIClient) {
        self.init(model: UsageLimitsModel(client: client))
    }

    var body: some View {
        Form {
            if let error = model.errorMessage {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.secondary)
                }
            }
            if model.agents.isEmpty, model.isLoading {
                Section {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                }
            }
            ForEach(model.agents, id: \.kind) { agent in
                agentSection(agent)
            }
        }
        .navigationTitle("구독 사용 한도")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if model.agents.contains(where: \.live) {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await model.load() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .disabled(model.isLoading)
                    .accessibilityLabel("새로고침")
                    .accessibilityIdentifier("usageLimits.refresh")
                }
            }
        }
        .refreshable { await model.load() }
        .task { await model.runAutoRefresh() }
    }

    private func agentSection(_ agent: AgentUsage) -> some View {
        Section {
            if agent.limits.isEmpty, agent.live {
                Text("한도 정보가 없습니다").foregroundStyle(.secondary)
            }
            ForEach(agent.limits) { limit in
                LimitRow(limit: limit)
            }
        } header: {
            Text(UsageLimitsModel.header(for: agent))
        } footer: {
            if let caption = UsageLimitsModel.observationCaption(for: agent) {
                Text(caption)
            }
        }
    }
}

/// 한도 창 한 행: 라벨 + 게이지 + `42% · 3시간 후 초기화`. `exceeded` 면 "한도 도달" 캡션.
private struct LimitRow: View {
    let limit: UsageLimit

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(limit.label)
                Spacer()
                Text(Formatters.resetLine(usedPercent: limit.usedPercent, resetsAt: limit.resetsAt))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            ProgressView(value: Double(min(max(limit.usedPercent, 0), 100)), total: 100)
                .tint(limit.status.tint)
            if limit.status.showsExceededCaption {
                Label("한도 도달", systemImage: "exclamationmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}
