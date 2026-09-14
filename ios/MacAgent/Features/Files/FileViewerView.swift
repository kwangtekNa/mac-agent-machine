import CryptoKit
import MarkdownUI
import SwiftUI
import UIKit

/// 뷰와 테스트가 같이 쓰는 파일 뷰어 규칙.
enum FileViewerLogic {
    /// 이보다 크면 하이라이트 없이 plain monospaced 로 보여준다(성능).
    static let highlightLimitBytes = 200 * 1024

    static func shouldHighlight(size: Int, language: String) -> Bool {
        size <= highlightLimitBytes && HighlightrLanguage.name(for: language) != nil
    }

    static func showsTruncatedBanner(_ file: FsReadResponse) -> Bool {
        file.truncated
    }

    static func isImage(_ file: FsReadResponse) -> Bool {
        file.encoding == "base64"
    }

    static func image(from file: FsReadResponse) -> UIImage? {
        guard isImage(file), let data = Data(base64Encoded: file.content, options: .ignoreUnknownCharacters) else {
            return nil
        }
        return UIImage(data: data)
    }

    /// 서버 언어 식별자가 markdown 인가(`.md`, `.markdown` → `"markdown"`).
    static func isMarkdown(language: String) -> Bool {
        language == "markdown"
    }

    /// Markdown 을 렌더해 보여줄지. 하이라이트와 같은 크기 상한(200 KiB)을 넘으면 원본만.
    static func canRenderMarkdown(size: Int, language: String) -> Bool {
        isMarkdown(language: language) && size <= highlightLimitBytes
    }

    /// 코드 폰트 크기: 본문 Dynamic Type 크기의 85%.
    static func codeFontSize(bodyPointSize: CGFloat) -> CGFloat {
        bodyPointSize * 0.85
    }

    /// 415: 이미지가 아닌 바이너리 또는 5 MiB 초과 이미지.
    static func isUnsupportedMedia(_ error: any Error) -> Bool {
        guard case .server(_, _, let status) = error as? APIError else { return false }
        return status == 415
    }

    /// 리포 안이고 M/A/D 일 때만 "변경 보기".
    static func canShowDiff(isGitRepo: Bool, gitStatus: GitStatusCode?) -> Bool {
        guard isGitRepo, let gitStatus else { return false }
        return [.modified, .added, .deleted].contains(gitStatus)
    }

    // MARK: - 문서(2026-09-13, PROTOCOL.md `GET /fs/download`·`GET /fs/render`)

    /// 문서를 여는 방법. `quickLook` 은 원본을 내려받아 시스템 미리보기로, 한글은 서버가 변환한 HTML 로 본다.
    /// nil 이면 지금까지대로 `/fs/read`(텍스트·이미지·415)로 간다.
    enum DocumentKind: Equatable {
        case quickLook
        case hwp
        case hwpx
    }

    /// QuickLook 이 직접 여는 확장자. csv·md·txt 는 여기 없고 기존 텍스트 뷰어가 맡는다.
    static let quickLookExtensions: Set<String> = [
        "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "rtf", "rtfd", "pages", "numbers", "key", "epub",
    ]

    static func documentKind(forFileName name: String) -> DocumentKind? {
        switch (name as NSString).pathExtension.lowercased() {
        case "hwp": return .hwp
        case "hwpx": return .hwpx
        case let ext where quickLookExtensions.contains(ext): return .quickLook
        default: return nil
        }
    }

    /// `/fs/download`·`/fs/render` 의 크기 상한(서버와 같은 값).
    static let documentLimitBytes = 100 * 1024 * 1024

    /// 서버 415 와 같은 문구. 크기를 미리 알 때 앱이 먼저 보여 준다.
    static let documentTooLargeMessage = String(localized: "파일이 100 MiB 를 넘어 미리 볼 수 없습니다")

    /// `FsEntry.size` 를 알 때만 서버 호출 전에 막는다. 모르면 서버 415 문구를 그대로 쓴다.
    static func exceedsDocumentLimit(size: Int?) -> Bool {
        guard let size else { return false }
        return size > documentLimitBytes
    }

