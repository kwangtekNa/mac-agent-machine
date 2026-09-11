import Foundation
import Observation

/// 설정 > 구독 사용 한도(IOS.md 9.3). `GET /usage` 를 화면 등장 시 1회, 이후 `refreshInterval` 마다 읽는다.
/// 실패해도 이전 값은 남기고 문구만 바꾼다.
@MainActor
@Observable
final class UsageLimitsModel {
    static let refreshInterval: Duration = .seconds(60)

    private(set) var agents: [AgentUsage] = []
    /// 마지막 조회 실패 문구. 성공하면 nil.
    private(set) var errorMessage: String?
    /// 마지막 성공 시각.
    private(set) var lastLoadedAt: Date?
    private(set) var isLoading = false

    @ObservationIgnored private let client: APIClient
    @ObservationIgnored private let sleep: @Sendable (Duration) async throws -> Void
    @ObservationIgnored private let now: @Sendable () -> Date

    init(
        client: APIClient,
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.client = client
        self.sleep = sleep
        self.now = now
    }

    func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let response = try await client.usage()
            guard !Task.isCancelled else { return }
            agents = response.agents
            lastLoadedAt = now()
            errorMessage = nil
        } catch {
            guard !Task.isCancelled else { return }
            errorMessage = ErrorMessages.message(for: error)
        }
    }

    /// 등장 시 1회 읽고 `refreshInterval` 마다 다시 읽는다. 뷰의 `.task` 가 취소하면 멈춘다.
    func runAutoRefresh() async {
        while !Task.isCancelled {
            await load()
            do {
                try await sleep(Self.refreshInterval)
            } catch {
                return
            }
        }
    }

    // MARK: - 표시 규칙

    /// `usedPercent` 가 가장 높은 창. 한도가 없으면 nil.
    static func worstLimit(of agent: AgentUsage) -> UsageLimit? {
        agent.limits.max { $0.usedPercent < $1.usedPercent }
    }

    /// 설정 행의 인라인 요약 `Claude Code 81% · Codex 35%`. 관측된 한도가 하나도 없으면 nil.
    static func summaryLine(_ agents: [AgentUsage]) -> String? {
        let parts = agents.compactMap { agent -> String? in
            guard let worst = worstLimit(of: agent) else { return nil }
            return "\(agent.kind.displayName) \(worst.usedPercent)%"
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// 카드 헤더 `Claude Code · Max`. 요금제를 모르면 이름만.
    static func header(for agent: AgentUsage) -> String {
        guard let plan = agent.plan, !plan.isEmpty else { return agent.kind.displayName }
        return "\(agent.kind.displayName) · \(plan.prefix(1).uppercased() + plan.dropFirst())"
    }

    /// `live: false`(Claude) 카드의 하단 캡션. live 카드는 nil.
    static func observationCaption(for agent: AgentUsage, calendar: Calendar = .current) -> String? {
        guard !agent.live else { return nil }
        guard let observedAt = agent.observedAt else { return String(localized: "아직 관측되지 않았습니다") }
        let time = Formatters.clock(observedAt, calendar: calendar)
        return String(localized: "마지막 관측 \(time) · 세션을 실행하면 갱신됩니다")
    }
}
