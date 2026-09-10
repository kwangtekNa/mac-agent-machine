import Foundation

/// 서버 `language` 식별자(packages/server/src/fs/language.ts) → Highlightr 언어 이름. 모르는 값과 `plaintext` 는 nil(하이라이트 안 함).
enum HighlightrLanguage {
    static let mapping: [String: String] = [
        "typescript": "typescript",
        "javascript": "javascript",
        "swift": "swift",
        "python": "python",
        "ruby": "ruby",
        "go": "go",
        "rust": "rust",
        "java": "java",
        "kotlin": "kotlin",
        "c": "c",
        "cpp": "cpp",
        "objective-c": "objectivec",
        "shell": "bash",
        "json": "json",
        "yaml": "yaml",
        "toml": "ini",
        "markdown": "markdown",
        "html": "xml",
        "css": "css",
        "scss": "scss",
        "sql": "sql",
        "xml": "xml",
        "dockerfile": "dockerfile",
        "makefile": "makefile",
    ]

    static func name(for serverLanguage: String) -> String? {
        mapping[serverLanguage]
    }
}
