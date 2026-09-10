import SwiftUI

/// 세션 타임라인 화면(IOS.md 4·5·6절). `AppState.client` 로 세션별 `TimelineModel` 을 만든다.
struct TimelineView: View {
    @Environment(AppState.self) private var appState
    let sessionId: String

    var body: some View {
        if let client = appState.client {
            TimelineScreen(sessionId: sessionId, client: client)
                .id(sessionId)
        } else {
            ContentUnavailableView("서버에 연결되어 있지 않습니다", systemImage: "wifi.slash")
        }
    }
}

private struct TimelineScreen: View {
    private static let bottomId = "timeline.bottom"

    @Environment(SessionsStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss
    @State private var model: TimelineModel
    @State private var isAtBottom = true
    @State private var showsNewEvents = false
    @State private var showsInfo = false
    @State private var focusRequest = 0
    @State private var detailApproval: Approval?
    @State private var showsFiles = false
    /// 파일 시트 모델. 시트를 닫아도 화면이 살아 있는 동안 유지해 다시 열면 같은 위치다.
    @State private var filesModel: FileBrowserModel?
    private let sessionId: String
    private let client: APIClient

    init(sessionId: String, client: APIClient) {
        self.sessionId = sessionId
        self.client = client
        _model = State(initialValue: TimelineModel(sessionId: sessionId, client: client))
    }

    var body: some View {
        VStack(spacing: 0) {
            if let fatal = model.fatalError {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
                    Text(fatal).font(.subheadline)
                    Spacer(minLength: 0)
                    Button("다시 시도") { model.resume() }
                        .font(.subheadline)
                        .buttonStyle(.borderless)
                }
                .padding(12)
                .background(Color.red.opacity(0.15))
            }
            if case .reconnecting = model.socketState {
                Text("다시 연결 중…")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 3)
                    .background(Color(.secondarySystemGroupedBackground))
            }
            timeline
        }
        .background(Color(.systemGroupedBackground))
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                ApprovalBanner(model: model)
                Composer(model: model, focusRequest: focusRequest)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 0) {
                    Text(title).font(.headline).lineLimit(1)
                    Text(statusText).font(.caption).foregroundStyle(.secondary)
                }
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                ModeMenu(mode: model.mode) { mode in
                    Task { await model.setMode(mode) }
                }
                Button {
                    openFiles()
                } label: {
                    Image(systemName: "folder")
                }
                .disabled(currentSession == nil)
                .accessibilityLabel("파일")
                Button {
                    showsInfo = true
                } label: {
                    Image(systemName: "info.circle")
                }
                .accessibilityLabel("세션 정보")
            }
        }
        .sheet(isPresented: $showsInfo) {
            SessionInfoSheet(session: currentSession, onClose: closeSession)
        }
        .sheet(item: $detailApproval) { approval in
            ApprovalSheet(model: model, approvalId: approval.approvalId)
        }
        .sheet(isPresented: $showsFiles) {
            if let filesModel {
                FileBrowserView(model: filesModel)
                    .presentationDetents([.large])
            }
        }
        .task { await model.start() }
        .onDisappear { model.stop() }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background: model.stop()
            case .active: if model.socket == nil { model.resume() }
            default: break
            }
        }
    }

    private var timeline: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 12) {
                    if model.hasOlderHistory {
                        Text("이전 기록이 더 있습니다")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity)
                    }
                    ForEach(model.items) { item in
                        TimelineItemRow(item: item, onRetry: { focusRequest += 1 }, onApprovalDetail: { detailApproval = $0 })
                            .id(item.id)
                    }
                    Color.clear
                        .frame(height: 1)
                        .id(Self.bottomId)
                        .onAppear {
                            isAtBottom = true
                            showsNewEvents = false
                        }
                        .onDisappear { isAtBottom = false }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: model.lastSeq) { _, _ in
                if isAtBottom {
                    proxy.scrollTo(Self.bottomId, anchor: .bottom)
                } else {
                    showsNewEvents = true
                }
            }
            .overlay(alignment: .bottom) {
                if showsNewEvents, !isAtBottom {
                    Button {
                        proxy.scrollTo(Self.bottomId, anchor: .bottom)
                    } label: {
                        Label("새 이벤트", systemImage: "arrow.down").font(.caption.weight(.semibold))
                    }
                    .buttonStyle(.borderedProminent)
                    .clipShape(Capsule())
                    .padding(.bottom, 8)
                }
            }
        }
    }

    private var currentSession: Session? {
        model.session ?? store.session(id: sessionId)
    }

    private func openFiles() {
        guard let cwd = currentSession?.cwd else { return }
        if filesModel?.rootPath != cwd {
            filesModel = FileBrowserModel(client: client, rootPath: cwd)
        }
        showsFiles = true
    }

    /// 세션 제목, 없으면 프로젝트(cwd 마지막 컴포넌트) 이름.
    private var title: String {
        guard let session = currentSession else { return String(localized: "세션") }
        let trimmed = session.title.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { return trimmed }
        let project = URL(fileURLWithPath: session.cwd).lastPathComponent
        return project.isEmpty ? String(localized: "세션") : project
    }

    private var statusText: String {
        switch model.status {
        case .running: return String(localized: "응답 중")
        case .waitingApproval: return String(localized: "승인 대기")
        case .idle: return String(localized: "대기")
        case .error: return String(localized: "오류")
        default: return model.status.label
        }
    }

    private func closeSession() async {
        guard let session = currentSession else { return }
        do {
            try await store.close(session)
            showsInfo = false
            dismiss()
        } catch {
            await store.refresh()
        }
    }
}

