import Foundation
import XCTest
@testable import MacAgent

/// `PreviewLink`(순수): localhost 계열 링크 → 서버 호스트 변환, 포트 미리보기 URL, loopback 판별, 최근 포트 저장소.
final class PreviewLinkTests: XCTestCase {
    private let lan = URL(string: "http://192.168.0.14:7777")!
    private let tailnet = URL(string: "https://mac.tailnet.ts.net:7777")!

    // MARK: - rewrite

    func testRewritesLocalHostsKeepingSchemePortPathQuery() throws {
        let table: [(input: String, expected: String)] = [
            ("http://localhost:3000/a?b=1", "http://192.168.0.14:3000/a?b=1"),
            ("https://127.0.0.1:8443", "https://192.168.0.14:8443"),
            ("http://[::1]:5173", "http://192.168.0.14:5173"),
            ("http://0.0.0.0:3000", "http://192.168.0.14:3000"),
            // 포트가 없으면 붙이지 않는다(http 기본 80 유지). 서버 포트를 끌어오지 않는다.
            ("http://localhost", "http://192.168.0.14"),
            ("http://LocalHost:3000/", "http://192.168.0.14:3000/"),
        ]
        for row in table {
            let url = try XCTUnwrap(URL(string: row.input))
            XCTAssertEqual(PreviewLink.rewrite(url, serverURL: lan)?.absoluteString, row.expected, row.input)
        }
    }

    func testKeepsOriginalPortEvenWhenServerHasOne() throws {
        let url = try XCTUnwrap(URL(string: "http://localhost:3000/a?b=1"))
        XCTAssertEqual(
            PreviewLink.rewrite(url, serverURL: tailnet)?.absoluteString,
            "http://mac.tailnet.ts.net:3000/a?b=1",
            "호스트만 바꾸고 포트·스킴·경로·쿼리는 원본 것"
        )
    }

    func testLeavesOtherURLsToTheSystem() throws {
        for input in [
            "https://example.com",
            "http://example.com:3000/",
            "https://192.168.0.14:3000",
            "ftp://localhost:3000",
            "mailto:alice@example.com",
            "file:///Users/alice/work/app/README.md",
        ] {
            let url = try XCTUnwrap(URL(string: input))
            XCTAssertNil(PreviewLink.rewrite(url, serverURL: lan), input)
        }
    }

    func testRewriteNeedsServerHost() throws {
        let url = try XCTUnwrap(URL(string: "http://localhost:3000/"))
        XCTAssertNil(PreviewLink.rewrite(url, serverURL: URL(string: "file:///tmp")!))
    }

    // MARK: - previewURL

    func testPreviewURLIsHttpRootOnServerHost() {
        XCTAssertEqual(PreviewLink.previewURL(port: 5173, serverURL: tailnet).absoluteString, "http://mac.tailnet.ts.net:5173/")
        XCTAssertEqual(PreviewLink.previewURL(port: 3000, serverURL: lan).absoluteString, "http://192.168.0.14:3000/")
    }

    // MARK: - isMacOnly

    func testIsMacOnlyOnlyForLoopbackAddresses() {
        func port(_ address: String) -> NetPort {
            NetPort(port: 3000, pid: 4821, process: "node", address: address)
        }
        XCTAssertTrue(PreviewLink.isMacOnly(port("127.0.0.1")))
        XCTAssertTrue(PreviewLink.isMacOnly(port("::1")))
        XCTAssertTrue(PreviewLink.isMacOnly(port("[::1]")))
        XCTAssertFalse(PreviewLink.isMacOnly(port("*")))
        XCTAssertFalse(PreviewLink.isMacOnly(port("0.0.0.0")))
        XCTAssertFalse(PreviewLink.isMacOnly(port("192.168.0.14")))
    }

    // MARK: - RecentPortsStore

    func testRecentPortsAreMostRecentFirstDedupedAndCapped() throws {
        let suiteName = "PreviewLinkTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let store = RecentPortsStore(defaults: defaults)
        XCTAssertTrue(store.ports.isEmpty)

        for port in [3000, 5173, 8080] { store.add(port) }
        XCTAssertEqual(store.ports, [8080, 5173, 3000], "최근 순")

        store.add(3000)
        XCTAssertEqual(store.ports, [3000, 8080, 5173], "이미 있으면 맨 앞으로 옮긴다")

        for port in [4000, 4001, 4002] { store.add(port) }
        XCTAssertEqual(store.ports, [4002, 4001, 4000, 3000, 8080], "최대 5개")
        XCTAssertEqual(store.ports.count, RecentPortsStore.limit)

        XCTAssertEqual(RecentPortsStore(defaults: defaults).ports, store.ports, "새 인스턴스가 UserDefaults 에서 그대로 읽는다")

        store.add(70000)
        XCTAssertEqual(store.ports, [4002, 4001, 4000, 3000, 8080], "범위 밖 포트는 저장하지 않는다")
    }
}
