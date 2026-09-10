import Foundation
import XCTest
@testable import MacAgent

final class FormattersTests: XCTestCase {
    private let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }()

    /// 2026-09-10 12:00:00 UTC
    private let now = Date(timeIntervalSince1970: 1_789_041_600)

    private func relative(_ secondsAgo: TimeInterval) -> String {
        Formatters.relativeTime(now.addingTimeInterval(-secondsAgo), now: now, calendar: calendar)
    }

    func testRelativeTimeJustNow() {
        XCTAssertEqual(relative(0), "방금")
        XCTAssertEqual(relative(59), "방금")
        XCTAssertEqual(relative(-30), "방금", "시계 차이로 미래면 방금으로 본다")
    }

    func testRelativeTimeMinutesAndHours() {
        XCTAssertEqual(relative(60), "1분 전")
        XCTAssertEqual(relative(3 * 60 + 20), "3분 전")
        XCTAssertEqual(relative(59 * 60), "59분 전")
        XCTAssertEqual(relative(60 * 60), "1시간 전")
        XCTAssertEqual(relative(5 * 60 * 60), "5시간 전")
    }

    func testRelativeTimeYesterdayIsCalendarBased() {
        // 12:00 기준 13시간 전은 어제 23:00 이다.
        XCTAssertEqual(relative(13 * 60 * 60), "어제")
        XCTAssertEqual(relative(36 * 60 * 60), "어제")
        XCTAssertEqual(relative(2 * 24 * 60 * 60), "2일 전")
        XCTAssertEqual(relative(6 * 24 * 60 * 60), "6일 전")
    }

    func testRelativeTimeOlderShowsDate() {
        XCTAssertEqual(relative(7 * 24 * 60 * 60), "9월 3일")
        XCTAssertEqual(relative(400 * 24 * 60 * 60), "2025년 8월 6일")
    }

    func testAbbreviatedPathKeepsLastTwoComponents() {
        XCTAssertEqual(Formatters.abbreviatedPath("/Users/alice/work/app"), "work/app")
        XCTAssertEqual(Formatters.abbreviatedPath("/Users/alice/work/app/"), "work/app")
        XCTAssertEqual(Formatters.abbreviatedPath("/Users/alice"), "Users/alice")
        XCTAssertEqual(Formatters.abbreviatedPath("app"), "app")
        XCTAssertEqual(Formatters.abbreviatedPath("/"), "/")
        XCTAssertEqual(Formatters.abbreviatedPath(""), "")
    }
}
