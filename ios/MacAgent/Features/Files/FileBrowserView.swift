import SwiftUI

/// 세션 cwd 파일 브라우저(IOS.md 4절, 9.1). 읽기 전용이며 루트 위로 올라가는 진입점은 없다.
/// 시트(닫기 버튼)와 iPad 디테일 열(`showsCloseButton: false`)은 자체 NavigationStack 으로 push 탐색을 하고,
/// 세션 화면 "파일" 탭(`embedded: true`)은 바깥 NavigationStack 안에 놓이므로 스택을 중첩하지 않고 같은 자리에서 목록을 교체한다.
struct FileBrowserView: View {
    @Bindable var model: FileBrowserModel
    /// 시트로 열렸을 때만 "닫기". iPad 디테일 열에서는 없다.
    var showsCloseButton = true
    /// 세션 화면의 "파일" 탭 안에 인라인으로 놓일 때. `EmbeddedDirectoryBrowser` 로 그린다.
    var embedded = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        if embedded {
            EmbeddedDirectoryBrowser(model: model)
        } else {
            NavigationStack(path: $model.stack) {
                DirectoryListView(model: model, path: model.rootPath)
                    .navigationDestination(for: FileBrowserModel.Directory.self) { dir in
                        DirectoryListView(model: model, path: dir.path)
                    }
                    .navigationDestination(item: $model.selectedFile) { entry in
                        FileViewerView(
                            client: model.client,
                            rootPath: model.rootPath,
                            path: entry.path,
                            isGitRepo: model.isGitRepo,
                            gitStatus: entry.gitStatus
                        )
                    }
                    .toolbar {
                        if showsCloseButton {
                            ToolbarItem(placement: .topBarLeading) {
                                Button("닫기") { dismiss() }
                            }
                        }
                    }
            }
        }
    }
}

/// "파일" 탭의 제자리 탐색(IOS.md 9.1). 위치는 `model.stack` 이 들고 있어 탭을 오가도 남고,
/// 상단 바의 "‹ 상위 폴더" 로 한 단계 올라간다. 파일은 바깥 스택을 건드리지 않도록 시트로 연다.
private struct EmbeddedDirectoryBrowser: View {
    @Bindable var model: FileBrowserModel

    private var path: String { model.currentDirectoryPath }

    private var directory: FileBrowserModel.Directory {
        model.directory(for: path) ?? FileBrowserModel.Directory(path: path)
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            DirectoryListContent(model: model, path: path) { entry in
                row(entry)
            }
            .id(path)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Color(.systemBackground))
        .task(id: path) { await model.load(path) }
        .sheet(item: $model.selectedFile) { entry in
            NavigationStack {
                FileViewerView(
                    client: model.client,
                    rootPath: model.rootPath,
                    path: entry.path,
                    isGitRepo: model.isGitRepo,
                    gitStatus: entry.gitStatus
                )
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("닫기") { model.selectedFile = nil }
                    }
                }
            }
        }
    }

    /// 현재 폴더 이름·경로와 상위 이동, 숨김 토글, 새로고침. 스택이 없으므로 내비게이션 바 대신 목록 위에 둔다.
    private var header: some View {
        HStack(spacing: 10) {
            if let parent = model.parentName {
                Button {
                    model.pop()
                } label: {
                    Label(parent, systemImage: "chevron.left")
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .accessibilityLabel("상위 폴더 \(parent)")
                .accessibilityIdentifier("fileBrowser.up")
            }
            VStack(alignment: .leading, spacing: 0) {
                Text(directory.name)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(path)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.head)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("fileBrowser.currentPath")
            Button {
                model.toggleShowHidden()
            } label: {
                Image(systemName: model.showHidden ? "eye" : "eye.slash")
            }
            .accessibilityLabel(model.showHidden ? "숨김 파일 감추기" : "숨김 파일 보기")
            Button {
                Task { await model.load(path) }
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .accessibilityLabel("새로고침")
        }
        .font(.subheadline)
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Color(.secondarySystemGroupedBackground))
    }

    @ViewBuilder
    private func row(_ entry: FsEntry) -> some View {
        switch entry.type {
        case .dir:
            Button {
                model.push(entry.path)
            } label: {
                HStack(spacing: 8) {
                    FileRow(entry: entry)
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
            }
            .buttonStyle(.plain)
        case .file, .symlink:
            Button {
                model.selectedFile = entry
            } label: {
                FileRow(entry: entry)
            }
            .buttonStyle(.plain)
        case .other, .unknown:
            FileRow(entry: entry)
        }
    }
}

/// 디렉토리 한 단계(push 탐색). 목록은 모델에서 읽고, 등장할 때마다 `load` 로 새로고침한다(캐시가 있으면 즉시 표시).
private struct DirectoryListView: View {
    let model: FileBrowserModel
    let path: String

    private var directory: FileBrowserModel.Directory {
        model.directory(for: path) ?? FileBrowserModel.Directory(path: path)
    }

    var body: some View {
        DirectoryListContent(model: model, path: path) { entry in
            row(entry)
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 0) {
                    Text(directory.name).font(.headline).lineLimit(1)
                    Text(path).font(.caption2.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
                }
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    model.toggleShowHidden()
                } label: {
                    Image(systemName: model.showHidden ? "eye" : "eye.slash")
                }
                .accessibilityLabel(model.showHidden ? "숨김 파일 감추기" : "숨김 파일 보기")
                Button {
                    Task { await model.load(path) }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .accessibilityLabel("새로고침")
            }
        }
        .task(id: path) { await model.load(path) }
    }

    @ViewBuilder
    private func row(_ entry: FsEntry) -> some View {
        switch entry.type {
        case .dir:
            NavigationLink(value: FileBrowserModel.Directory(path: entry.path)) {
                FileRow(entry: entry)
            }
        case .file, .symlink:
            Button {
                model.selectedFile = entry
            } label: {
                FileRow(entry: entry)
            }
            .buttonStyle(.plain)
        case .other, .unknown:
            FileRow(entry: entry)
        }
    }
}

