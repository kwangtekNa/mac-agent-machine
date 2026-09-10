import Foundation

/// 목록·카드에 쓰는 짧은 표시용 포맷터(IOS.md 5.5: 한국어, 짧게).
enum Formatters {
    /// 상대 시간. "방금", "3분 전", "5시간 전", "어제", "3일 전", 그 이상은 날짜("9월 3일", 해가 다르면 "2025년 8월 6일").
    /// 어제/N일 전은 달력 날짜 기준이다(12:00 에 어제 23:00 은 13시간 전이 아니라 "어제").
    static func relativeTime(_ date: Date, now: Date = .now, calendar: Calendar = .current) -> String {
        let seconds = now.timeIntervalSince(date)
        if seconds < 60 { return String(localized: "방금") }
        if seconds < 3600 { return String(localized: "\(Int(seconds / 60))분 전") }

        let dayDistance = calendar.dateComponents(
            [.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)
        ).day ?? 0
        if dayDistance <= 0 { return String(localized: "\(Int(seconds / 3600))시간 전") }
        if dayDistance == 1 { return String(localized: "어제") }
        if dayDistance < 7 { return String(localized: "\(dayDistance)일 전") }

        let components = calendar.dateComponents([.year, .month, .day], from: date)
        let month = components.month ?? 0
        let day = components.day ?? 0
        if components.year == calendar.component(.year, from: now) {
            return String(localized: "\(month)월 \(day)일")
        }
        // 연도는 자릿수 구분 없이(2,025 가 아니라 2025) 넣는다.
        let year = String(components.year ?? 0)
        return String(localized: "\(year)년 \(month)월 \(day)일")
    }

    /// 경로의 마지막 두 컴포넌트. `/Users/alice/work/app` → `work/app`. 컴포넌트가 없으면 원문.
    static func abbreviatedPath(_ path: String, components count: Int = 2) -> String {
        let parts = path.split(separator: "/", omittingEmptySubsequences: true)
        guard !parts.isEmpty else { return path }
        return parts.suffix(count).joined(separator: "/")
    }
}

extension Formatters {
    /// `500ms`, `12초`, `1분 30초`.
    static func duration(ms: Int) -> String {
        if ms < 1000 { return "\(ms)ms" }
        let totalSeconds = ms / 1000
        if totalSeconds < 60 { return String(localized: "\(totalSeconds)초") }
        return String(localized: "\(totalSeconds / 60)분 \(totalSeconds % 60)초")
    }

    /// `999`, `1.3k`, `12k`, `2.5M`.
    static func tokens(_ count: Int) -> String {
        if count < 1000 { return "\(count)" }
        if count < 1_000_000 { return compact(Double(count) / 1000) + "k" }
        return compact(Double(count) / 1_000_000) + "M"
    }

    /// `$0.12`. 1센트 미만이면 세 자리(`$0.001`).
    static func usd(_ value: Double) -> String {
        if value > 0, value < 0.01 { return String(format: "$%.3f", value) }
        return String(format: "$%.2f", value)
    }

    /// 카드 오른쪽 위 시각 `HH:mm`.
    static func clock(_ date: Date) -> String {
        date.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
    }

    private static func compact(_ value: Double) -> String {
        let rounded = (value * 10).rounded() / 10
        if rounded == rounded.rounded() { return String(Int(rounded)) }
        return String(format: "%.1f", rounded)
    }
}
