import SwiftUI

/// 세션 cwd 파일 브라우저 시트(IOS.md 4절). 읽기 전용이며 루트 위로 올라가는 진입점은 없다.
struct FileBrowserView: View {
    @Bindable var model: FileBrowserModel
    /// 시트로 열렸을 때만 "닫기". iPad 디테일 열에서는 없다.
    var showsCloseButton = true
    @Environment(\.dismiss) private var dismiss

    var body: some View {
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

/// 디렉토리 한 단계. 목록은 모델에서 읽고, 등장할 때마다 `load` 로 새로고침한다(캐시가 있으면 즉시 표시).
private struct DirectoryListView: View {
    let model: FileBrowserModel
    let path: String

    private var directory: FileBrowserModel.Directory {
        model.directory(for: path) ?? FileBrowserModel.Directory(path: path)
    }

    var body: some View {
        content
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
    private var content: some View {
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
                if let error = dir.error {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .listRowBackground(Color.yellow.opacity(0.18))
                }
                if entries.isEmpty {
                    ContentUnavailableView("비어 있는 폴더", systemImage: "folder")
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

private struct FileRow: View {
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
