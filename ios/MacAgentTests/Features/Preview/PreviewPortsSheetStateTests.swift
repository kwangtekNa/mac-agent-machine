import Foundation
import XCTest
@testable import MacAgent

/// `PreviewPortsState`(순수): 행 정렬·제목, loopback 캡션, 빈 목록 문구, 직접 입력 포트 검증.
final class PreviewPortsSheetStateTests: XCTestCase {
    private func fixturePorts() throws -> [NetPort] {
        try JSONCoding.decoder.decode(NetPortsResponse.self, from: FixtureLoader.data("rest/net-ports.json")).ports
    }

    func testRowsAreSortedByPortWithTitleAndIdentifier() throws {
        let state = PreviewPortsState.make(ports: [
            NetPort(port: 8080, pid: 5120, process: "python3", address: "*"),
            NetPort(port: 3000, pid: 4821, process: "node", address: "*"),
        ])
        XCTAssertEqual(state.rows.map(\.port), [3000, 8080], "port 오름차순")
        XCTAssertEqual(state.rows.map(\.title), ["3000 · node", "8080 · python3"])
        XCTAssertEqual(state.rows.map(\.identifier), ["preview.port.3000", "preview.port.8080"])
        XCTAssertFalse(state.isEmpty)
    }

    func testLoopbackRowsGetMacOnlyCaption() throws {
        let state = PreviewPortsState.make(ports: try fixturePorts())
        XCTAssertEqual(state.rows.map(\.port), [3000, 5173, 8080])
        XCTAssertEqual(
            state.rows.map(\.caption),
            [nil, PreviewPortsState.macOnlyCaption, nil],
            "address 가 127.0.0.1 인 5173 만 캡션이 붙는다"
        )
        XCTAssertEqual(PreviewPortsState.macOnlyCaption, "Mac 안에서만 열림 — 폰에서 안 열릴 수 있습니다")
    }

    func testDuplicatePortsCollapseAndPreferReachableAddress() {
        let state = PreviewPortsState.make(ports: [
            NetPort(port: 3000, pid: 4821, process: "node", address: "::1"),
            NetPort(port: 3000, pid: 4821, process: "node", address: "*"),
        ])
        XCTAssertEqual(state.rows.count, 1)
        XCTAssertNil(state.rows[0].caption, "같은 포트가 겹치면 폰에서 열리는 쪽을 남긴다")
    }

    func testEmptyListMessage() {
        let state = PreviewPortsState.make(ports: [])
        XCTAssertTrue(state.isEmpty)
        XCTAssertTrue(state.rows.isEmpty)
        XCTAssertEqual(PreviewPortsState.emptyMessage, "열린 포트가 없습니다. 에이전트에게 개발 서버를 띄워 달라고 하세요.")
    }

    func testParsePortAcceptsOnlyValidPorts() {
        XCTAssertEqual(PreviewPortsState.parsePort("3000"), 3000)
        XCTAssertEqual(PreviewPortsState.parsePort(" 8080 "), 8080)
        XCTAssertEqual(PreviewPortsState.parsePort("65535"), 65535)
        for text in ["", "0", "70000", "-1", "abc", "30 00", "3000.5"] {
            XCTAssertNil(PreviewPortsState.parsePort(text), text)
        }
    }
}
