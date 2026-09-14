import Foundation

/// 미리보기 링크 규칙(순수). 폰에서 Mac 의 개발 서버를 열려면 `localhost` 계열 주소를 Mac 주소로 바꿔야 한다.
/// 스킴·포트·경로·쿼리는 원본 그대로 두고 **호스트만** 앱에 저장된 서버 URL 의 호스트로 바꾼다.
/// 서버는 이 포트를 프록시하지 않으므로(PROTOCOL.md `GET /net/ports` 보안 노트) loopback 에만 바인딩된 서버는 폰에서 열리지 않을 수 있다.
enum PreviewLink {
    /// 변환 대상 호스트. 대괄호 없는 형태로 비교한다(`[::1]` → `::1`).
    static let localHosts: Set<String> = ["localhost", "127.0.0.1", "0.0.0.0", "::1"]

    /// localhost 계열 `http`/`https` URL 을 서버 호스트로 바꾼다. 그 외(다른 호스트·다른 스킴)는 nil 이며 시스템이 연다.
    static func rewrite(_ url: URL, serverURL: URL) -> URL? {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = components.host.map(normalize),
              localHosts.contains(host),
              let serverHost = serverHost(of: serverURL)
        else { return nil }
        components.host = serverHost
        return components.url
    }

    /// 포트 목록·직접 입력에서 여는 주소: `http://<서버 호스트>:<port>/`.
    static func previewURL(port: Int, serverURL: URL) -> URL {
        guard let host = serverHost(of: serverURL) else { return serverURL }
        var components = URLComponents()
        components.scheme = "http"
        components.host = host
        components.port = port
        components.path = "/"
        return components.url ?? serverURL
    }

    /// loopback 에만 바인딩된 포트(`127.0.0.1`·`::1`). 폰에서 열리지 않을 수 있어 목록에 캡션을 붙인다.
    static func isMacOnly(_ port: NetPort) -> Bool {
        let address = normalize(port.address)
        return address == "127.0.0.1" || address == "::1"
    }

    /// 서버 URL 의 호스트. IPv6 는 URL 에 쓸 수 있게 대괄호를 붙인 형태로 돌려준다.
    private static func serverHost(of serverURL: URL) -> String? {
        guard let host = URLComponents(url: serverURL, resolvingAgainstBaseURL: false)?.host else { return nil }
        let normalized = normalize(host)
        guard !normalized.isEmpty else { return nil }
        return normalized.contains(":") ? "[\(normalized)]" : normalized
    }

    /// 소문자 + IPv6 대괄호 제거(플랫폼에 따라 `URLComponents.host` 가 `[::1]` 또는 `::1` 을 준다).
    private static func normalize(_ host: String) -> String {
        var value = host.lowercased()
        if value.hasPrefix("["), value.hasSuffix("]") { value = String(value.dropFirst().dropLast()) }
        return value
    }
}

/// 최근 연 미리보기 포트(`UserDefaults`, 최근 순 최대 5개). 테스트는 suite 를 주입한다.
struct RecentPortsStore {
    static let defaultsKey = "preview.recentPorts.v1"
    static let limit = 5

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    /// 최근에 연 순서(앞이 최신).
    var ports: [Int] {
        let stored = defaults.array(forKey: Self.defaultsKey) as? [Int] ?? []
        return Array(stored.filter(Self.isValid).prefix(Self.limit))
    }

    /// 이미 있으면 맨 앞으로 옮기고, 상한을 넘으면 오래된 것을 버린다. 범위 밖 포트는 무시한다.
    func add(_ port: Int) {
        guard Self.isValid(port) else { return }
        var next = ports.filter { $0 != port }
        next.insert(port, at: 0)
        defaults.set(Array(next.prefix(Self.limit)), forKey: Self.defaultsKey)
    }

    static func isValid(_ port: Int) -> Bool {
        (1...65535).contains(port)
    }
}
