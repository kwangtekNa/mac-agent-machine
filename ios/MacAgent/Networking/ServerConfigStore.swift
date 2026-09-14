import Foundation
import Observation

/// 저장되는 서버 설정. 서버는 하나만 저장한다(IOS.md 9절).
struct ServerConfig: Codable, Equatable, Sendable {
    var baseURL: URL

    init(baseURL: URL) {
        self.baseURL = baseURL
    }
}

enum ConfigError: Error, Equatable, Sendable {
    case emptyInput
    case invalidURL
    case unsupportedScheme(String)
    /// `http` 는 loopback·사설 IP·`*.local` 에만 허용한다. 그 외 호스트는 HTTPS(tailscale cert)여야 한다.
    case insecureScheme(host: String)
}

/// `UserDefaults` 키 `mam.server.config` 에 JSON 으로 저장하는 서버 설정 저장소.
@Observable
final class ServerConfigStore {
    static let defaultsKey = "mam.server.config"

    private(set) var config: ServerConfig?
    @ObservationIgnored private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.config = Self.load(from: defaults)
    }

    func save(_ config: ServerConfig) {
        self.config = config
        if let data = try? JSONEncoder().encode(config) {
            defaults.set(data, forKey: Self.defaultsKey)
        }
    }

    func clear() {
        config = nil
        defaults.removeObject(forKey: Self.defaultsKey)
    }

    private static func load(from defaults: UserDefaults) -> ServerConfig? {
        guard let data = defaults.data(forKey: defaultsKey) else { return nil }
        return try? JSONDecoder().decode(ServerConfig.self, from: data)
    }

    // MARK: - URL 정규화

    /// 사용자 입력 → baseURL. 스킴이 없으면 `https://`, 끝 `/` 제거, 포트 허용.
    /// `http` 는 호스트가 `127.0.0.1`·`localhost`·사설 IP·`*.local` 일 때만 허용한다.
    static func normalize(_ input: String) throws -> URL {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw ConfigError.emptyInput }
        if !text.contains("://") { text = "https://" + text }

        guard let components = URLComponents(string: text),
              let scheme = components.scheme?.lowercased(),
              let host = components.host, !host.isEmpty
        else { throw ConfigError.invalidURL }
        guard scheme == "http" || scheme == "https" else { throw ConfigError.unsupportedScheme(scheme) }
        if scheme == "http", !isLocalOrPrivateHost(host) { throw ConfigError.insecureScheme(host: host) }

        var normalized = URLComponents()
        normalized.scheme = scheme
        normalized.host = host.lowercased()
        normalized.port = components.port
        var path = components.path
        while path.hasSuffix("/") { path.removeLast() }
        normalized.path = path
        guard let url = normalized.url else { throw ConfigError.invalidURL }
        return url
    }

    /// loopback, RFC 1918 사설 IPv4, tailnet(100.64.0.0/10), `localhost`, `*.local`.
    /// tailnet 은 인증된 사설 오버레이 네트워크이고(ADR-001) 개발 gateway 는 TLS 가 없으므로 http 를 허용한다.
    static func isLocalOrPrivateHost(_ host: String) -> Bool {
        let h = host.lowercased()
        if h == "localhost" || h == "::1" || h.hasSuffix(".local") || h.hasSuffix(".localhost") { return true }
        let octets = h.split(separator: ".", omittingEmptySubsequences: false).map { Int($0) }
        guard octets.count == 4, octets.allSatisfy({ $0.map { (0...255).contains($0) } ?? false }) else { return false }
        let a = octets[0]!, b = octets[1]!
        switch (a, b) {
        case (10, _), (127, _), (192, 168): return true
        case (172, 16...31): return true
        case (100, 64...127): return true
        default: return false
        }
    }

    /// `http` → `ws`, `https` → `wss`. 그 외 스킴은 그대로.
    static func wsBaseURL(from httpURL: URL) -> URL {
        guard var components = URLComponents(url: httpURL, resolvingAgainstBaseURL: false) else { return httpURL }
        switch components.scheme?.lowercased() {
        case "http": components.scheme = "ws"
        case "https": components.scheme = "wss"
        default: break
        }
        return components.url ?? httpURL
    }

    func wsBaseURL(from httpURL: URL) -> URL {
        Self.wsBaseURL(from: httpURL)
    }
}
