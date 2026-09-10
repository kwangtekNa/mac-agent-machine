import Foundation
import Observation

/// 앱 전역 상태(IOS.md 6절). 서버 설정, `/me` 결과, 연결 상태, REST 클라이언트를 한곳에 둔다.
/// iPad 3열에서 회전·멀티태스킹으로 뷰가 다시 만들어져도 세션 화면 상태가 남도록 세션별 모델도 여기서 보관한다.
@MainActor
@Observable
final class AppState {
    enum ConnectionState: Equatable {
        case disconnected
        case connecting
        case connected(MeResponse)
        case failed(message: String)
    }

    /// UI 테스트가 `launchEnvironment` 로 넘기는 서버 주소. 있으면 저장된 설정 대신 쓰고 저장하지 않는다.
    static let uiTestServerKey = "MAM_UI_TEST_SERVER"
    /// 세션별 `TimelineModel` 보관 상한(LRU).
    static let maxTimelineModels = 5

    let configStore: ServerConfigStore
    private(set) var connection: ConnectionState = .disconnected
    private(set) var client: APIClient?
    /// iPad 사이드바 선택. compact 에서는 쓰지 않는다.
    var selectedSessionId: String?
    /// 세션 id → 타임라인 모델. 뷰 갱신 중에도 넣고 빼므로 관찰 대상에서 제외한다.
    @ObservationIgnored private(set) var timelineModels: [String: TimelineModel] = [:]
    @ObservationIgnored private var fileBrowserModels: [String: FileBrowserModel] = [:]
    /// 최근 사용 순서(뒤가 최신).
    @ObservationIgnored private var recentSessionIds: [String] = []
    @ObservationIgnored private let urlSession: URLSession
    @ObservationIgnored let uiTestServerURL: URL?

    init(
        configStore: ServerConfigStore = ServerConfigStore(),
        urlSession: URLSession = .shared,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) {
        self.configStore = configStore
        self.urlSession = urlSession
        self.uiTestServerURL = environment[Self.uiTestServerKey].flatMap { $0.isEmpty ? nil : URL(string: $0) }
    }

    /// 주소를 저장하고 `/me` 로 확인한다. 실패해도 주소는 남긴다(ConnectView 가 이유와 함께 보여준다).
    func connect(to url: URL) async {
        await open(url, persist: true)
    }

    /// 앱 시작 시. UI 테스트 override 가 있으면 그 주소로, 아니면 저장된 서버가 있을 때 조용히 `/me` 를 확인한다(IOS.md 4절).
    func reconnectSavedServer() async {
        if let uiTestServerURL {
            await open(uiTestServerURL, persist: false)
            return
        }
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
        clearModels()
    }

    // MARK: - 세션별 모델 (iPad 3열 상태 유지)

    /// 연결된 클라이언트로 세션의 타임라인 모델을 얻는다. 연결이 없으면 nil.
    func timelineModel(for sessionId: String) -> TimelineModel? {
        guard let client else { return nil }
        return timelineModel(for: sessionId, client: client)
    }

    /// 같은 세션이면 같은 인스턴스. `maxTimelineModels` 를 넘으면 가장 오래 안 쓴 세션의 모델을 멈추고 버린다.
    func timelineModel(for sessionId: String, client: APIClient) -> TimelineModel {
        touch(sessionId)
        if let existing = timelineModels[sessionId] {
            return existing
        }
        let model = TimelineModel(sessionId: sessionId, client: client)
        timelineModels[sessionId] = model
        evictIfNeeded()
        return model
    }

    /// 세션의 파일 브라우저 모델. cwd 가 바뀌면 새로 만든다. 타임라인 모델과 같은 LRU 로 정리된다.
    func fileBrowserModel(for sessionId: String, cwd: String) -> FileBrowserModel? {
        guard let client else { return nil }
        return fileBrowserModel(for: sessionId, cwd: cwd, client: client)
    }

    func fileBrowserModel(for sessionId: String, cwd: String, client: APIClient) -> FileBrowserModel {
        touch(sessionId)
        if let existing = fileBrowserModels[sessionId], existing.rootPath == cwd {
            return existing
        }
        let model = FileBrowserModel(client: client, rootPath: cwd)
        fileBrowserModels[sessionId] = model
        evictIfNeeded()
        return model
    }

    private func touch(_ sessionId: String) {
        recentSessionIds.removeAll { $0 == sessionId }
        recentSessionIds.append(sessionId)
    }

    private func evictIfNeeded() {
        while recentSessionIds.count > Self.maxTimelineModels, let oldest = recentSessionIds.first {
            recentSessionIds.removeFirst()
            timelineModels.removeValue(forKey: oldest)?.stop()
            fileBrowserModels.removeValue(forKey: oldest)
        }
    }

    private func clearModels() {
        for model in timelineModels.values { model.stop() }
        timelineModels.removeAll()
        fileBrowserModels.removeAll()
        recentSessionIds.removeAll()
        selectedSessionId = nil
    }

    private func open(_ url: URL, persist: Bool) async {
        if persist {
            configStore.save(ServerConfig(baseURL: url))
        }
        if client?.baseURL != url {
            clearModels()
        }
        let client = APIClient(baseURL: url, session: urlSession)
        self.client = client
        connection = .connecting
        await load(with: client)
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
