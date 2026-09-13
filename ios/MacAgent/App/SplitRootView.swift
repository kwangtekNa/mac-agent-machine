import SwiftUI

/// iPad(regular) 3열(IOS.md 4절): 사이드바 세션·팀 목록, 콘텐츠 타임라인 또는 방 목록→방 화면, 디테일 파일 브라우저 또는 팀원 열.
/// 선택과 세션·방별 모델은 `AppState` 가 들고 있어 회전·멀티태스킹으로 뷰가 다시 만들어져도 유지된다.
struct SplitRootView: View {
    @Environment(AppState.self) private var appState
    @Environment(SessionsStore.self) private var store
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    /// 타임라인 툴바 "파일" 버튼이 토글한다. 꺼지면 디테일 열에 안내만 남는다.
    @State private var showsFiles = true

    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            SessionsHomeView(selection: sessionSelection, teamSelection: teamSelection)
                .navigationSplitViewColumnWidth(min: 280, ideal: 340, max: 420)
        } content: {
            content
        } detail: {
            detail
        }
        .navigationSplitViewStyle(.balanced)
    }

    /// 세션과 팀 선택은 서로 배타적이다.
    private var sessionSelection: Binding<String?> {
        Binding(
            get: { appState.selectedSessionId },
            set: { id in
                appState.selectedSessionId = id
                if id != nil {
                    appState.selectedTeamId = nil
                    appState.selectedRoom = nil
                    appState.selectedMemberSessionId = nil
                }
            }
        )
    }

    private var teamSelection: Binding<String?> {
        Binding(
            get: { appState.selectedTeamId },
            set: { id in
                if id != appState.selectedTeamId {
                    appState.selectedRoom = nil
                    appState.selectedMemberSessionId = nil
                }
                appState.selectedTeamId = id
                if id != nil { appState.selectedSessionId = nil }
            }
        )
    }

    /// content 열 스택의 경로 = 선택된 방(있으면 `RoomView` 가 push 된 상태).
    private var roomPath: Binding<[RoomRef]> {
        Binding(
            get: { appState.selectedRoom.map { [$0] } ?? [] },
            set: { appState.selectedRoom = $0.last }
        )
    }

    @ViewBuilder
    private var content: some View {
        if let teamId = appState.selectedTeamId {
            NavigationStack(path: roomPath) {
                TeamRoomsView(teamId: teamId)
                    .navigationDestination(for: RoomRef.self) { ref in
                        RoomView(teamId: ref.teamId, roomId: ref.roomId)
                    }
            }
            .id(teamId)
            .navigationSplitViewColumnWidth(min: 360, ideal: 520)
        } else if let sessionId = appState.selectedSessionId {
            NavigationStack {
                TimelineView(sessionId: sessionId) { showsFiles.toggle() }
            }
            .navigationSplitViewColumnWidth(min: 360, ideal: 520)
        } else {
            ContentUnavailableView(
                "세션을 선택하세요",
                systemImage: "sidebar.left",
                description: Text("왼쪽 목록에서 세션이나 팀을 고르면 여기에 열립니다")
            )
        }
    }

    @ViewBuilder
    private var detail: some View {
        if let teamId = appState.selectedTeamId {
            MemberDetailColumn(teamId: teamId)
        } else if let sessionId = appState.selectedSessionId {
            if showsFiles, let cwd = cwd(for: sessionId), let model = appState.fileBrowserModel(for: sessionId, cwd: cwd) {
                FileBrowserView(model: model, showsCloseButton: false)
            } else {
                ContentUnavailableView(
                    "파일 브라우저가 닫혀 있습니다",
                    systemImage: "folder",
                    description: Text("타임라인 툴바의 파일 버튼으로 엽니다")
                )
            }
        } else {
            ContentUnavailableView(
                "파일",
                systemImage: "folder",
                description: Text("세션을 선택하면 작업 디렉토리를 볼 수 있습니다")
            )
        }
    }

    private func cwd(for sessionId: String) -> String? {
        store.session(id: sessionId)?.cwd ?? appState.timelineModels[sessionId]?.session?.cwd
    }
}

/// iPad 디테일 열: 고른 팀원의 타임라인(`AppState.selectedMemberSessionId`), 고르기 전에는 팀원 목록(상태·브랜치).
struct MemberDetailColumn: View {
    @Environment(AppState.self) private var appState
    @Environment(TeamsStore.self) private var teamsStore
    @Environment(SessionsStore.self) private var store
    let teamId: String

    private var memberPath: Binding<[MemberTimelineRef]> {
        Binding(
            get: { appState.selectedMemberSessionId.map { [MemberTimelineRef(sessionId: $0)] } ?? [] },
            set: { appState.selectedMemberSessionId = $0.last?.sessionId }
        )
    }

    var body: some View {
        NavigationStack(path: memberPath) {
            Group {
                if let team = teamsStore.team(id: teamId) {
                    TeamMemberStatusList(
                        members: team.members,
                        state: state(of:),
                        selectedSessionId: appState.selectedMemberSessionId
                    ) { member in
                        if let id = member.sessionId { appState.selectedMemberSessionId = id }
                    }
                    .navigationTitle("팀원")
                } else {
                    ContentUnavailableView("팀원", systemImage: "person.2", description: Text("팀을 선택하면 팀원 상태가 보입니다"))
                }
            }
            .navigationDestination(for: MemberTimelineRef.self) { ref in
                TimelineView(sessionId: ref.sessionId)
            }
        }
        .id(teamId)
    }

    /// 열려 있는 방 모델의 상태가 있으면 그것, 없으면 세션 목록 조인.
    private func state(of member: TeamMember) -> TeamMemberState {
        if let room = appState.selectedRoom,
           let model = appState.roomModels[.room(teamId: room.teamId, roomId: room.roomId)],
           let state = model.memberStates[member.id] {
            return state
        }
        return TeamRoomsLogic.state(of: member, sessions: store.sessions)
    }
}
