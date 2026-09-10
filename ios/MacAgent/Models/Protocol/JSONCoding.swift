import Foundation

/// PROTOCOL.md 의 JSON 규칙을 적용한 공용 디코더·인코더.
/// - 키는 wire 와 같은 camelCase 를 그대로 쓴다(`keyDecodingStrategy` 변환 없음).
/// - 날짜는 ISO-8601 UTC 문자열. 소수점 초가 있어도(`2026-09-09T10:00:00.123Z`) 없어도 받는다.
/// - 인코딩은 소수점 초 포함 ISO-8601. 키 정렬은 하지 않는다.
enum JSONCoding {
    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let string = try container.decode(String.self)
            if let date = ISO8601.withFractionalSeconds.date(from: string)
                ?? ISO8601.withoutFractionalSeconds.date(from: string)
            {
                return date
            }
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "ISO-8601 날짜가 아니다: \(string)"
            )
        }
        return decoder
    }()

    static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(ISO8601.withFractionalSeconds.string(from: date))
        }
        return encoder
    }()

    /// `ISO8601DateFormatter` 는 스레드 안전하며(Foundation 문서), 옵션이 고정이므로 두 개를 공유한다.
    private enum ISO8601 {
        nonisolated(unsafe) static let withFractionalSeconds: ISO8601DateFormatter = {
            let f = ISO8601DateFormatter()
            f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return f
        }()

        nonisolated(unsafe) static let withoutFractionalSeconds: ISO8601DateFormatter = {
            let f = ISO8601DateFormatter()
            f.formatOptions = [.withInternetDateTime]
            return f
        }()
    }
}
