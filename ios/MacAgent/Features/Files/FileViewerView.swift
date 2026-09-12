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
}

/// 파일 하나를 읽기 전용으로 보여준다(IOS.md 7절: truncated 배너, 415 안내).
struct FileViewerView: View {
    let client: APIClient
    let rootPath: String
    let path: String
    let isGitRepo: Bool
    let gitStatus: GitStatusCode?

    private enum Phase {
        case loading
        case loaded(FsReadResponse)
        case unsupported
        case failed(String)
    }

    @State private var phase: Phase = .loading
    @State private var wrapLines = false
    @State private var showsDiff = false
    /// Markdown 파일: 기본은 렌더, 토글하면 원본.
    @State private var showsMarkdownSource = false

    private var fileName: String { (path as NSString).lastPathComponent }

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
                        if let file = loadedFile {
                            Text("\(file.language) · \(FileFormat.size(file.size))")
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
                    if FileViewerLogic.canShowDiff(isGitRepo: isGitRepo, gitStatus: gitStatus) {
                        Button("변경 보기") { showsDiff = true }
                    }
                }
            }
            .sheet(isPresented: $showsDiff) {
                DiffSheet(client: client, cwd: rootPath, path: path)
            }
            .task(id: path) { await load() }
    }

    @ViewBuilder
    private var content: some View {
        switch phase {
        case .loading:
            ProgressView()
        case .unsupported:
            ContentUnavailableView("미리 볼 수 없는 파일 형식", systemImage: "doc.questionmark")
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
        phase = .loading
        do {
            phase = .loaded(try await client.readFile(path: path))
        } catch {
            phase = FileViewerLogic.isUnsupportedMedia(error)
                ? .unsupported
                : .failed(ErrorMessages.fileAccessMessage(for: error))
        }
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
