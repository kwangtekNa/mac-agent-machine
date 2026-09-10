import UIKit

/// 햅틱 추상화. `TimelineModel` 이 주입받고, 테스트는 호출 횟수를 세는 가짜를 넣는다.
@MainActor
protocol HapticsProviding: AnyObject {
    func warning()
}

/// `UINotificationFeedbackGenerator` 기반 실제 햅틱.
@MainActor
final class SystemHaptics: HapticsProviding {
    func warning() { Haptics.warning() }
}

/// IOS.md 5.3: 승인 요청 도착 시 `.warning` 1회. 시뮬레이터에서는 울리지 않는다.
enum Haptics {
    @MainActor
    static func warning() {
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
    }
}
