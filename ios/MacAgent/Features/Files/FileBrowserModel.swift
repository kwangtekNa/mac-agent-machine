import Foundation
import SwiftUI

/// 세션 cwd 를 루트로 하는 읽기 전용 파일 브라우저 상태(IOS.md 4절 파일 시트).
/// 경로 검증은 서버 책임이다. 앱은 경로를 만들거나 다듬지 않고 서버가 준 `path` 를 그대로 되돌려 보낸다.
/// 목록 캐시는 메모리에만 둔다.
@MainActor @Observable
final class FileBrowserModel {
    struct Directory: Identifiable, Hashable {
        let path: String
        var listing: FsListResponse?
        var error: String?

        init(path: String, listing: FsListResponse? = nil, error: String? = nil) {
            self.path = path
            self.listing = listing
            self.error = error
        }

        var id: String { path }
        var isLoading: Bool { listing == nil && error == nil }
        var name: String { (path as NSString).lastPathComponent }

        /// NavigationStack 경로 요소의 정체성은 path 로만 정한다. listing 이 채워져도 같은 화면으로 남는다.
        static func == (lhs: Self, rhs: Self) -> Bool { lhs.path == rhs.path }
        func hash(into hasher: inout Hasher) { hasher.combine(path) }
    }

    static let showHiddenKey = "mam.files.showHidden"

    let client: APIClient
    /// 세션 cwd. 이 위로는 올라가지 않는다.
    let rootPath: String
    private(set) var root: Directory
    /// NavigationStack path. 루트는 포함하지 않는다.
    var stack: [Directory] = []
    /// 열려 있는 파일. 시트를 닫고 다시 열어도 유지된다.
    var selectedFile: FsEntry?
    private(set) var showHidden: Bool

    @ObservationIgnored private var cache: [String: FsListResponse] = [:]
    @ObservationIgnored private let defaults: UserDefaults

    init(client: APIClient, rootPath: String, defaults: UserDefaults = .standard) {
        self.client = client
        self.rootPath = rootPath
        self.root = Directory(path: rootPath)
        self.defaults = defaults
        self.showHidden = defaults.bool(forKey: Self.showHiddenKey)
    }

    /// 루트 목록이 준 값. 하위 디렉토리도 같은 리포 안이다.
    var isGitRepo: Bool { root.listing?.isGitRepo ?? false }

    func directory(for path: String) -> Directory? {
        if path == rootPath { return root }
        return stack.first { $0.path == path }
    }

    /// 캐시가 있으면 먼저 보여주고 서버에서 다시 읽는다. 실패하면 캐시된 목록은 유지하고 오류만 기록한다.
    func load(_ path: String) async {
        if let cached = cache[path] {
            update(path) { $0.listing = cached }
        }
        do {
            let listing = try await client.listDirectory(path: path)
            cache[path] = listing
            update(path) {
                $0.listing = listing
                $0.error = nil
            }
        } catch {
            let message = ErrorMessages.fileAccessMessage(for: error)
            update(path) { $0.error = message }
        }
    }

    func push(_ path: String) {
        guard stack.last?.path != path else { return }
        stack.append(Directory(path: path, listing: cache[path]))
    }

    func pop() {
        guard !stack.isEmpty else { return }
        stack.removeLast()
    }

    func toggleShowHidden() {
        showHidden.toggle()
        defaults.set(showHidden, forKey: Self.showHiddenKey)
    }

    /// 숨김 필터만 적용한다. 정렬은 서버(디렉토리 먼저, 이름순)를 그대로 따른다.
    func visibleEntries(of dir: Directory) -> [FsEntry] {
        guard let entries = dir.listing?.entries else { return [] }
        return showHidden ? entries : entries.filter { !$0.isHidden }
    }

    private func update(_ path: String, _ change: (inout Directory) -> Void) {
        if path == rootPath {
            change(&root)
        } else if let index = stack.firstIndex(where: { $0.path == path }) {
            change(&stack[index])
        }
    }
}

/// git 상태 한 글자 배지(IOS.md 5.4: 색은 항상 글자와 함께).
enum GitBadge {
    static func style(_ code: GitStatusCode?) -> (text: String, color: Color)? {
        switch code {
        case .modified: return ("M", .orange)
        case .added: return ("A", .green)
        case .deleted: return ("D", .red)
        case .renamed: return ("R", .teal)
        case .untracked: return ("?", .gray)
        case .ignored: return ("!", .secondary)
        case .unknown, nil: return nil
        }
    }
}

/// 항목 종류·확장자 → SF Symbol.
enum FileIcon {
    static let codeExtensions: Set<String> = [
        "ts", "tsx", "mts", "cts", "js", "mjs", "cjs", "jsx", "swift", "py", "rb", "go", "rs", "java", "kt", "kts",
        "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "m", "mm", "sh", "zsh", "bash", "json", "jsonc", "yaml", "yml",
        "toml", "html", "htm", "css", "scss", "sql", "xml", "plist", "mk",
    ]
    static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "heic", "svg"]
    static let markdownExtensions: Set<String> = ["md", "markdown"]

    static func symbol(name: String, type: FsEntryType) -> String {
        switch type {
        case .dir: return "folder.fill"
        case .symlink: return "link"
        case .other, .unknown: return "questionmark.folder"
        case .file:
            let ext = (name as NSString).pathExtension.lowercased()
            if imageExtensions.contains(ext) { return "photo" }
            if markdownExtensions.contains(ext) { return "doc.richtext" }
            if codeExtensions.contains(ext) { return "doc.text" }
            return "doc"
        }
    }

    static func color(type: FsEntryType) -> Color {
        type == .dir ? .blue : .secondary
    }
}

enum FileFormat {
    static func size(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }
}
