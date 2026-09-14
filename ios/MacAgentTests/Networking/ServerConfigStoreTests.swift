import Foundation
import XCTest
@testable import MacAgent

final class ServerConfigStoreTests: XCTestCase {
    func testNormalizeAddsHTTPSWhenSchemeMissing() throws {
        XCTAssertEqual(try ServerConfigStore.normalize("macmini.tail1234.ts.net").absoluteString, "https://macmini.tail1234.ts.net")
        XCTAssertEqual(try ServerConfigStore.normalize("  MacMini.tail1234.ts.net:8443 ").absoluteString, "https://macmini.tail1234.ts.net:8443")
    }

    func testNormalizeAllowsLocalHTTP() throws {
        XCTAssertEqual(try ServerConfigStore.normalize("http://127.0.0.1:7777").absoluteString, "http://127.0.0.1:7777")
        XCTAssertEqual(try ServerConfigStore.normalize("http://localhost:7777").absoluteString, "http://localhost:7777")
        XCTAssertEqual(try ServerConfigStore.normalize("http://192.168.0.10:7777").absoluteString, "http://192.168.0.10:7777")
        XCTAssertEqual(try ServerConfigStore.normalize("http://10.1.2.3").absoluteString, "http://10.1.2.3")
        XCTAssertEqual(try ServerConfigStore.normalize("http://172.20.0.1").absoluteString, "http://172.20.0.1")
        XCTAssertEqual(try ServerConfigStore.normalize("http://macmini.local").absoluteString, "http://macmini.local")
    }

    /// tailnet(100.64.0.0/10)은 인증된 사설 오버레이 네트워크다(ADR-001). 개발 gateway 는 TLS 가 없으므로 http 를 허용한다.
    func testNormalizeAllowsTailnetHTTP() throws {
        XCTAssertEqual(try ServerConfigStore.normalize("http://100.87.186.44:7777").absoluteString, "http://100.87.186.44:7777")
        XCTAssertEqual(try ServerConfigStore.normalize("http://100.64.0.1").absoluteString, "http://100.64.0.1")
        XCTAssertEqual(try ServerConfigStore.normalize("http://100.127.255.254").absoluteString, "http://100.127.255.254")
    }

    func testNormalizeRejectsPublicHTTP() {
        XCTAssertThrowsError(try ServerConfigStore.normalize("http://example.com")) { error in
            XCTAssertEqual(error as? ConfigError, .insecureScheme(host: "example.com"))
        }
        // tailnet 대역(100.64~100.127) 밖의 100.x 는 공인 주소다.
        XCTAssertThrowsError(try ServerConfigStore.normalize("http://100.63.255.255")) { error in
            XCTAssertEqual(error as? ConfigError, .insecureScheme(host: "100.63.255.255"))
        }
        XCTAssertThrowsError(try ServerConfigStore.normalize("http://100.128.0.1")) { error in
            XCTAssertEqual(error as? ConfigError, .insecureScheme(host: "100.128.0.1"))
        }
        XCTAssertThrowsError(try ServerConfigStore.normalize("http://172.32.0.1")) { error in
            XCTAssertEqual(error as? ConfigError, .insecureScheme(host: "172.32.0.1"))
        }
    }

    func testNormalizeStripsTrailingSlash() throws {
        XCTAssertEqual(try ServerConfigStore.normalize("https://macmini.ts.net/").absoluteString, "https://macmini.ts.net")
        XCTAssertEqual(try ServerConfigStore.normalize("https://macmini.ts.net/base//").absoluteString, "https://macmini.ts.net/base")
        XCTAssertEqual(try ServerConfigStore.normalize("http://127.0.0.1:7777/").absoluteString, "http://127.0.0.1:7777")
    }

    func testNormalizeRejectsEmptyAndUnsupportedScheme() {
        XCTAssertThrowsError(try ServerConfigStore.normalize("   ")) { XCTAssertEqual($0 as? ConfigError, .emptyInput) }
        XCTAssertThrowsError(try ServerConfigStore.normalize("ftp://macmini")) { XCTAssertEqual($0 as? ConfigError, .unsupportedScheme("ftp")) }
        XCTAssertThrowsError(try ServerConfigStore.normalize("https://")) { XCTAssertEqual($0 as? ConfigError, .invalidURL) }
    }

    func testWsBaseURL() {
        let store = ServerConfigStore(defaults: makeDefaults())
        XCTAssertEqual(store.wsBaseURL(from: URL(string: "http://127.0.0.1:7777")!).absoluteString, "ws://127.0.0.1:7777")
        XCTAssertEqual(store.wsBaseURL(from: URL(string: "https://macmini.ts.net")!).absoluteString, "wss://macmini.ts.net")
        XCTAssertEqual(ServerConfigStore.wsBaseURL(from: URL(string: "wss://x")!).absoluteString, "wss://x")
    }

    func testSaveAndClearRoundTrip() throws {
        let defaults = makeDefaults()
        let store = ServerConfigStore(defaults: defaults)
        XCTAssertNil(store.config)

        let config = ServerConfig(baseURL: try ServerConfigStore.normalize("macmini.tail1234.ts.net"))
        store.save(config)
        XCTAssertEqual(store.config, config)
        XCTAssertNotNil(defaults.data(forKey: ServerConfigStore.defaultsKey))
        XCTAssertEqual(ServerConfigStore(defaults: defaults).config, config, "새 인스턴스가 저장값을 읽는다")

        store.clear()
        XCTAssertNil(store.config)
        XCTAssertNil(defaults.data(forKey: ServerConfigStore.defaultsKey))
        XCTAssertNil(ServerConfigStore(defaults: defaults).config)
    }

    private func makeDefaults() -> UserDefaults {
        let suite = "dev.mam.MacAgentTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        addTeardownBlock { UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite) }
        return defaults
    }
}
