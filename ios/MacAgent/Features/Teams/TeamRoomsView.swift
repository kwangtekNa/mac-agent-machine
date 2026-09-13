import SwiftUI

/// 방 목적지 값(`NavigationLink(value:)`). iPad 는 `AppState.selectedRoom` 으로도 쓴다.
struct RoomRef: Hashable, Sendable {
    let teamId: String
    let roomId: String
}

/// 팀 설정 목적지 값(compact 에서 방 목록·방 화면이 push 한다).
struct TeamSettingsRef: Hashable, Sendable {
    let teamId: String
}

/// 팀원 타임라인 목적지 값(방 화면·iPad 디테일 열).
struct MemberTimelineRef: Hashable, Sendable {
    let sessionId: String
}

/// 방 목록의 행 재료(순수).
struct TeamRoomRow: Identifiable, Equatable {
    enum Kind: Equatable {
        case group
        case dm(TeamMember)
    }

    let room: Room
    let kind: Kind

    var id: String { room.id }

    /// 접근성 식별자 `rooms.group` / `rooms.dm.<memberId>`.
    var identifier: String {
        switch kind {
        case .group: "rooms.group"
        case .dm(let member): "rooms.dm.\(member.id)"
        }
    }
}

enum TeamRoomsLogic {
    /// `#전체` 먼저, DM 은 팀원 순서. 팀원을 모르는 DM 은 뺀다.
    static func rows(team: Team) -> [TeamRoomRow] {
        let groups = team.rooms.filter { $0.kind == .group }.map { TeamRoomRow(room: $0, kind: .group) }
        let dms = team.members.compactMap { member -> TeamRoomRow? in
            guard let room = team.rooms.first(where: { $0.kind == .dm && $0.memberId == member.id }) else { return nil }
            return TeamRoomRow(room: room, kind: .dm(member))
        }
        return groups + dms
    }

    /// 방을 열지 않아도 보이는 상태: 세션 목록에 팀원 세션이 있으면 그 status 매핑(`MemberStatus`), 없으면 서버 `member.state`.
    static func state(of member: TeamMember, sessions: [Session]) -> TeamMemberState {
        TeamActivity.state(of: member, sessions: sessions)
    }

    /// `#전체` 행의 마지막 메시지 시각(상대 시간). 메시지가 없으면 nil.
    static func lastMessageLabel(_ room: Room, now: Date = .now) -> String? {
        room.lastMessageAt.map { Formatters.relativeTime($0, now: now) }
    }
}

/// 팀의 방 목록: `#전체` + 팀원별 DM. 탭하면 같은 스택에서 `RoomView` 로 push 한다.
/// 툴바: 팀 설정(compact 는 push, iPad 는 시트), 작업 전부 중단. 상태 점은 `TeamsStore`+`SessionsStore` 조인.
struct TeamRoomsView: View {
    @Environment(TeamsStore.self) private var teamsStore
    @Environment(SessionsStore.self) private var store
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    let teamId: String
    @State private var confirmsStop = false
    @State private var showsSettingsSheet = false
    @State private var isStopping = false
    @State private var errorMessage: String?

    var body: some View {
        if let team = teamsStore.team(id: teamId) {
            content(team)
        } else {
            ContentUnavailableView(
                "팀을 찾을 수 없습니다",
                systemImage: "person.3",
                description: Text("삭제됐거나 목록을 아직 읽지 못했습니다")
            )
        }
    }

    private func content(_ team: Team) -> some View {
        List {
            if let errorMessage {
                Section {
                    ErrorBannerRow(message: errorMessage) { self.errorMessage = nil }
                }
            }
            Section {
                ForEach(TeamRoomsLogic.rows(team: team)) { row in
                    NavigationLink(value: RoomRef(teamId: team.id, roomId: row.room.id)) {
                        RoomRowView(row: row, state: rowState(row))
                    }
                    .accessibilityIdentifier(row.identifier)
                }
            } footer: {
                Text("멘션 없는 #전체 메시지는 팀장에게, @이름 은 그 팀원에게 갑니다.")
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(team.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    confirmsStop = true
                } label: {
                    Image(systemName: "stop.circle")
                }
                .disabled(isStopping)
                .accessibilityLabel("작업 전부 중단")
                .accessibilityIdentifier("rooms.stopAll")
                if horizontalSizeClass == .regular {
                    Button {
                        showsSettingsSheet = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("팀 설정")
                    .accessibilityIdentifier("rooms.settings")
                } else {
                    NavigationLink(value: TeamSettingsRef(teamId: team.id)) {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("팀 설정")
                    .accessibilityIdentifier("rooms.settings")
                }
            }
        }
        .confirmationDialog("실행 중인 팀원 턴을 전부 중단할까요?", isPresented: $confirmsStop, titleVisibility: .visible) {
            Button("작업 전부 중단", role: .destructive) { Task { await stopAll() } }
        }
        .sheet(isPresented: $showsSettingsSheet) {
            NavigationStack {
                TeamSettingsView(teamId: team.id)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("닫기") { showsSettingsSheet = false }
                        }
                    }
            }
        }
        .refreshable {
            await teamsStore.refresh()
            await store.refresh()
        }
    }