/// 디렉토리 한 단계의 내용(로딩 · 오류 · 목록). 행은 호출자가 만든다(파일 브라우저는 파일 뷰어로, 피커는 하위 폴더로).
struct DirectoryListContent<Row: View>: View {
    let model: FileBrowserModel
    let path: String
    /// 목록 위에 노란 배경으로 보이는 문구(새 폴더 오류 등). 목록이 없을 때는 보이지 않는다.
    var banner: String? = nil
    @ViewBuilder let row: (FsEntry) -> Row

    private var directory: FileBrowserModel.Directory {
        model.directory(for: path) ?? FileBrowserModel.Directory(path: path)
    }

    var body: some View {
        let dir = directory
        if dir.listing == nil, let error = dir.error {
            ContentUnavailableView {
                Label("불러올 수 없습니다", systemImage: "exclamationmark.triangle")
            } description: {
                Text(error)
            } actions: {
                Button("다시 시도") { Task { await model.load(path) } }
                    .buttonStyle(.borderedProminent)
            }
        } else if dir.listing == nil {
            ProgressView()
        } else {
            let entries = model.visibleEntries(of: dir)
            List {
                ForEach([banner, dir.error].compactMap { $0 }, id: \.self) { message in
                    Label(message, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .listRowBackground(Color.yellow.opacity(0.18))
                        .accessibilityLabel("오류: \(message)")
                }
                if entries.isEmpty {
                    ContentUnavailableView(
                        model.mode == .directories ? "하위 폴더 없음" : "비어 있는 폴더",
                        systemImage: "folder"
                    )
                    .listRowSeparator(.hidden)
                } else {
                    ForEach(entries) { entry in
                        row(entry)
                    }
                }
            }
            .listStyle(.plain)
            .refreshable { await model.load(path) }
        }
    }
}

/// 항목 한 행: 아이콘, 이름, 크기, git 배지. 파일 브라우저와 디렉토리 피커가 같이 쓴다.
struct FileRow: View {
    let entry: FsEntry

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: FileIcon.symbol(name: entry.name, type: entry.type))
                .foregroundStyle(FileIcon.color(type: entry.type))
                .frame(width: 24)
            Text(entry.name)
                .lineLimit(1)
                .truncationMode(.middle)
                .foregroundStyle(entry.isHidden ? .secondary : .primary)
            Spacer(minLength: 8)
            if entry.type == .file, let size = entry.size {
                Text(FileFormat.size(size))
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
            if let badge = GitBadge.style(entry.gitStatus) {
                Text(badge.text)
                    .font(.caption2.bold())
                    .foregroundStyle(badge.color)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(badge.color.opacity(0.18), in: Capsule())
                    .accessibilityLabel("git \(badge.text)")
            }
        }
        .contentShape(Rectangle())
    }
}
