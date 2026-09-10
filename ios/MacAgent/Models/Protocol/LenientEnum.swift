import Foundation

/// 판별자가 아닌 문자열 열거형의 공통 규약. 서버가 새 값을 추가해도 구 앱이 크래시하지 않도록
/// 모르는 문자열은 `.unknown` 으로 디코드한다(PROTOCOL.md 0절 "알 수 없는 키"의 값 버전).
/// 인코딩은 `rawValue` 그대로다.
protocol LenientRawEnum: RawRepresentable, Codable, CaseIterable, Hashable, Sendable
where RawValue == String {
    static var unknown: Self { get }
}

extension LenientRawEnum {
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let raw = try container.decode(String.self)
        self = Self(rawValue: raw) ?? Self.unknown
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}
