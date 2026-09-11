import SwiftUI

/// 컨텍스트 게이지의 색 단계(IOS.md 9.3): 60% 미만 기본 tint, 60 이상 노랑, 85 이상 빨강.
/// 색 판정을 뷰에서 떼어 테스트한다.
enum UsageLevel: Equatable, Sendable {
    case normal, warning, critical

    static let warningThreshold = 60
    static let criticalThreshold = 85

    static func level(percent: Int) -> UsageLevel {
        if percent >= criticalThreshold { return .critical }
        if percent >= warningThreshold { return .warning }
        return .normal
    }

    static func tint(percent: Int) -> Color {
        level(percent: percent).tint
    }

    var tint: Color {
        switch self {
        case .normal: .accentColor
        case .warning: .yellow
        case .critical: .red
        }
    }
}

/// 구독 한도 창의 색은 서버가 판정한 `status` 를 그대로 따른다(클라이언트가 다시 계산하지 않는다).
extension UsageLimitStatus {
    var tint: Color {
        switch self {
        case .warning: .yellow
        case .exceeded: .red
        case .ok, .unknown: .accentColor
        }
    }

    /// "한도 도달" 캡션은 `exceeded` 에만 붙는다.
    var showsExceededCaption: Bool {
        self == .exceeded
    }
}
