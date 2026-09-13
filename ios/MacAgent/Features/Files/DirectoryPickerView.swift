import SwiftUI

/// 새 세션의 작업 디렉토리 피커(IOS.md 9.2). 홈(`~`)이 루트인 디렉토리 전용 브라우저이며 홈 위로 올라가는 진입점은 없다
/// (서버 샌드박스와 같다). `initialPath` 가 홈 아래 경로면 그곳까지 내려간 상태로 연다.
struct DirectoryPickerView: View {
    static let homePath = "~"

    @Environment(\.dismiss) private var dismiss
    @State private var model: FileBrowserModel
    private let initialPath: String
    private let onPick: (String) -> Void

    init(client: APIClient, initialPath: String = DirectoryPickerView.homePath, onPick: @escaping (String) -> Void) {
        _model = State(initialValue: FileBrowserModel(client: client, rootPath: Self.homePath, mode: .directories))
        self.initialPath = initialPath
        self.onPick = onPick
    }

    var body: some View {
        @Bindable var model = model
        NavigationStack(path: $model.stack) {
            PickerDirectoryList(model: model, path: model.rootPath)
                .navigationDestination(for: FileBrowserModel.Directory.self) { dir in
                    PickerDirectoryList(model: model, path: dir.path)
                }
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("취소") { dismiss() }
                    }
                }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { selectionBar }
        .task {
            // 홈 목록을 먼저 읽어 절대 경로를 알아낸 뒤 시작 경로까지 내려간다.
            guard model.root.listing == nil else { return }
            await model.load(model.rootPath)
            if initialPath != model.rootPath { model.reveal(initialPath) }
        }
    }

    /// 하단 고정 바: 현재 경로 + "이 폴더 선택".
    private var selectionBar: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(model.currentPath)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.head)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("directoryPicker.currentPath")
            Button {
                onPick(model.currentPath)
                dismiss()
            } label: {
                Text("이 폴더 선택").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(!canPick)
            .accessibilityIdentifier("directoryPicker.pick")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
    }

    /// 지금 보는 폴더의 목록을 서버에서 읽은 뒤에만 고를 수 있다(없는 경로를 고르지 않게).
    private var canPick: Bool {
        model.directory(for: model.stack.last?.path ?? model.rootPath)?.listing != nil
    }
}

/// 피커의 디렉토리 한 단계. 행은 하위 폴더로 들어가는 링크뿐이고, 툴바에 숨김 토글과 "새 폴더", (저장소가 아니면) "저장소 초기화"가 있다.
private struct PickerDirectoryList: View {
    let model: FileBrowserModel
    let path: String
    @State private var showsNewFolder = false
    @State private var newFolderName = ""
    /// 검증 실패나 서버 400/403/409 문구. 목록 위에 인라인으로 보인다.
    @State private var newFolderError: String?
    @State private var isCreating = false
    /// 저장소 초기화 흐름(PROTOCOL.md `POST /git/init`). 단계마다 하나씩 둔다.
    @State private var gitInit: GitInitModel

    init(model: FileBrowserModel, path: String) {
        self.model = model
        self.path = path
        _gitInit = State(initialValue: GitInitModel(client: model.client))
    }

    private var directory: FileBrowserModel.Directory {
        model.directory(for: path) ?? FileBrowserModel.Directory(path: path)
    }

    /// 서버의 `isGitRepo` 는 상위 저장소 안의 하위 폴더도 true 라, false 인 폴더에서만 초기화 버튼을 보인다(중첩 저장소 방지).
    private var canInitRepo: Bool { directory.listing?.isGitRepo == false }

    private var gitInitError: String? {
        if case .failed(let message) = gitInit.flow.phase { return message }
        return nil
    }

    private var gitInitNotice: String? {
        if case .done(let result) = gitInit.flow.phase { return GitInitFlow.doneMessage(result) }
        return nil
    }

    private var gitInitConfirmPresented: Binding<Bool> {
        Binding(get: { gitInit.flow.phase.preview != nil }, set: { if !$0 { gitInit.cancelPreview() } })
    }

    /// 루트 `~` 는 서버가 준 절대 경로로 보여준다.
    private var displayPath: String { model.serverPath(of: path) }

    private var title: String {
        let name = (displayPath as NSString).lastPathComponent
        return name.isEmpty ? displayPath : name
    }

    var body: some View {
        DirectoryListContent(model: model, path: path, banner: newFolderError ?? gitInitError, notice: gitInitNotice) { entry in
            NavigationLink(value: FileBrowserModel.Directory(path: entry.path)) {
                FileRow(entry: entry)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 0) {
                    Text(title).font(.headline).lineLimit(1)
                    Text(displayPath).font(.caption2.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
                }
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    model.toggleShowHidden()
                } label: {
                    Image(systemName: model.showHidden ? "eye" : "eye.slash")
                }
                .accessibilityLabel(model.showHidden ? "숨김 폴더 감추기" : "숨김 폴더 보기")
                Button {
                    showsNewFolder = true
                } label: {
                    Image(systemName: "folder.badge.plus")
                }
                .disabled(directory.listing == nil || isCreating)
                .accessibilityLabel("새 폴더")
                .accessibilityIdentifier("directoryPicker.newFolder")
                if canInitRepo {
                    Button {
                        Task { await gitInit.preview(cwd: displayPath) }
                    } label: {
                        Image(systemName: "arrow.triangle.branch")
                    }
                    .disabled(gitInit.flow.phase.isBusy || isCreating)
                    .accessibilityLabel("저장소 초기화")
                    .accessibilityIdentifier("directoryPicker.gitInit")
                }
            }
        }
        .confirmationDialog(
            "git 저장소를 만들까요?", isPresented: gitInitConfirmPresented, titleVisibility: .visible, presenting: gitInit.flow.phase.preview
        ) { _ in
            Button("초기화") { Task { await initRepository() } }
            Button("취소", role: .cancel) { gitInit.cancelPreview() }
        } message: { preview in
            Text(GitInitFlow.confirmMessage(preview))
        }
        .alert("새 폴더", isPresented: $showsNewFolder) {
            TextField("이름", text: $newFolderName)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("만들기") { Task { await create() } }
            Button("취소", role: .cancel) {}
        } message: {
            Text("\(title) 안에 만듭니다")
        }
        .task(id: path) { await model.load(path) }
    }

    private func create() async {
        isCreating = true
        defer { isCreating = false }
        let error = await model.createDirectory(named: newFolderName, in: path)
        newFolderError = error
        if error == nil { newFolderName = "" }
    }

    /// 확인 뒤 실제 초기화. 끝나면 목록을 다시 읽어 `isGitRepo` 와 git 배지를 갱신한다(버튼은 사라진다).
    private func initRepository() async {
        await gitInit.confirm(cwd: displayPath)
        if case .done = gitInit.flow.phase { await model.load(path) }
    }
}
