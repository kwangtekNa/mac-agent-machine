import Foundation
import Observation

/// 앱 전역 상태(IOS.md 6절). 서버 설정, `/me` 결과, 연결 상태, REST 클라이언트를 한곳에 둔다.
@MainActor
@Observable
final class AppState {
    enum ConnectionState: Equatable {
        case disconnected
        case connecting
        case connected(MeResponse)
        case failed(message: String)
    }

    let configStore: ServerConfigStore
    private(set) var connection: ConnectionState = .disconnected
    private(set) var client: APIClient?
    @ObservationIgnored private let urlSession: URLSession

    init(configStore: ServerConfigStore = ServerConfigStore(), urlSession: URLSession = .shared) {
        self.configStore = configStore
        self.urlSession = urlSession
    }

    /// 주소를 저장하고 `/me` 로 확인한다. 실패해도 주소는 남긴다(ConnectView 가 이유와 함께 보여준다).
    func connect(to url: URL) async {
        configStore.save(ServerConfig(baseURL: url))
        let client = APIClient(baseURL: url, session: urlSession)
        self.client = client
        connection = .connecting
        await load(with: client)
    }

    /// 앱 시작 시. 저장된 서버가 있으면 조용히 `/me` 를 확인한다(IOS.md 4절).
    func reconnectSavedServer() async {
        guard let config = configStore.config else {
            connection = .disconnected
            return
        }
        await connect(to: config.baseURL)
    }

    /// 로그인 완료 등으로 `/me` 가 바뀌었을 때 다시 읽는다.
    func refreshMe() async {
        guard let client else { return }
        await load(with: client)
    }

    /// 저장된 서버를 지우고 처음 화면으로 돌아간다.
    func disconnect() {
        configStore.clear()
        client = nil
        connection = .disconnected
    }

    private func load(with client: APIClient) async {
        do {
            let me = try await client.me()
            connection = .connected(me)
        } catch {
            connection = .failed(message: ErrorMessages.message(for: error))
        }
    }
}
