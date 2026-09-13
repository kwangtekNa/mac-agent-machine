import Foundation

/// 방 메시지 `@멘션` 파서(순수). 서버 `teams/mentions.ts`(PROTOCOL.md 6.4)와 같은 규칙:
/// `@` 뒤의 글자·숫자·`_`·`.`·`-` 가 토큰, 끝 문장부호는 버리고, NFC·소문자로 이름·핸들과 비교한다. `@all` 은 전원.
/// 모르는 토큰은 무시한다(서버가 `room.error` 로 알린다). 컴포저 자동완성(`suggestions`/`apply`)도 여기서 맡는다.
struct MentionParser {
    /// NFC + 소문자 + trim. 서버 `normalizeName` 과 같다.
    static func normalize(_ s: String) -> String {
        s.precomposedStringWithCanonicalMapping.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// 본문의 멘션을 팀원 id 로 해석한다(처음 나온 순서, 중복 없음). `@all` 이면 전원.
    static func mentions(in text: String, members: [TeamMember]) -> (memberIds: [String], all: Bool) {
        var byKey: [String: String] = [:]
        for member in members {
            byKey[normalize(member.handle)] = member.id
            byKey[normalize(member.name)] = member.id
        }
        var memberIds: [String] = []
        var all = false
        for token in tokens(in: text) {
            let key = normalize(token)
            if key == "all" {
                all = true
                continue
            }
            if let id = byKey[key], !memberIds.contains(id) { memberIds.append(id) }
        }
        if all {
            for member in members where !memberIds.contains(member.id) { memberIds.append(member.id) }
        }
        return (memberIds, all)
    }

    /// 컴포저 자동완성: 텍스트 끝의 `@토큰`(공백 없음, `@` 앞은 시작 또는 공백)이 있으면 그 접두어와
    /// 이름·핸들이 맞는 팀원(대소문자 무시). 맞는 팀원이 없거나 토큰이 끝났으면 nil.
    static func suggestions(for text: String, members: [TeamMember]) -> (token: Range<String.Index>, members: [TeamMember])? {
        guard let at = text.lastIndex(of: "@") else { return nil }
        let after = text[text.index(after: at)...]
        guard !after.contains(where: { $0.isWhitespace || $0.isNewline }) else { return nil }
        if at > text.startIndex {
            let before = text[text.index(before: at)]
            guard before.isWhitespace || before.isNewline else { return nil }
        }
        let prefix = normalize(String(after))
        let matches = members.filter {
            normalize($0.name).hasPrefix(prefix) || normalize($0.handle).hasPrefix(prefix)
        }
        guard !matches.isEmpty else { return nil }
        return (at..<text.endIndex, matches)
    }

    /// 제안 적용: 토큰을 `@이름 ` 으로 바꾼 텍스트.
    static func apply(_ member: TeamMember, to text: String, token: Range<String.Index>) -> String {
        text.replacingCharacters(in: token, with: "@\(member.name) ")
    }

    /// 팀원(이름·핸들)도 `all` 도 아닌 `@토큰`(원문, 처음 나온 순서, 중복 없음). 컴포저 캡션 "모르는 팀원 @xxx 는 무시됩니다" 의 재료.
    /// `ignoringTrailing` 이면 텍스트 끝까지 이어져 아직 입력 중인 토큰은 뺀다(공백을 치면 확정).
    static func unknownTokens(in text: String, members: [TeamMember], ignoringTrailing: Bool = true) -> [String] {
        var known: Set<String> = ["all"]
        for member in members {
            known.insert(normalize(member.handle))
            known.insert(normalize(member.name))
        }
        var result: [String] = []
        for span in tokenSpans(in: text) {
            if ignoringTrailing, span.end == text.endIndex { continue }
            let key = normalize(span.token)
            if known.contains(key) || result.contains(span.token) { continue }
            result.append(span.token)
        }
        return result
    }

    // MARK: - 토큰

    private static let trailingPunctuation: Set<Character> = [".", ",", "!", "?", ":", ";", ")", "]", "}", "\"", "'"]

    private static func isTokenCharacter(_ c: Character) -> Bool {
        c.isLetter || c.isNumber || c == "_" || c == "." || c == "-"
    }

    /// `@` 뒤의 토큰(끝 문장부호 제거, 빈 토큰 제외). 서버 `MENTION_RE` 와 같은 문자 집합.
    private static func tokens(in text: String) -> [String] {
        tokenSpans(in: text).map(\.token)
    }

    /// 토큰과 원문에서 토큰 문자가 끝난 위치(문장부호 제거 전).
    private static func tokenSpans(in text: String) -> [(token: String, end: String.Index)] {
        var result: [(token: String, end: String.Index)] = []
        var index = text.startIndex
        while index < text.endIndex {
            guard text[index] == "@" else {
                index = text.index(after: index)
                continue
            }
            var end = text.index(after: index)
            while end < text.endIndex, isTokenCharacter(text[end]) { end = text.index(after: end) }
            var token = Substring(text[text.index(after: index)..<end])
            while let last = token.last, trailingPunctuation.contains(last) { token.removeLast() }
            if !token.isEmpty { result.append((String(token), end)) }
            index = end
        }
        return result
    }
}
