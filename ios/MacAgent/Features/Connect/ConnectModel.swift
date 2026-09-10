import Foundation
import Observation

/// 서버 주소 입력 → 정규화 → `AppState.connect`. 검증 실패는 한국어 문구로 남긴다.
@MainActor
@Observable
final class ConnectModel {
    var address: String
    private(set) var validationMessage: String?
    private(set) var isSubmitting = false

    /// 시뮬레이터 보조 버튼이 채우는 개발 서버 주소.
    static let devServerAddress = "http://127.0.0.1:7777"

    init(savedConfig: ServerConfig? = nil) {
        address = savedConfig?.baseURL.absoluteString ?? ""
    }

    var canSubmit: Bool {
        !address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSubmitting
    }

    func submit(using appState: AppState) async {
        let url: URL
        do {
            url = try ServerConfigStore.normalize(address)
        } catch let error as ConfigError {
            validationMessage = ErrorMessages.message(for: error)
            return
        } catch {
            validationMessage = ErrorMessages.invalidServerURL
            return
        }
        validationMessage = nil
        isSubmitting = true
        defer { isSubmitting = false }
        await appState.connect(to: url)
    }
}
