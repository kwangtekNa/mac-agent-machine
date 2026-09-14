import SwiftUI

/// 미리보기 시트가 목록으로 계산하는 것(순수): `GET /net/ports` 결과 → 행(제목·캡션), 빈 목록 문구, 직접 입력 검증.
struct PreviewPortsState: Equatable, Sendable {
    static let emptyMessage = String(localized: "열린 포트가 없습니다. 에이전트에게 개발 서버를 띄워 달라고 하세요.")
    /// loopback 바인딩 행의 회색 캡션.
    static let macOnlyCaption = String(localized: "Mac 안에서만 열림 — 폰에서 안 열릴 수 있습니다")

    struct Row: Equatable, Identifiable, Sendable {
        let port: Int
        let process: String
        /// loopback 바인딩이면 `macOnlyCaption`, 아니면 nil.
        let caption: String?

        var id: Int { port }
        /// `3000 · node`
        var title: String { "\(port) · \(process)" }
        var identifier: String { "preview.port.\(port)" }
    }

    var rows: [Row] = []

    var isEmpty: Bool { rows.isEmpty }

    /// `port` 오름차순. 서버가 합쳐 주지만 같은 포트가 겹쳐 오면 폰에서 열리는 쪽을 남긴다.
    static func make(ports: [NetPort]) -> PreviewPortsState {
        var byPort: [Int: NetPort] = [:]
        for port in ports {
            if let existing = byPort[port.port], !PreviewLink.isMacOnly(existing) { continue }
            byPort[port.port] = port
        }
        let rows = byPort.values
            .sorted { $0.port < $1.port }
            .map { Row(port: $0.port, process: $0.process, caption: PreviewLink.isMacOnly($0) ? macOnlyCaption : nil) }
        return PreviewPortsState(rows: rows)
    }

    /// 직접 입력 필드 → 포트. 숫자만, 1~65535.
    static func parsePort(_ text: String) -> Int? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.allSatisfy(\.isNumber), let port = Int(trimmed) else { return nil }
        return RecentPortsStore.isValid(port) ? port : nil
    }
}

/// 방·세션 툴바의 "미리보기" 시트: 열린 포트 목록(당겨서 새로고침) · 직접 입력 · 최근.
/// 행을 탭하면 `http://<서버 호스트>:<port>/` 를 앱 안 브라우저(`SFSafariViewController`)로 연다.
struct PreviewPortsSheet: View {
    @Environment(\.dismiss) private var dismiss

    let client: APIClient
    /// 앱에 저장된 서버 URL. 호스트만 쓴다.
    let serverURL: URL
    var recentStore = RecentPortsStore()

    @State private var state = PreviewPortsState()
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var customText = ""
    @State private var recent: [Int] = []
    @State private var safariLink: SafariLink?

    var body: some View {
        NavigationStack {
            List {
                portsSection
                customSection
                recentSection
                errorSection
            }
            .navigationTitle("미리보기")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("완료") { dismiss() }
                }
            }
            .refreshable { await load() }
            .task {
                recent = recentStore.ports
                await load()
            }
            .safariSheet(link: $safariLink)
        }
    }

    // MARK: - 섹션

    @ViewBuilder
    private var portsSection: some View {
        Section {
            if state.isEmpty {
                if isLoading {
                    ProgressView()
                } else {
                    Text(PreviewPortsState.emptyMessage)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("preview.empty")
                }
            } else {
                ForEach(state.rows) { row in
                    Button {
                        open(port: row.port)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(row.title)
                                .font(.body.monospaced())
                                .foregroundStyle(Color.primary)
                            if let caption = row.caption {
                                Text(caption)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .accessibilityIdentifier(row.identifier)
                }
            }
        } header: {
            HStack {
                Text("열린 포트")
                if isLoading, !state.isEmpty {
                    ProgressView().controlSize(.mini)
                }
            }
        }
    }

    private var customSection: some View {
        Section {
            HStack {
                TextField("포트", text: $customText)
                    .keyboardType(.numberPad)
                    .font(.body.monospaced())
                    .accessibilityIdentifier("preview.custom")
                Button("열기") {
                    if let port = PreviewPortsState.parsePort(customText) { open(port: port) }
                }
                .buttonStyle(.borderless)
                .disabled(PreviewPortsState.parsePort(customText) == nil)
                .accessibilityIdentifier("preview.open")
            }
        } header: {
            Text("직접 입력")
        } footer: {
            Text("Mac 의 \(serverHostLabel) 주소로 엽니다.")
        }
    }

    @ViewBuilder
    private var recentSection: some View {
        if !recent.isEmpty {
            Section("최근") {
                ForEach(recent, id: \.self) { port in
                    Button {
                        open(port: port)
                    } label: {
                        Text(String(port))
                            .font(.body.monospaced())
                            .foregroundStyle(Color.primary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .accessibilityIdentifier("preview.recent.\(port)")
                }
            }
        }
    }

    @ViewBuilder
    private var errorSection: some View {
        if let errorMessage {
            Section {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .accessibilityLabel("오류: \(errorMessage)")
            }
        }
    }

    private var serverHostLabel: String {
        serverURL.host() ?? serverURL.absoluteString
    }

    // MARK: - 동작

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            state = PreviewPortsState.make(ports: try await client.listeningPorts())
            errorMessage = nil
        } catch {
            errorMessage = ErrorMessages.message(for: error)
        }
    }

    private func open(port: Int) {
        recentStore.add(port)
        recent = recentStore.ports
        customText = ""
        safariLink = SafariLink(PreviewLink.previewURL(port: port, serverURL: serverURL))
    }
}
