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

    /// 로그인 시작이 501/`agent_unavailable` 이면 SSH 안내로 바꾼다.
    static func isLoginUnsupported(_ error: any Error) -> Bool {
        guard case .server(let code, _, let status) = error as? APIError else { return false }
        return status == 501 || code == .agentUnavailable
    }
}