/// 아이템 종류 → 카드/행.
private struct TimelineItemRow: View {
    let item: TimelineItem
    let onRetry: () -> Void
    let onApprovalDetail: (Approval) -> Void

    var body: some View {
        switch item.payload {
        case .userMessage(let p): UserMessageCard(item: item, payload: p)
        case .assistantMessage(let p): AssistantMessageCard(item: item, payload: p)
        case .reasoning(let p): ReasoningCard(item: item, payload: p)
        case .toolCall(let p): ToolCallCard(item: item, payload: p)
        case .fileChange(let p): FileChangeCard(item: item, payload: p)
        case .plan(let p): PlanCard(item: item, payload: p)
        case .approval(let p):
            ApprovalCard(item: item, payload: p, onShowDetail: p.resolution == nil ? { onApprovalDetail(p.approval) } : nil)
        case .turnSummary(let p): TurnSummaryRow(payload: p)
        case .error(let p): ErrorCard(item: item, payload: p, onRetry: onRetry)
        case .system(let p): SystemRow(payload: p)
        }
    }
}

/// 세션 정보 시트: cwd, agent, nativeId, 생성 시각, "세션 닫기".
private struct SessionInfoSheet: View {
    @Environment(\.dismiss) private var dismiss
    let session: Session?
    let onClose: () async -> Void
    @State private var isClosing = false

    var body: some View {
        NavigationStack {
            List {
                if let session {
                    Section {
                        LabeledContent("디렉토리") {
                            Text(session.cwd).font(.caption.monospaced()).multilineTextAlignment(.trailing)
                        }
                        LabeledContent("에이전트", value: session.agent.displayName)
                        LabeledContent("모드", value: session.mode.rawValue)
                        LabeledContent("상태", value: session.status.label)
                        LabeledContent("네이티브 ID") {
                            Text(session.nativeId ?? String(localized: "없음")).font(.caption.monospaced())
                        }
                        LabeledContent("생성", value: session.createdAt.formatted(date: .abbreviated, time: .shortened))
                    }
                    if session.status != .closed {
                        Section {
                            Button("세션 닫기", role: .destructive) {
                                Task {
                                    isClosing = true
                                    await onClose()
                                    isClosing = false
                                }
                            }
                            .disabled(isClosing)
                        }
                    }
                } else {
                    ContentUnavailableView("세션을 찾을 수 없습니다", systemImage: "questionmark.circle")
                }
            }
            .navigationTitle("세션 정보")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("완료") { dismiss() }
                }
            }
        }
    }
}
