import Foundation

/// 사용자에게 보이는 오류 문구(IOS.md 5.5: 원인 + 다음 행동, 시스템 용어 노출 금지).
enum ErrorMessages {
    static let cannotConnect = String(localized: "서버에 연결할 수 없습니다. Tailscale이 켜져 있는지 확인하세요.")
    static let notRegistered = String(localized: "이 계정은 서버에 등록되어 있지 않습니다. 관리자에게 이메일 등록을 요청하세요.")
    static let updateRequired = String(localized: "앱을 업데이트해야 합니다.")
    static let unreadableResponse = String(localized: "서버 응답을 읽을 수 없습니다. 서버 버전을 확인하세요.")
    static let invalidServerURL = String(localized: "서버 주소 형식이 올바르지 않습니다. 예: https://macmini.tailnet.ts.net")
    static let loginUnsupported = String(
        localized: "이 서버에서는 앱 로그인을 지원하지 않습니다. SSH로 접속해 `claude setup-token` 또는 `codex login`을 실행하세요."
    )

    /// REST 오류 → 문구. 전송 오류, 403, 426 은 고정 문구, 그 외는 서버 메시지.
    static func message(for error: any Error) -> String {
        guard let apiError = error as? APIError else { return cannotConnect }
        switch apiError {
        case .transport:
            return cannotConnect
        case .unsupportedProtocol:
            return updateRequired
        case .server(_, _, let status) where status == 403:
            return notRegistered
        case .server(_, let message, _):
            return message
        case .decoding:
            return unreadableResponse
        case .invalidURL:
            return invalidServerURL
        }
    }

    /// 서버 주소 입력 검증 오류 → 문구.
    static func message(for error: ConfigError) -> String {
        switch error {
        case .emptyInput:
            return String(localized: "서버 주소를 입력하세요.")
        case .invalidURL:
            return invalidServerURL
        case .unsupportedScheme:
            return String(localized: "http 또는 https 주소만 사용할 수 있습니다.")
        case .insecureScheme(let host):
            return String(localized: "\(host)에는 https로 연결해야 합니다. 주소를 https://로 시작하세요.")
        }
    }

    /// `POST /sessions` 오류 → 문구. 403 은 홈 밖 경로(IOS.md 7절), 400 은 없는 경로, `agent_unavailable` 은 설정 안내.
    static func sessionCreateMessage(for error: any Error, agent: AgentKind) -> String {
        guard case .server(let code, _, let status) = error as? APIError else {
            return message(for: error)
        }
        if code == .agentUnavailable {
            return String(localized: "\(agent.displayName)를 지금 사용할 수 없습니다. 설정에서 설치와 로그인 상태를 확인하세요.")
        }
        switch status {
        case 403:
            return String(localized: "접근할 수 없는 경로입니다. 홈 디렉토리 안의 경로를 입력하세요.")
        case 400, 404:
            return String(localized: "디렉토리를 찾을 수 없습니다. 경로를 확인하세요.")
        default:
            return message(for: error)
        }
    }

    /// 로그인 시작이 501/`agent_unavailable` 이면 SSH 안내로 바꾼다.
    static func isLoginUnsupported(_ error: any Error) -> Bool {
        guard case .server(let code, _, let status) = error as? APIError else { return false }
        return status == 501 || code == .agentUnavailable
    }
}

extension ErrorMessages {
    static let agentBusy = String(localized: "에이전트가 응답 중입니다. 잠시 후 다시 보내세요.")
    static let sendFailed = String(localized: "메시지를 보내지 못했습니다. 연결 상태를 확인하세요.")
    static let sessionError = String(localized: "세션에 오류가 발생했습니다. 다시 시도하세요.")

    /// WS `error{recoverable:true}` 메시지 → 문구. 알려진 시스템 문구만 바꾸고 나머지는 그대로.
    static func socketErrorMessage(_ message: String) -> String {
        message.lowercased() == "session is busy" ? agentBusy : message
    }
}
