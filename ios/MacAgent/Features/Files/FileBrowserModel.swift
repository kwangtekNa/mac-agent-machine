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

    /// 무엇을 보여줄지. 피커는 디렉토리만 본다(IOS.md 9.2).
    enum Mode: Equatable, Sendable {
        /// 파일과 디렉토리 모두(세션 파일 탭).
        case files
        /// 디렉토리만(새 세션 피커). 파일 탭은 비활성.
        case directories
    }

    static let showHiddenKey = "mam.files.showHidden"

    let client: APIClient
    /// 세션 cwd 또는 피커의 홈(`~`). 이 위로는 올라가지 않는다.
    let rootPath: String
    let mode: Mode
    private(set) var root: Directory
    /// NavigationStack path. 루트는 포함하지 않는다.
    var stack: [Directory] = []
    /// 열려 있는 파일. 시트를 닫고 다시 열어도 유지된다.
    var selectedFile: FsEntry?
    private(set) var showHidden: Bool

    @ObservationIgnored private var cache: [String: FsListResponse] = [:]
    @ObservationIgnored private let defaults: UserDefaults

    init(client: APIClient, rootPath: String, mode: Mode = .files, defaults: UserDefaults = .standard) {
        self.client = client
        self.rootPath = rootPath
        self.mode = mode
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

    /// 목록을 읽은 뒤에는 서버가 준 절대 경로, 아니면 입력 경로 그대로(루트 `~` 는 읽기 전까지 `~`).
    func serverPath(of path: String) -> String {
        directory(for: path)?.listing?.path ?? path
    }

    /// 지금 보고 있는 디렉토리의 서버 경로(피커의 하단 바·선택 결과).
    var currentPath: String {
        stack.last?.path ?? serverPath(of: rootPath)
    }

    /// 홈 절대 경로 아래의 `target` 까지 내려가는 중간 디렉토리 목록(홈 제외, target 포함). `~/x` 는 홈 기준으로 푼다.
    /// 홈 자신이나 홈 밖 경로는 빈 배열이다(피커는 홈 위로 가지 않는다).
    nonisolated static func pathsUnderHome(_ home: String, target: String) -> [String] {
        var home = home
        while home.count > 1, home.hasSuffix("/") { home.removeLast() }
        if target == "~" { return [] }
        var absolute = target.hasPrefix("~/") ? home + "/" + target.dropFirst(2) : target
        while absolute.count > 1, absolute.hasSuffix("/") { absolute.removeLast() }
        guard absolute.hasPrefix(home + "/") else { return [] }
        var paths: [String] = []
        var cursor = home
        for segment in absolute.dropFirst(home.count + 1).split(separator: "/", omittingEmptySubsequences: true) {
            cursor += "/" + segment
            paths.append(cursor)
        }
        return paths
    }

    /// 루트 목록을 읽은 뒤 `target` 까지 중간 디렉토리를 한 번에 push 한다(피커 시작 위치). 홈 절대 경로를 아직 모르면 아무것도 하지 않는다.
    func reveal(_ target: String) {
        guard let home = root.listing?.path else { return }
        stack = Self.pathsUnderHome(home, target: target).map { Directory(path: $0, listing: cache[$0]) }
    }

    /// 새 폴더(IOS.md 9.2). 이름 검증은 제출 전 편의이고 최종 판단은 서버(400/403/409)다.
    /// 성공하면 부모 목록을 다시 읽고 만든 폴더로 push 한다. 실패하면 사용자에게 보일 문구를 돌려준다.
    func createDirectory(named name: String, in parentPath: String) async -> String? {
        if let invalid = DirectoryNameValidation.validate(name) { return invalid }
        let target = serverPath(of: parentPath) + "/" + DirectoryNameValidation.normalized(name)
        do {
            let entry = try await client.makeDirectory(path: target)
            await load(parentPath)
            push(entry.path)
            return nil
        } catch {
            return ErrorMessages.makeDirectoryMessage(for: error)
        }
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

    /// 숨김 필터(와 `.directories` 모드의 디렉토리 필터)만 적용한다. 정렬은 서버(디렉토리 먼저, 이름순)를 그대로 따른다.
    func visibleEntries(of dir: Directory) -> [FsEntry] {
        guard let entries = dir.listing?.entries else { return [] }
        return entries.filter { entry in
            (showHidden || !entry.isHidden) && (mode == .files || entry.type == .dir)
        }
    }

    private func update(_ path: String, _ change: (inout Directory) -> Void) {
        if path == rootPath {
            change(&root)
        } else if let index = stack.firstIndex(where: { $0.path == path }) {
            change(&stack[index])
        }
    }
}

/// 새 폴더 이름의 제출 전 검증(IOS.md 9.2). 빈 값·`/`·제어 문자만 막고 나머지(중복 등)는 서버 400/409 가 판단한다.
enum DirectoryNameValidation {
    static let emptyMessage = String(localized: "이름을 입력하세요.")
    static let slashMessage = String(localized: "이름에 /를 넣을 수 없습니다.")
    static let controlMessage = String(localized: "이름에 쓸 수 없는 문자가 있습니다.")

    /// 앞뒤 공백·줄바꿈을 뗀 이름. 요청에는 이 값을 쓴다.
    static func normalized(_ name: String) -> String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// 문제가 있으면 문구, 없으면 nil.
    static func validate(_ name: String) -> String? {
        let trimmed = normalized(name)
        if trimmed.isEmpty { return emptyMessage }
        if trimmed.contains("/") { return slashMessage }
        if trimmed.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) { return controlMessage }
        return nil
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