    /// 내려받은 원본을 두는 자리: `Caches/mam-docs/<경로 sha256 앞 16자>/<파일 이름>`.
    /// 경로마다 폴더를 나눠 이름이 같은 다른 문서가 섞이지 않게 하고, 이름은 그대로 둔다(QuickLook 이 확장자로 형식을 정한다).
    static func cacheURL(for path: String, fileName: String) -> URL {
        let digest = SHA256.hash(data: Data(path.utf8)).map { String(format: "%02x", $0) }.joined()
        return URL.cachesDirectory
            .appending(path: "mam-docs")
            .appending(path: String(digest.prefix(16)))
            .appending(path: fileName)
    }

    /// 서버가 501 문구를 주지 못했을 때의 기본 안내.
    static let hwpConverterMissingMessage = String(
        localized: "한글(HWP) 변환기가 없습니다. Mac 에서\npython3 -m pip install --user pyhwp\n를 실행하세요."
    )

    /// 501 `agent_unavailable` 안내. 서버 문구의 백틱 명령을 따로 줄로 빼서 그대로 보여 준다.
    static func hwpUnavailableMessage(_ serverMessage: String) -> String {
        let message = serverMessage.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else { return hwpConverterMissingMessage }
        let parts = message.split(separator: "`", omittingEmptySubsequences: false)
        guard parts.count >= 3 else { return message }
        return message
            .replacingOccurrences(of: "`\(parts[1])`", with: "\n\(parts[1])\n")
            .replacingOccurrences(of: " \n", with: "\n")
            .replacingOccurrences(of: "\n ", with: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// 501(또는 `agent_unavailable`): 서버에 한글 변환기가 없다.
    static func isConverterUnavailable(_ error: any Error) -> Bool {
        guard case .server(let code, _, let status) = error as? APIError else { return false }
        return status == 501 || code == .agentUnavailable
    }
}

/// 파일 하나를 읽기 전용으로 보여준다(IOS.md 7절: truncated 배너, 415 안내).
struct FileViewerView: View {
    let client: APIClient
    let rootPath: String
    let path: String
    let isGitRepo: Bool
    let gitStatus: GitStatusCode?
    /// `FsEntry.size`. 알면 100 MiB 상한을 서버 호출 전에 막고, 모르면 서버 415 문구를 쓴다.
    var size: Int? = nil

    private enum Phase {
        case loading
        /// 원본을 내려받는 중(0…1).
        case downloading(Double)
        case loaded(FsReadResponse)
        /// 내려받은 원본을 QuickLook 으로 본다.
        case document(URL)
        /// 서버가 변환한 한글 문서 HTML.
        case rendered(FsRenderResponse)
        case unsupported
        /// 100 MiB 초과(앱이 미리 막았거나 서버 415).
        case tooLarge(String)
        /// 501: 서버에 한글 변환기가 없다.
        case converterMissing(String)
        case failed(String)
    }

    @State private var phase: Phase = .loading
    @State private var wrapLines = false
    @State private var showsDiff = false
    /// Markdown 파일: 기본은 렌더, 토글하면 원본.
    @State private var showsMarkdownSource = false
    /// 내려받기 취소용. QuickLook 문서를 받는 동안에만 값이 있다.
    @State private var downloadTask: Task<URL, any Error>?
    /// 캐시에 내려받은 문서 폴더. 뷰어를 닫을 때 지운다.
    @State private var cachedDirectory: URL?
    /// 한글 뷰어의 "원본 공유": 내려받아야 공유할 수 있다.
    @State private var shareURL: URL?
    @State private var preparingShare = false
    @State private var shareError: String?

    private var fileName: String { (path as NSString).lastPathComponent }

    /// 확장자로 정하는 문서 처리 경로. nil 이면 기존 `/fs/read` 흐름.
    private var documentKind: FileViewerLogic.DocumentKind? {
        FileViewerLogic.documentKind(forFileName: fileName)
    }

    /// 제목 아래 부제. 텍스트는 언어·크기, 문서는 크기(알 때만).
    private var subtitle: String? {
        if case .loaded(let file) = phase { return "\(file.language) · \(FileFormat.size(file.size))" }
        guard documentKind != nil, let size else { return nil }
        return FileFormat.size(size)
    }

    private var renderedDocument: FsRenderResponse? {
        if case .rendered(let document) = phase { return document }
        return nil
    }

    private var loadedFile: FsReadResponse? {
        if case .loaded(let file) = phase { return file }
        return nil
    }

    var body: some View {
        content
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 0) {
                        Text(fileName).font(.headline).lineLimit(1).truncationMode(.middle)
                        if let subtitle {
                            Text(subtitle)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if let file = loadedFile, !FileViewerLogic.isImage(file) {
                        if FileViewerLogic.canRenderMarkdown(size: file.size, language: file.language) {
                            Button {
                                showsMarkdownSource.toggle()
                            } label: {
                                Image(systemName: showsMarkdownSource ? "doc.richtext" : "doc.plaintext")
                            }
                            .accessibilityLabel(showsMarkdownSource ? "렌더 보기" : "원본 보기")
                            .accessibilityIdentifier("fileViewer.markdownToggle")
                        }
                        if showsSource(file) {
                            Button {
                                wrapLines.toggle()
                            } label: {
                                Image(systemName: "return")
                                    .symbolVariant(wrapLines ? .fill : .none)
                            }
                            .tint(wrapLines ? .accentColor : .secondary)
                            .accessibilityLabel(wrapLines ? "줄바꿈 끄기" : "줄바꿈 켜기")
                        }
                        ShareLink(item: file.content) {
                            Image(systemName: "square.and.arrow.up")
                        }
                        .accessibilityLabel("공유")
                    }
                    if renderedDocument != nil {
                        shareOriginalButton
                    }
                    if FileViewerLogic.canShowDiff(isGitRepo: isGitRepo, gitStatus: gitStatus) {
                        Button("변경 보기") { showsDiff = true }
                    }
                }
            }
            .sheet(isPresented: $showsDiff) {
                DiffSheet(client: client, cwd: rootPath, path: path)
            }
            .alert("원본을 가져오지 못했습니다", isPresented: .init(get: { shareError != nil }, set: { if !$0 { shareError = nil } })) {
                Button("확인", role: .cancel) { shareError = nil }
            } message: {
                Text(shareError ?? "")
            }
            .task(id: path) { await load() }
            .onDisappear { cleanUp() }
    }

    @ViewBuilder
    private var content: some View {
        switch phase {
        case .loading:
            ProgressView()
        case .downloading(let value):
            VStack(spacing: 16) {
                ProgressView(value: value) {
                    Text("문서를 내려받는 중…")
                }
                .progressViewStyle(.linear)
                .frame(maxWidth: 280)
                .accessibilityIdentifier("documentViewer.progress")
                Button("취소") { downloadTask?.cancel() }
            }
            .padding(24)
        case .document(let url):
            QuickLookView(url: url)
                .ignoresSafeArea(edges: .bottom)
        case .rendered(let document):
            HTMLDocumentView(document: document)
        case .unsupported:
            ContentUnavailableView("미리 볼 수 없는 파일 형식", systemImage: "doc.questionmark")
        case .tooLarge(let message):
            ContentUnavailableView("미리 볼 수 없습니다", systemImage: "doc.badge.ellipsis", description: Text(message))
        case .converterMissing(let message):
            ContentUnavailableView {
                Label("한글 변환기가 없습니다", systemImage: "doc.badge.gearshape")
            } description: {
                Text(FileViewerLogic.hwpUnavailableMessage(message))
            } actions: {
                Button("다시 시도") { Task { await load() } }
                    .buttonStyle(.borderedProminent)
            }
        case .failed(let message):
            ContentUnavailableView {
                Label("불러올 수 없습니다", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("다시 시도") { Task { await load() } }
                    .buttonStyle(.borderedProminent)
            }
        case .loaded(let file):
            VStack(spacing: 0) {
                if FileViewerLogic.showsTruncatedBanner(file) {
                    Label("앞 1 MiB만 표시합니다", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .padding(8)
                        .frame(maxWidth: .infinity)
                        .background(Color(.secondarySystemGroupedBackground))
                }
                if FileViewerLogic.isImage(file) {
                    if let image = FileViewerLogic.image(from: file) {
                        ZoomableImageView(image: image)
                    } else {
                        ContentUnavailableView("이미지를 열 수 없습니다", systemImage: "photo")
                    }
                } else if !showsSource(file) {
                    MarkdownDocumentView(text: file.content)
                } else {
                    HighlightedCodeView(
                        text: file.content,
                        language: HighlightrLanguage.name(for: file.language),
                        highlightEnabled: FileViewerLogic.shouldHighlight(size: file.size, language: file.language),
                        wrapLines: wrapLines
                    )
                    .ignoresSafeArea(edges: .bottom)
                }
            }
        }
    }

    /// 원본(코드 뷰)을 보여줄지. Markdown 은 렌더가 기본이고 토글로 원본을 본다.
    private func showsSource(_ file: FsReadResponse) -> Bool {
        !FileViewerLogic.canRenderMarkdown(size: file.size, language: file.language) || showsMarkdownSource
    }

    private func load() async {
        if let kind = documentKind {
            guard !FileViewerLogic.exceedsDocumentLimit(size: size) else {
                phase = .tooLarge(FileViewerLogic.documentTooLargeMessage)
                return
            }
            switch kind {
            case .quickLook:
                await downloadDocument()
            case .hwp, .hwpx:
                await renderDocument()
            }
            return
        }
        phase = .loading
        do {
            phase = .loaded(try await client.readFile(path: path))
        } catch {
            phase = FileViewerLogic.isUnsupportedMedia(error)
                ? .unsupported
                : .failed(ErrorMessages.fileAccessMessage(for: error))
        }
    }

    /// 원본을 앱 캐시로 내려받아 QuickLook 에 넘긴다. 취소는 `downloadTask.cancel()`.
    private func downloadDocument() async {
        phase = .downloading(0)
        let destination = FileViewerLogic.cacheURL(for: path, fileName: fileName)
        let task = Task {
            try await client.downloadFile(path: path, to: destination) { value in
                Task { @MainActor in
                    if case .downloading = phase { phase = .downloading(value) }
                }
            }
        }
        downloadTask = task
        defer { downloadTask = nil }
        do {
            let url = try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
            cachedDirectory = destination.deletingLastPathComponent()
            phase = .document(url)
        } catch {
            cachedDirectory = destination.deletingLastPathComponent()
            phase = isCancellation(error) ? .failed(String(localized: "내려받기를 취소했습니다.")) : documentFailure(error)
        }
    }

    /// 한글 문서는 서버가 HTML 로 바꿔 준다(변환기가 없으면 501 안내).
    private func renderDocument() async {
        phase = .loading
        do {
            phase = .rendered(try await client.renderDocument(path: path))
        } catch {
            phase = isCancellation(error) ? .loading : documentFailure(error)
        }
    }

    /// 한글 뷰어 툴바의 "원본 공유". 내려받은 뒤 시스템 공유 시트로 넘긴다.
    @ViewBuilder
    private var shareOriginalButton: some View {
        if let shareURL {
            ShareLink(item: shareURL) {
                Image(systemName: "square.and.arrow.up")
            }
            .accessibilityLabel("원본 공유")
        } else {
            Button {
                Task { await prepareShare() }
            } label: {
                if preparingShare {
                    ProgressView().controlSize(.mini)
                } else {
                    Image(systemName: "square.and.arrow.up")
                }
            }
            .disabled(preparingShare)
            .accessibilityLabel("원본 공유")
            .accessibilityIdentifier("documentViewer.share")
        }
    }

    private func prepareShare() async {
        preparingShare = true
        defer { preparingShare = false }
        let destination = FileViewerLogic.cacheURL(for: path, fileName: fileName)
        do {
            let url = try await client.downloadFile(path: path, to: destination)
            cachedDirectory = destination.deletingLastPathComponent()
            shareURL = url
        } catch {
            cachedDirectory = destination.deletingLastPathComponent()
            if !isCancellation(error) { shareError = ErrorMessages.fileAccessMessage(for: error) }
        }
    }

    /// 문서 API 오류 → 화면. 415 는 크기 상한, 501 은 변환기 없음, 나머지는 공통 파일 오류 문구.
    private func documentFailure(_ error: any Error) -> Phase {
        guard case .server(_, let message, let status) = error as? APIError else {
            return .failed(ErrorMessages.fileAccessMessage(for: error))
        }
        if status == 415 { return .tooLarge(message) }
        if FileViewerLogic.isConverterUnavailable(error) { return .converterMissing(message) }
        return .failed(ErrorMessages.fileAccessMessage(for: error))
    }

    /// 사용자가 취소했거나 화면을 떠났다(URLSession 은 `URLError.cancelled` 로 온다).
    private func isCancellation(_ error: any Error) -> Bool {
        if error is CancellationError { return true }
        if case .transport(let underlying) = error as? APIError {
            return (underlying as? URLError)?.code == .cancelled
        }
        return false
    }

    /// 뷰어를 닫으면 내려받기를 멈추고 캐시 파일을 지운다.
    private func cleanUp() {
        downloadTask?.cancel()
        guard let cachedDirectory else { return }
        try? FileManager.default.removeItem(at: cachedDirectory)
        self.cachedDirectory = nil
        shareURL = nil
    }
}

/// Markdown 파일 렌더(IOS.md 5절: 에이전트 메시지와 같은 MarkdownUI 테마). 상대 경로 이미지는 표시되지 않는다.
private struct MarkdownDocumentView: View {
    let text: String

    var body: some View {
        ScrollView {
            Markdown(text)
                .markdownTheme(Theme.macAgent(dimmed: false))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
        }
        .background(Color(.systemBackground))
    }
}

/// 핀치 줌이 되는 이미지. 기본은 화면 너비에 맞춘다.
private struct ZoomableImageView: View {
    let image: UIImage
    @State private var scale: CGFloat = 1
    @State private var baseScale: CGFloat = 1

    var body: some View {
        GeometryReader { geo in
            let aspect = image.size.height / max(image.size.width, 1)
            let width = geo.size.width * scale
            ScrollView([.horizontal, .vertical]) {
                Image(uiImage: image)
                    .resizable()
                    .frame(width: width, height: width * aspect)
            }
            .gesture(
                MagnifyGesture()
                    .onChanged { value in
                        scale = min(max(baseScale * value.magnification, 1), 8)
                    }
                    .onEnded { _ in baseScale = scale }
            )
        }
        .background(Color(.systemGroupedBackground))
    }
}

/// `GET /git/diff` 결과를 DiffTextView 로 보여주는 시트. 워킹트리 diff 가 비어 있으면 staged 를 한 번 더 본다(A 파일).
private struct DiffSheet: View {
    let client: APIClient
    let cwd: String
    let path: String
    @Environment(\.dismiss) private var dismiss
    @State private var patch: String?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Group {
                if let error {
                    ContentUnavailableView {
                        Label("변경 내용을 불러올 수 없습니다", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(error)
                    }
                } else if let patch {
                    if patch.isEmpty {
                        ContentUnavailableView("변경 내용이 없습니다", systemImage: "plus.forwardslash.minus")
                    } else {
                        ScrollView {
                            DiffTextView(patch: patch)
                        }
                    }
                } else {
                    ProgressView()
                }
            }
            .navigationTitle("변경 보기")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("닫기") { dismiss() }
                }
            }
            .task { await load() }
        }
    }

    private func load() async {
        do {
            var result = try await client.gitDiff(cwd: cwd, path: path, staged: false).patch
            if result.isEmpty {
                result = try await client.gitDiff(cwd: cwd, path: path, staged: true).patch
            }
            patch = result
        } catch {
            self.error = ErrorMessages.fileAccessMessage(for: error)
        }
    }
}
