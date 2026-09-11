import SwiftUI

/// 세션 타임라인 화면(IOS.md 4·5·6절). `AppState.client` 로 세션별 `TimelineModel` 을 만든다.
struct TimelineView: View {
    @Environment(AppState.self) private var appState
    let sessionId: String
    /// iPad 3열: 값이 있으면 툴바 "파일" 버튼이 시트 대신 디테일 열을 토글한다.
    var onToggleFiles: (() -> Void)? = nil

    var body: some View {
        if let client = appState.client {
            TimelineScreen(
                sessionId: sessionId,
                model: appState.timelineModel(for: sessionId, client: client),
                client: client,
                onToggleFiles: onToggleFiles
            )
            .id(sessionId)
        } else {
            ContentUnavailableView("서버에 연결되어 있지 않습니다", systemImage: "wifi.slash", description: Text("설정에서 서버에 다시 연결하세요"))
        }
    }
}

private struct TimelineScreen: View {
    private static let bottomId = "timeline.bottom"

    @Environment(AppState.self) private var appState
    @Environment(SessionsStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss
    /// `AppState` 가 세션별로 보관한다(회전·크기 변화에도 유지).
    let model: TimelineModel
    @State private var isAtBottom = true
    @State private var showsNewEvents = false
    @State private var showsInfo = false
    @State private var focusRequest = 0
    @State private var detailApproval: Approval?
    /// compact 의 "대화 | 파일" 세그먼트(IOS.md 9.1). iPad 3열(`onToggleFiles` 있음)에서는 항상 대화.
    @State private var tab: SessionTab = .chat
    private let sessionId: String
    private let client: APIClient
    private let onToggleFiles: (() -> Void)?

    init(sessionId: String, model: TimelineModel, client: APIClient, onToggleFiles: (() -> Void)?) {
        self.sessionId = sessionId
        self.model = model
        self.client = client
        self.onToggleFiles = onToggleFiles
    }

    var body: some View {
        VStack(spacing: 0) {
            if onToggleFiles == nil {
                Picker("", selection: $tab) {
                    Text("대화").tag(SessionTab.chat)
                        .accessibilityIdentifier("timeline.tab.chat")
                    Text(filesLabel).tag(SessionTab.files)
                        .accessibilityIdentifier("timeline.tab.files")
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(Color(.systemGroupedBackground))
                .accessibilityIdentifier("timeline.tabs")
            }
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
            switch tab {
            case .chat: timeline
            case .files: filesTab
            }
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
                // 부제는 컨텍스트(idle/running)가 있으면 `컨텍스트 21% · 42k/200k`, 아니면 상태 텍스트(IOS.md 9.3).
                ContextGaugeView(
                    title: title,
                    statusText: statusText,
                    gauge: ContextGaugeState.make(status: model.status, context: model.contextUsage),
                    tint: model.contextTint
                ) {
                    showsInfo = true
                }
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                ModeMenu(mode: model.mode) { mode in
                    Task { await model.setMode(mode) }
                }
                if let onToggleFiles {
                    // iPad 3열: 디테일 열의 파일 브라우저를 토글한다. compact 는 세그먼트로 간다.
                    Button(action: onToggleFiles) {
                        Image(systemName: "folder")
                    }
                    .accessibilityLabel("파일")
                    .accessibilityIdentifier("timeline.files")
                }
                Button {
                    showsInfo = true
                } label: {
                    Image(systemName: "info.circle")
                }
                .accessibilityLabel("세션 정보")
                .accessibilityIdentifier("timeline.info")
            }
        }
        .sheet(isPresented: $showsInfo) {
            SessionInfoSheet(model: model, session: currentSession, client: client, onClose: closeSession)
        }
        .sheet(item: $detailApproval) { approval in
            ApprovalSheet(model: model, approvalId: approval.approvalId)
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

    /// "파일" 탭: 세션 cwd 를 루트로 하는 인라인 파일 브라우저. 모델은 `AppState` 가 세션별로 보관하므로 탭을 오가도 위치가 남는다.
    @ViewBuilder
    private var filesTab: some View {
        if let cwd = currentSession?.cwd {
            FileBrowserView(model: appState.fileBrowserModel(for: sessionId, cwd: cwd, client: client), embedded: true)
        } else {
            ContentUnavailableView("작업 디렉토리를 알 수 없습니다", systemImage: "folder", description: Text("세션 정보를 불러온 뒤 다시 시도하세요"))
        }
    }

    /// 변경된 파일이 있으면 "파일 3", 없으면 "파일".
    private var filesLabel: String {
        let count = model.changedFileCount
        return count > 0 ? String(localized: "파일 \(count)") : String(localized: "파일")
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

/// 세션 화면의 세그먼트(IOS.md 9.1).
private enum SessionTab: Hashable {
    case chat, files
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
