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

extension FormattersTests {
    func testDuration() {
        XCTAssertEqual(Formatters.duration(ms: 500), "500ms")
        XCTAssertEqual(Formatters.duration(ms: 1234), "1초")
        XCTAssertEqual(Formatters.duration(ms: 30412), "30초")
        XCTAssertEqual(Formatters.duration(ms: 90_000), "1분 30초")
        XCTAssertEqual(Formatters.duration(ms: 0), "0ms")
    }

    func testTokens() {
        XCTAssertEqual(Formatters.tokens(999), "999")
        XCTAssertEqual(Formatters.tokens(1275), "1.3k")
        XCTAssertEqual(Formatters.tokens(12_000), "12k")
        XCTAssertEqual(Formatters.tokens(19_695), "19.7k")
        XCTAssertEqual(Formatters.tokens(2_500_000), "2.5M")
    }

    func testUsd() {
        XCTAssertEqual(Formatters.usd(0.12), "$0.12")
        XCTAssertEqual(Formatters.usd(0.001), "$0.001")
        XCTAssertEqual(Formatters.usd(1.5), "$1.50")
        XCTAssertEqual(Formatters.usd(0), "$0.00")
    }
}

/// 2026-09-10 추가분(IOS.md 9.3): 컨텍스트 부제·시트 표기, 구독 한도 초기화 상대 시간.
extension FormattersTests {
    func testContextLineAndDetail() {
        XCTAssertEqual(Formatters.contextLine(tokens: 42_000, window: 200_000, percent: 21), "컨텍스트 21% · 42k/200k")
        XCTAssertEqual(Formatters.contextLine(tokens: 4_200, window: 1_000_000, percent: 0), "컨텍스트 0% · 4.2k/1M")
        XCTAssertEqual(Formatters.contextDetail(tokens: 42_000, window: 200_000, percent: 21), "42k / 200k (21%)")
    }

    func testResetLineRelativeFuture() {
        func reset(_ percent: Int, _ secondsAhead: TimeInterval?) -> String {
            Formatters.resetLine(
                usedPercent: percent, resetsAt: secondsAhead.map { now.addingTimeInterval($0) }, now: now, calendar: calendar
            )
        }
        XCTAssertEqual(reset(42, 3 * 60 * 60), "42% · 3시간 후 초기화")
        XCTAssertEqual(reset(42, 25 * 60), "42% · 25분 후 초기화")
        XCTAssertEqual(reset(42, 21 * 60 * 60), "42% · 내일 09:00 초기화", "12:00 기준 21시간 뒤는 내일 09:00")
        XCTAssertEqual(reset(81, 4 * 24 * 60 * 60), "81% · 9월 14일 12:00 초기화")
        XCTAssertEqual(reset(100, -60), "100% · 곧 초기화", "이미 지난 시각은 곧")
        XCTAssertEqual(reset(42, nil), "42%", "resetsAt 이 없으면 백분율만")
    }

    func testClockWithCalendar() {
        XCTAssertEqual(Formatters.clock(now, calendar: calendar), "12:00")
        XCTAssertEqual(Formatters.clock(now.addingTimeInterval(-3 * 60 * 60 - 20 * 60), calendar: calendar), "08:40")
    }
}
