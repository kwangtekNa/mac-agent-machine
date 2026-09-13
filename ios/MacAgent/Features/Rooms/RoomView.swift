import SwiftUI

/// 방 화면(PROTOCOL.md 6.3, IOS.md 5.3 규칙을 방에 적용). `AppState.roomModel(for:roomId:client:)` 로 방별 `RoomModel` 을 얻는다(회전·재진입에도 유지).
/// 바깥 스택 안에서 push 되는 화면이므로 자체 스택을 만들지 않는다(IOS.md 9.1).
struct RoomView: View {
    @Environment(AppState.self) private var appState
    let teamId: String
    let roomId: String

    var body: some View {
        if let client = appState.client {
            RoomScreen(model: appState.roomModel(for: teamId, roomId: roomId, client: client))
                .id(roomId)
        } else {
            ContentUnavailableView("서버에 연결되어 있지 않습니다", systemImage: "wifi.slash", description: Text("설정에서 서버에 다시 연결하세요"))
        }
    }
}

/// `TimelineScreen` 과 같은 골격: 스크롤 바닥 앵커·"새 메시지" 칩·`safeAreaInset` 배너+상태 줄+컴포저·`scenePhase` 처리·툴바.
struct RoomScreen: View {
    private static let bottomId = "room.bottom"

    @Environment(AppState.self) private var appState
    @Environment(TeamsStore.self) private var teamsStore
    @Environment(SessionsStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    let model: RoomModel
    @State private var isAtBottom = true
    @State private var showsNewMessages = false
    @State private var showsMembers = false
    @State private var insertRequest: String?
    /// compact: 팀원 시트가 닫힌 뒤 push 할 타임라인.
    @State private var pendingMember: MemberTimelineRef?
    @State private var pushedMember: MemberTimelineRef?

    var body: some View {
        VStack(spacing: 0) {
            if let fatal = model.fatalError {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
                    Text(fatal).font(.subheadline)
                    Spacer(minLength: 0)
                    Button("다시 시도") { Task { await model.start() } }
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
                RoomStatusLine(model: model)
                RoomComposer(model: model, insertRequest: $insertRequest)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 0) {
                    if let member = model.dmMember {
                        MemberChip(member: member, compact: true)
                    } else {
                        Text("#전체").font(.headline)
                    }
                    Text(teamName)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("room.title")
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    showsMembers = true
                } label: {
                    Image(systemName: "person.2")
                }
                .accessibilityLabel("팀원")
                .accessibilityIdentifier("room.members")
                if horizontalSizeClass != .regular {
                    NavigationLink(value: TeamSettingsRef(teamId: model.teamId)) {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("팀 설정")
                    .accessibilityIdentifier("room.settings")
                }
            }
        }
        .sheet(isPresented: $showsMembers, onDismiss: openPendingMember) {
            RoomMembersSheet(model: model, sessions: store.sessions) { member in
                pendingMember = MemberTimelineRef(sessionId: member)
            }
        }
        .navigationDestination(item: $pushedMember) { ref in
            TimelineView(sessionId: ref.sessionId)
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
                    ForEach(model.entries) { entry in
                        RoomEntryRow(entry: entry, members: model.members, onReply: reply)
                            .id(entry.id)
                    }
                    WorkingBubble(members: model.workingMembers, activity: .working)
                    WorkingBubble(members: model.queuedMembers, activity: .queued)
                    Color.clear
                        .frame(height: 1)
                        .id(Self.bottomId)
                        .onAppear {
                            isAtBottom = true
                            showsNewMessages = false
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
                    showsNewMessages = true
                }
            }
            .overlay(alignment: .bottom) {
                if showsNewMessages, !isAtBottom {
                    Button {
                        proxy.scrollTo(Self.bottomId, anchor: .bottom)
                    } label: {
                        Label("새 메시지", systemImage: "arrow.down").font(.caption.weight(.semibold))
                    }
                    .buttonStyle(.borderedProminent)
                    .clipShape(Capsule())
                    .padding(.bottom, 8)
                    .accessibilityIdentifier("room.newMessages")
                }
            }
        }
    }

    private var teamName: String {
        teamsStore.team(id: model.teamId)?.name ?? String(localized: "팀")
    }

    /// 컨텍스트 메뉴 "@이름에게 답장" → 컴포저에 `@이름 ` 삽입.
    private func reply(to member: TeamMember) {
        insertRequest = "@\(member.name) "
    }

    /// 팀원 시트가 닫힌 뒤: compact 는 push, regular(iPad) 는 디테일 열의 선택을 바꾼다.
    private func openPendingMember() {
        guard let ref = pendingMember else { return }
        pendingMember = nil
        if horizontalSizeClass == .regular {
            appState.selectedMemberSessionId = ref.sessionId
        } else {
            pushedMember = ref
        }
    }
}

/// 항목 종류 → 카드/행. 승인·변경 카드는 step 6 전까지 한 줄 placeholder.
struct RoomEntryRow: View {
    let entry: RoomEntry
    let members: [TeamMember]
    let onReply: (TeamMember) -> Void

