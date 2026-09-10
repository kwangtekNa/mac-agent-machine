import Foundation
import XCTest

/// 테스트 번들에 폴더 참조로 복사된 `fixtures/`(= packages/protocol/fixtures) 접근.
enum FixtureLoader {
    private final class BundleMarker {}

    /// 번들 안 `fixtures/` 디렉토리 URL.
    static func root() throws -> URL {
        try XCTUnwrap(
            Bundle(for: BundleMarker.self).url(forResource: "fixtures", withExtension: nil),
            "테스트 번들 안에 fixtures/ 폴더 참조가 없다"
        )
    }

    /// `rest/me.json` 같은 상대 경로로 파일 내용을 읽는다.
    static func data(_ relativePath: String) throws -> Data {
        try Data(contentsOf: root().appending(path: relativePath))
    }

    /// `fixtures/` 아래 모든 `.json` 을 재귀 열거해 정렬된 상대 경로(`ws/pong.json`)로 돌려준다.
    static func allJSONPaths() throws -> [String] {
        let root = try root()
        let rootPath = root.standardizedFileURL.path
        guard let enumerator = FileManager.default.enumerator(
            at: root,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else {
            throw XCTSkip("fixtures/ 를 열거할 수 없다")
        }
        var paths: [String] = []
        for case let url as URL in enumerator where url.pathExtension == "json" {
            let full = url.standardizedFileURL.path
            guard full.hasPrefix(rootPath + "/") else { continue }
            paths.append(String(full.dropFirst(rootPath.count + 1)))
        }
        return paths.sorted()
    }
}
