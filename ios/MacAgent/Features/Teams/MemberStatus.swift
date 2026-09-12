import Foundation

/// 팀 화면용 팀원 상태 계산(순수). 방 이벤트(`room.snapshot`/`room.status`)의 상태가 있으면 그것을 쓰고,
/// 없으면 세션 목록에서 팀원 세션의 `status` 를 `TeamMemberState` 로 매핑한다. 세션이 없으면 `idle`.
enum MemberStatus {
    static func status(member: TeamMember, roomState: TeamMemberState?, sessions: [Session]) -> TeamMemberState {
        if let roomState { return roomState }
        guard let sessionId = member.sessionId,
              let session = sessions.first(where: { $0.id == sessionId })
        else { return .idle }
        switch session.status {
        case .running: return .running
        case .waitingApproval: return .waitingApproval
        case .error: return .error
        case .starting, .idle, .closed, .unknown: return .idle
        }
    }
}
