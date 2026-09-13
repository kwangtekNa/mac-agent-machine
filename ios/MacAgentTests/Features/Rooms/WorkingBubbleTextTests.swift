import Foundation
import XCTest
@testable import MacAgent

/// 임시 말풍선(`WorkingBubbleText`)과 컴포저 위 상태 줄(`RoomStatusLine.text`) 문구.
final class WorkingBubbleTextTests: XCTestCase {
    func testSingleWorkingMemberUsesSubjectParticle() {
        XCTAssertEqual(WorkingBubbleText.text(names: ["지연"], activity: .working), "지연이 작업 중…")
        XCTAssertEqual(WorkingBubbleText.text(names: ["민수"], activity: .working), "민수가 작업 중…")
        XCTAssertEqual(WorkingBubbleText.text(names: ["Alice"], activity: .working), "Alice가 작업 중…", "한글이 아니면 가")
    }

    func testMultipleWorkingMembers() {
        XCTAssertEqual(WorkingBubbleText.text(names: ["지연", "민수"], activity: .working), "지연, 민수가 작업 중…")
        XCTAssertEqual(WorkingBubbleText.text(names: ["민수", "지연"], activity: .working), "민수, 지연이 작업 중…", "조사는 마지막 이름 기준")
    }

    func testQueuedMembers() {
        XCTAssertEqual(WorkingBubbleText.text(names: ["민수"], activity: .queued), "민수가 대기 중…")
        XCTAssertEqual(WorkingBubbleText.text(names: ["지연", "민수"], activity: .queued), "지연, 민수가 대기 중…")
    }

    func testEmptyIsNil() {
        XCTAssertNil(WorkingBubbleText.text(names: [], activity: .working))
        XCTAssertNil(WorkingBubbleText.text(names: [], activity: .queued))
    }

    func testKoreanSubjectParticle() {
        XCTAssertEqual(KoreanParticle.subject(after: "지연"), "이")
        XCTAssertEqual(KoreanParticle.subject(after: "민수"), "가")
        XCTAssertEqual(KoreanParticle.subject(after: ""), "가")
    }

    func testStatusLine() {
        XCTAssertEqual(RoomStatusLine.text(working: ["지연"], queued: ["민수"]), "지연 작업 중 · 민수 대기 중")
        XCTAssertEqual(RoomStatusLine.text(working: ["지연", "민수"], queued: []), "지연, 민수 작업 중")
        XCTAssertEqual(RoomStatusLine.text(working: [], queued: ["민수"]), "민수 대기 중")
        XCTAssertNil(RoomStatusLine.text(working: [], queued: []))
    }
}
