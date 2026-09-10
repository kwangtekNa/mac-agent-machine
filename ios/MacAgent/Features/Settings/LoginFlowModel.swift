import Foundation
import Observation

/// 에이전트 로그인 플로우(PROTOCOL.md 1절, ADR-008). start → (코드 제출) → 2초 간격 status 폴링 → done/error.
@MainActor
@Observable
final class LoginFlowModel {
    enum Phase: Equatable {
        case starting
        /// 안내가 표시되고 폴링 중. `needsCode` 면 코드 입력도 보인다.
        case waiting
        case done(message: String)
        case failed(message: String)
        /// 501 / `agent_unavailable`: 이 서버는 앱 로그인을 지원하지 않는다.
        case unsupported(message: String)
    }

    static let pollInterval: Duration = .seconds(2)

    let agent: AgentKind
    private(set) var phase: Phase = .starting
    private(set) var start: LoginStartResponse?
    /// 코드 입력 필드. 제출 후 비운다(코드는 저장하지 않는다).
    var code = ""
    private(set) var isSubmittingCode = false
    /// 코드 제출 실패 문구.
    private(set) var codeMessage: String?
    @ObservationIgnored private(set) var pollTask: Task<Void, Never>?

    @ObservationIgnored private let client: APIClient
    @ObservationIgnored private let sleep: @Sendable (Duration) async throws -> Void

    init(
        agent: AgentKind,
        client: APIClient,
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) {
        self.agent = agent
        self.client = client
        self.sleep = sleep
    }

    var loginURL: URL? {
        start.flatMap { URL(string: $0.url) }
    }

    /// `needsCode == false`(Codex)일 때 instructions 안의 `XXXX-XXXX` 코드. 없으면 nil.
    var displayedCode: String? {
        guard let start, !start.needsCode else { return nil }
        return start.instructions.firstMatch(of: /[A-Z0-9]{4}-[A-Z0-9]{4}/).map { String($0.output) }
    }

    var canSubmitCode: Bool {
        !code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSubmittingCode && phase == .waiting
    }

    func begin() async {
        stop()
        phase = .starting
        start = nil
        codeMessage = nil
        do {
            let response = try await client.startLogin(agent: agent)
            start = response
            phase = .waiting
            startPolling(flowId: response.flowId)
        } catch {
            if ErrorMessages.isLoginUnsupported(error) {
                phase = .unsupported(message: ErrorMessages.loginUnsupported)
            } else {
                phase = .failed(message: ErrorMessages.message(for: error))
            }
        }
    }

    func retry() async {
        await begin()
    }

    func submitCode() async {
        guard let start, canSubmitCode else { return }
        let submitted = code.trimmingCharacters(in: .whitespacesAndNewlines)
        isSubmittingCode = true
        codeMessage = nil
        defer { isSubmittingCode = false }
        do {
            try await client.submitLoginCode(agent: agent, flowId: start.flowId, code: submitted)
            code = ""
        } catch {
            codeMessage = ErrorMessages.message(for: error)
        }
    }

    /// 화면이 사라질 때 호출. 폴링만 멈추고 상태는 바꾸지 않는다.
    func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    private func startPolling(flowId: String) {
        let sleep = self.sleep
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                do { try await sleep(Self.pollInterval) } catch { return }
                guard let self, !Task.isCancelled else { return }
                if await self.poll(flowId: flowId) { return }
            }
        }
    }

    /// 한 번 조회. 폴링을 끝내야 하면 true.
    private func poll(flowId: String) async -> Bool {
        do {
            let status = try await client.loginStatus(agent: agent, flowId: flowId)
            guard !Task.isCancelled else { return true }
            switch status.status {
            case .done:
                phase = .done(message: status.message)
            case .error:
                phase = .failed(message: status.message)
            case .pending, .unknown:
                return false
            }
        } catch {
            guard !Task.isCancelled else { return true }
            phase = .failed(message: ErrorMessages.message(for: error))
        }
        pollTask = nil
        return true
    }
}
