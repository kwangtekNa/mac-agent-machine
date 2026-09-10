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
