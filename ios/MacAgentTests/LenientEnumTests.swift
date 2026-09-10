import Foundation
import XCTest
@testable import MacAgent

/// PROTOCOL.md 0절: 모르는 키·값은 무시하되 판별자(`kind`, `type`)가 모르는 값이면 실패한다.
final class LenientEnumTests: XCTestCase {
    /// fixture 를 딕셔너리로 읽어 일부만 바꾼 뒤 다시 직렬화한다.
    private func mutatedFixture(_ path: String, _ mutate: (inout [String: Any]) -> Void) throws -> Data {
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: FixtureLoader.data(path)) as? [String: Any])
        mutate(&json)
        return try JSONSerialization.data(withJSONObject: json)
    }

    private func setNested(_ json: inout [String: Any], _ keyPath: [String], _ value: Any?) {
        guard let first = keyPath.first else { return }
        if keyPath.count == 1 {
            if let value { json[first] = value } else { json.removeValue(forKey: first) }
            return
        }
        var child = json[first] as? [String: Any] ?? [:]
        setNested(&child, Array(keyPath.dropFirst()), value)
        json[first] = child
    }

    // MARK: - lenient 열거형

    func testUnknownToolDecodesAsUnknown() throws {
        let data = try mutatedFixture("ws/item.started.tool_call.json") { json in
            self.setNested(&json, ["item", "payload", "tool"], "quantum_compute")
        }
        let event = try JSONCoding.decoder.decode(ServerEvent.self, from: data)
        guard case .itemStarted(let e) = event, case .toolCall(let payload) = e.item.payload else {
            return XCTFail("tool_call 이 아니다")
        }
        XCTAssertEqual(payload.tool, .unknown)
    }

    func testUnknownSessionStatusAndModeDecodeAsUnknown() throws {
        let data = try mutatedFixture("rest/session.json") { json in
            json["status"] = "hibernating"
            json["mode"] = "yolo"
            json["agent"] = "gemini"
        }
        let session = try JSONCoding.decoder.decode(Session.self, from: data)
        XCTAssertEqual(session.status, .unknown)
        XCTAssertEqual(session.mode, .unknown)
        XCTAssertEqual(session.agent, .unknown)
    }

    func testUnknownErrorCodeAndGitStatusDecodeAsUnknown() throws {
        let errorData = try mutatedFixture("rest/error.json") { json in
            self.setNested(&json, ["error", "code"], "teapot")
        }
        XCTAssertEqual(try JSONCoding.decoder.decode(ErrorResponse.self, from: errorData).error.code, .unknown)

        let listData = try mutatedFixture("rest/fs-list.json") { json in
            var entries = json["entries"] as? [[String: Any]] ?? []
            entries[0]["gitStatus"] = "C"
            entries[0]["type"] = "socket"
            json["entries"] = entries
        }
        let list = try JSONCoding.decoder.decode(FsListResponse.self, from: listData)
        XCTAssertEqual(list.entries[0].gitStatus, .unknown)
        XCTAssertEqual(list.entries[0].type, .unknown)
    }

    func testLenientEnumEncodesRawValue() throws {
        let data = try JSONCoding.encoder.encode([SessionMode.autoEdit, .fullAuto, .unknown])
        let raw = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String])
        XCTAssertEqual(raw, ["auto-edit", "full-auto", "unknown"])
    }

    // MARK: - 엄격한 판별자

    func testUnknownItemKindThrows() throws {
        let data = try mutatedFixture("ws/item.started.system.json") { json in
            self.setNested(&json, ["item", "kind"], "hologram")
        }
        XCTAssertThrowsError(try JSONCoding.decoder.decode(ServerEvent.self, from: data)) { error in
            XCTAssertTrue(error is DecodingError, "\(error)")
        }
        let itemData = try mutatedFixture("rest/session-detail.json") { json in
            var items = json["items"] as? [[String: Any]] ?? []
            items[0]["kind"] = "hologram"
            json["items"] = items
        }
        XCTAssertThrowsError(try JSONCoding.decoder.decode(SessionDetailResponse.self, from: itemData))
    }

    func testUnknownServerEventTypeThrows() throws {
        let data = try mutatedFixture("ws/pong.json") { json in
            json["type"] = "session.teleported"
        }
        XCTAssertThrowsError(try JSONCoding.decoder.decode(ServerEvent.self, from: data)) { error in
            XCTAssertTrue(error is DecodingError, "\(error)")
        }
    }

    func testUnknownClientMessageTypeThrows() throws {
        let data = try mutatedFixture("client/ping.json") { json in
            json["type"] = "turn.rewind"
        }
        XCTAssertThrowsError(try JSONCoding.decoder.decode(ClientMessage.self, from: data)) { error in
            XCTAssertTrue(error is DecodingError, "\(error)")
        }
    }

    // MARK: - null 과 키 누락

    func testNullAndMissingBothDecodeAsNil() throws {
        // Session.model / nativeId / preview: null
        let withNull = try mutatedFixture("rest/session.json") { json in
            json["model"] = NSNull()
            json["nativeId"] = NSNull()
            json["preview"] = NSNull()
        }
        let a = try JSONCoding.decoder.decode(Session.self, from: withNull)
        XCTAssertNil(a.model)
        XCTAssertNil(a.nativeId)
        XCTAssertNil(a.preview)

        // 같은 필드의 키 자체가 없음
        let withoutKeys = try mutatedFixture("rest/session.json") { json in
            json.removeValue(forKey: "model")
            json.removeValue(forKey: "nativeId")
            json.removeValue(forKey: "preview")
        }
        let b = try JSONCoding.decoder.decode(Session.self, from: withoutKeys)
        XCTAssertNil(b.model)
        XCTAssertNil(b.nativeId)
        XCTAssertNil(b.preview)

        // TimelineItem.turnId / completedAt, tool_call.exitCode, Approval.detail / diff
        let itemNull = try mutatedFixture("ws/item.completed.tool_call.json") { json in
            self.setNested(&json, ["item", "turnId"], NSNull())
            self.setNested(&json, ["item", "completedAt"], NSNull())
            self.setNested(&json, ["item", "payload", "exitCode"], NSNull())
        }
        guard case .itemCompleted(let e1) = try JSONCoding.decoder.decode(ServerEvent.self, from: itemNull),
              case .toolCall(let p1) = e1.item.payload
        else { return XCTFail("tool_call 이 아니다") }
        XCTAssertNil(e1.item.turnId)
        XCTAssertNil(e1.item.completedAt)
        XCTAssertNil(p1.exitCode)

        let itemMissing = try mutatedFixture("ws/item.completed.tool_call.json") { json in
            self.setNested(&json, ["item", "turnId"], nil)
            self.setNested(&json, ["item", "completedAt"], nil)
            self.setNested(&json, ["item", "payload", "exitCode"], nil)
        }
        guard case .itemCompleted(let e2) = try JSONCoding.decoder.decode(ServerEvent.self, from: itemMissing),
              case .toolCall(let p2) = e2.item.payload
        else { return XCTFail("tool_call 이 아니다") }
        XCTAssertNil(e2.item.turnId)
        XCTAssertNil(e2.item.completedAt)
        XCTAssertNil(p2.exitCode)

        let approvalMissing = try mutatedFixture("ws/approval.requested.command.json") { json in
            self.setNested(&json, ["approval", "detail"], nil)
            self.setNested(&json, ["approval", "diff"], nil)
        }
        guard case .approvalRequested(let e3) = try JSONCoding.decoder.decode(ServerEvent.self, from: approvalMissing)
        else { return XCTFail("approval.requested 가 아니다") }
        XCTAssertNil(e3.approval.detail)
        XCTAssertNil(e3.approval.diff)
    }

    func testOptionalKeysMayBeAbsent() throws {
        // session.status 의 reason?, turn.completed 의 costUsd? / usage.cacheReadTokens?
        let status = try mutatedFixture("ws/session.status.json") { json in
            json.removeValue(forKey: "reason")
        }
        guard case .sessionStatus(let s) = try JSONCoding.decoder.decode(ServerEvent.self, from: status)
        else { return XCTFail("session.status 가 아니다") }
        XCTAssertNil(s.reason)

        let turn = try mutatedFixture("ws/turn.completed.json") { json in
            json.removeValue(forKey: "costUsd")
            self.setNested(&json, ["usage", "cacheReadTokens"], nil)
        }
        guard case .turnCompleted(let t) = try JSONCoding.decoder.decode(ServerEvent.self, from: turn)
        else { return XCTFail("turn.completed 가 아니다") }
        XCTAssertNil(t.costUsd)
        XCTAssertNil(t.usage.cacheReadTokens)
    }

    // MARK: - 알 수 없는 키와 날짜

    func testUnknownKeysAreIgnored() throws {
        let data = try mutatedFixture("ws/item.delta.json") { json in
            json["futureField"] = ["nested": true]
            json["anotherOne"] = 42
        }
        guard case .itemDelta(let e) = try JSONCoding.decoder.decode(ServerEvent.self, from: data)
        else { return XCTFail("item.delta 가 아니다") }
        XCTAssertEqual(e.field, .text)
        XCTAssertEqual(e.delta, "`src/login.ts`에 만료 검사를 ")
    }

    func testDatesWithAndWithoutFractionalSeconds() throws {
        let fractional = try mutatedFixture("ws/pong.json") { json in
            json["ts"] = "2026-09-09T10:11:32.250Z"
        }
        let plain = try mutatedFixture("ws/pong.json") { json in
            json["ts"] = "2026-09-09T10:11:32Z"
        }
        let a = try JSONCoding.decoder.decode(ServerEvent.self, from: fractional).ts
        let b = try JSONCoding.decoder.decode(ServerEvent.self, from: plain).ts
        XCTAssertEqual(a.timeIntervalSince(b), 0.25, accuracy: 0.001)

        let bad = try mutatedFixture("ws/pong.json") { json in
            json["ts"] = "yesterday"
        }
        XCTAssertThrowsError(try JSONCoding.decoder.decode(ServerEvent.self, from: bad))

        // 인코더는 소수점 초를 포함한 ISO-8601 을 쓴다
        let encoded = try JSONCoding.encoder.encode(["at": a])
        let raw = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: String])
        XCTAssertEqual(raw["at"], "2026-09-09T10:11:32.250Z")
    }
}