    private func rowState(_ row: TeamRoomRow) -> TeamMemberState? {
        guard case .dm(let member) = row.kind else { return nil }
        return TeamRoomsLogic.state(of: member, sessions: store.sessions)
    }

    private func stopAll() async {
        isStopping = true
        errorMessage = nil
        defer { isStopping = false }
        do {
            _ = try await teamsStore.stop(id: teamId)
            await teamsStore.refresh()
        } catch {
            errorMessage = ErrorMessages.message(for: error)
        }
    }
}

/// 방 행: `#전체`(마지막 메시지 시각) 또는 팀원 DM(`MemberChip` + 상태 점 + 팀장 캡션).
struct RoomRowView: View {
    let row: TeamRoomRow
    /// DM 행의 상태 점. 그룹 행은 nil.
    var state: TeamMemberState?

    var body: some View {
        switch row.kind {
        case .group:
            HStack(spacing: 10) {
                Image(systemName: "number")
                    .foregroundStyle(.tint)
                    .frame(width: 28)
                Text("#전체")
                    .font(.body.weight(.semibold))
                Spacer(minLength: 0)
                if let last = TeamRoomsLogic.lastMessageLabel(row.room) {
                    Text(last)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 2)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("전체 방" + (TeamRoomsLogic.lastMessageLabel(row.room).map { ", 마지막 메시지 \($0)" } ?? ""))
        case .dm(let member):
            HStack(spacing: 10) {
                MemberChip(member: member)
                if member.isLead {
                    Text("팀장")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                if let state {
                    MemberStatusDot(state: state)
                }
            }
            .padding(.vertical, 2)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(member.name) DM, \(member.roleLabel)\(member.isLead ? ", 팀장" : "")" + (state.map { ", \($0.label)" } ?? ""))
        }
    }
}

/// 팀원 상태 행(순수 표시): 칩 + 팀장 배지 + 브랜치, 오른쪽에 상태 점·라벨(세션이 없으면 "세션 없음") + 선택적 chevron.
struct TeamMemberStatusRow: View {
    let member: TeamMember
    let state: TeamMemberState
    var showsChevron = false

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    MemberChip(member: member)
                    if member.isLead { LeadBadge() }
                }
                Text(member.branch)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 0)
            HStack(spacing: 4) {
                MemberStatusDot(state: state)
                Text(member.sessionId == nil ? String(localized: "세션 없음") : state.label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if showsChevron {
                Image(systemName: "chevron.right")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .contentShape(Rectangle())
    }
}

/// 팀원 상태 목록(iPad 디테일 열): 세션이 있는 팀원만 탭할 수 있다(타임라인 선택).
struct TeamMemberStatusList: View {
    let members: [TeamMember]
    let state: (TeamMember) -> TeamMemberState
    var selectedSessionId: String? = nil
    let onOpen: (TeamMember) -> Void

    var body: some View {
        List {
            Section {
                ForEach(members) { member in
                    let memberState = state(member)
                    Button {
                        onOpen(member)
                    } label: {
                        TeamMemberStatusRow(member: member, state: memberState, showsChevron: member.sessionId != nil)
                    }
                    .buttonStyle(.plain)
                    .disabled(member.sessionId == nil)
                    .listRowBackground(
                        selectedSessionId != nil && selectedSessionId == member.sessionId ? Color.accentColor.opacity(0.14) : nil
                    )
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("\(member.name), \(member.roleLabel), \(memberState.label), 브랜치 \(member.branch)")
                    .accessibilityIdentifier("members.row.\(member.id)")
                }
            } footer: {
                Text("팀원을 탭하면 그 세션의 타임라인이 열립니다.")
            }
        }
        .listStyle(.insetGrouped)
    }
}