    var body: some View {
        switch entry {
        case .message(let message):
            switch message.author {
            case .user:
                MessageCard(message: message, role: .user)
            case .agent(let memberId):
                MessageCard(message: message, role: .agent(member: members.first { $0.id == memberId }), onReply: onReply)
            case .system:
                SystemRow(payload: SystemPayload(text: message.text))
            }
        case .system(let message):
            SystemRow(payload: SystemPayload(text: message.text))
        case .approval(let message), .changes(let message):
            ItemCard(
                chrome: CardChrome(status: .completed, createdAt: message.createdAt, summary: nil),
                style: ItemStyle.roomStyle(for: entry)
            ) {
                Text(message.text)
                    .font(.subheadline)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .accessibilityIdentifier("room.card.\(message.id)")
        }
    }
}

/// 한글 조사(순수). 말풍선 "지연이 작업 중…" / "민수가 작업 중…".
enum KoreanParticle {
    /// 주격 조사: 마지막 글자가 받침 있는 한글이면 "이", 아니면 "가"(한글이 아니어도 "가").
    static func subject(after name: String) -> String {
        guard let scalar = name.unicodeScalars.last?.value, (0xAC00...0xD7A3).contains(scalar) else { return "가" }
        return (scalar - 0xAC00) % 28 == 0 ? "가" : "이"
    }
}

/// 임시 말풍선 문구(순수): "지연이 작업 중…", "지연, 민수가 작업 중…", "민수가 대기 중…".
enum WorkingBubbleText {
    enum Activity: Equatable {
        case working, queued
    }

    static func text(names: [String], activity: Activity) -> String? {
        guard let last = names.last else { return nil }
        let subject = names.joined(separator: ", ") + KoreanParticle.subject(after: last)
        switch activity {
        case .working: return String(localized: "\(subject) 작업 중…")
        case .queued: return String(localized: "\(subject) 대기 중…")
        }
    }
}

/// 메시지 목록 끝의 임시 말풍선. 답변(`room.message`)이 오고 `room.status` 로 상태가 바뀌면 사라진다.
struct WorkingBubble: View {
    let members: [TeamMember]
    let activity: WorkingBubbleText.Activity

    var body: some View {
        if let text = WorkingBubbleText.text(names: members.map(\.name), activity: activity) {
            HStack(spacing: 8) {
                if activity == .working {
                    ProgressView().controlSize(.mini)
                } else {
                    Image(systemName: "clock").foregroundStyle(.secondary)
                }
                Text("\(members.map(\.emoji).joined(separator: " ")) \(text)")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
            .padding(12)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier(activity == .working ? "room.working" : "room.queued")
        }
    }
}

/// 컴포저 위 상태 줄 "지연 작업 중 · 민수 대기 중" + "중단"(팀 전체 `room.interrupt`). 아무도 일하지 않으면 없다.
struct RoomStatusLine: View {
    let model: RoomModel

    static func text(working: [String], queued: [String]) -> String? {
        var parts: [String] = []
        if !working.isEmpty { parts.append(String(localized: "\(working.joined(separator: ", ")) 작업 중")) }
        if !queued.isEmpty { parts.append(String(localized: "\(queued.joined(separator: ", ")) 대기 중")) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    var body: some View {
        let working = model.workingMembers
        if let text = Self.text(working: working.map(\.name), queued: model.queuedMembers.map(\.name)) {
            HStack(spacing: 8) {
                if !working.isEmpty {
                    ProgressView().controlSize(.mini)
                }
                Text(text)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer(minLength: 8)
                if !working.isEmpty {
                    Button {
                        Task { await model.interrupt(memberId: nil) }
                    } label: {
                        Label("중단", systemImage: "stop.circle")
                    }
                    .font(.caption)
                    .buttonStyle(.borderless)
                    .tint(.red)
                    .accessibilityLabel("팀 작업 전부 중단")
                    .accessibilityIdentifier("room.status.interrupt")
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Color(.secondarySystemGroupedBackground))
            .accessibilityIdentifier("room.status")
        }
    }
}

/// 팀원 목록 시트(상태·브랜치). 세션이 있는 팀원을 탭하면 시트를 닫고 타임라인을 연다.
private struct RoomMembersSheet: View {
    let model: RoomModel
    let sessions: [Session]
    let onOpen: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("팀원").font(.headline)
                Spacer()
                Button("닫기") { dismiss() }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            TeamMemberStatusList(members: model.members, state: state(of:)) { member in
                guard let sessionId = member.sessionId else { return }
                onOpen(sessionId)
                dismiss()
            }
        }
        .presentationDetents([.medium, .large])
    }

    /// 방 이벤트의 상태가 있으면 그것, 없으면 세션 목록 조인.
    private func state(of member: TeamMember) -> TeamMemberState {
        model.memberStates[member.id] ?? TeamRoomsLogic.state(of: member, sessions: sessions)
    }
}
