import Foundation
import XCTest
@testable import MacAgent

/// `SideRoomCardState.make(message:members:)`(순수): 그룹방에 남는 곁방 연결 카드의 문구(PROTOCOL.md 6.6).
final class SideRoomCardStateTests: XCTestCase {
    private var team: Team!
    private var minsu: TeamMember!
    private var jiyeon: TeamMember!
    private let sideRoomId = "room_01J8ZQ4K5N7P9R3S6T8V0W2XR3"

    override func setUpWithError() throws {
        try super.setUpWithError()
        team = try JSONCoding.decoder.decode(Team.self, from: FixtureLoader.data("rest/team.json"))
        minsu = team.members[0]
        jiyeon = team.members[1]
    }

    private func message(_ fixture: String, mutate: ((inout [String: Any]) -> Void)? = nil) throws -> RoomMessage {
        var json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: FixtureLoader.data("room-ws/\(fixture).json")) as? [String: Any]
        )
        if let mutate {
            var m = try XCTUnwrap(json["message"] as? [String: Any])
            mutate(&m)
            json["message"] = m
        }
        let event = try JSONCoding.decoder.decode(RoomEvent.self, from: JSONSerialization.data(withJSONObject: json))
        guard case .roomMessage(let e) = event else { throw XCTSkip("room.message 가 아니다") }
        return e.message
    }

    func testOpenedCard() throws {
        let state = try XCTUnwrap(SideRoomCardState.make(message: try message("room.message.side-opened"), members: team.members))

        XCTAssertEqual(state.title, "민수 ↔ 지연 곁방을 열었습니다")
        XCTAssertNil(state.detail)
        XCTAssertFalse(state.isClosed)
        XCTAssertEqual(state.roomId, sideRoomId)
        XCTAssertEqual(state.participants, [minsu, jiyeon])
    }

    func testClosedCardShowsMessageCountAndConclusion() throws {
        let state = try XCTUnwrap(SideRoomCardState.make(message: try message("room.message.side-closed"), members: team.members))

        XCTAssertEqual(state.title, "민수 ↔ 지연 곁방 대화 7건")
        XCTAssertEqual(state.detail, "린트 오류 3건을 고쳤습니다", "text 의 \"결론: \" 뒤 한 줄")
        XCTAssertTrue(state.isClosed)
        XCTAssertEqual(state.roomId, sideRoomId)
    }

    func testClosedWithoutConclusionHasNoDetail() throws {
        let message = try message("room.message.side-closed") { $0["text"] = "민수 ↔ 지연 곁방 대화 7건" }
        let state = try XCTUnwrap(SideRoomCardState.make(message: message, members: team.members))

        XCTAssertNil(state.detail)
        XCTAssertTrue(state.isClosed)
    }

    func testParticipantNamesComeFromMembersAndFallBackToGenericLabel() throws {
        let opened = try message("room.message.side-opened")
        let onlyMinsu = try XCTUnwrap(SideRoomCardState.make(message: opened, members: [minsu]))
        XCTAssertEqual(onlyMinsu.title, "민수 ↔ 팀원 곁방을 열었습니다", "모르는 참가자는 일반 이름")
        XCTAssertEqual(onlyMinsu.participants, [minsu], "아는 팀원만 아바타로 그린다")

        // 이름이 바뀐 팀원은 메시지 본문이 아니라 현재 팀원 목록을 따른다.
        var renamed = jiyeon!
        renamed.name = "지연2"
        let state = try XCTUnwrap(SideRoomCardState.make(message: opened, members: [minsu, renamed]))
        XCTAssertEqual(state.title, "민수 ↔ 지연2 곁방을 열었습니다")
    }

    func testMessageWithoutSideRoomIsNotACard() throws {
        XCTAssertNil(SideRoomCardState.make(message: try message("room.message.system"), members: team.members))
        XCTAssertNil(SideRoomCardState.make(message: try message("room.message.agent"), members: team.members))
    }

    func testUnknownSideRoomKindFallsBackToServerText() throws {
        let message = try message("room.message.side-opened") { m in
            var link = m["sideRoom"] as! [String: Any]
            link["kind"] = "paused"
            m["sideRoom"] = link
        }
        let state = try XCTUnwrap(SideRoomCardState.make(message: message, members: team.members))

        XCTAssertEqual(state.title, message.text, "모르는 kind 는 서버 문구를 그대로 보여준다")
        XCTAssertNil(state.detail)
        XCTAssertFalse(state.isClosed)
        XCTAssertEqual(state.roomId, sideRoomId, "그래도 곁방으로 들어갈 수 있다")
    }

    func testRoomEntryClassifiesSideRoomCard() throws {
        guard case .sideRoom = RoomEntry.make(try message("room.message.side-opened")) else {
            return XCTFail("sideRoom 이 있는 system 메시지는 .sideRoom")
        }
        guard case .sideRoom = RoomEntry.make(try message("room.message.side-closed")) else {
            return XCTFail("closed 도 .sideRoom")
        }
        guard case .system = RoomEntry.make(try message("room.message.system")) else {
            return XCTFail("sideRoom 이 없는 system 메시지는 기존처럼 .system")
        }
    }
}
