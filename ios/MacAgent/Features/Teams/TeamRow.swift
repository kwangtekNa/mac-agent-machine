import SwiftUI

/// 팀 행 배지의 재료(순수): 팀원 상태를 세션 목록과 조인해 실행·승인 대기 수를 센다.
struct TeamActivity: Equatable, Sendable {
    var running: Int
    var waitingApproval: Int

    /// 팀원 세션이 목록에 있으면 세션 status 매핑(`MemberStatus`), 없으면 서버가 준 `member.state`.
    static func state(of member: TeamMember, sessions: [Session]) -> TeamMemberState {
        if let id = member.sessionId, sessions.contains(where: { $0.id == id }) {
            return MemberStatus.status(member: member, roomState: nil, sessions: sessions)
        }
        return member.state
    }

    static func of(team: Team, sessions: [Session]) -> TeamActivity {
        var running = 0
        var waiting = 0
        for member in team.members {
            switch state(of: member, sessions: sessions) {
            case .running: running += 1
            case .waitingApproval: waiting += 1
            default: break
            }
        }
        return TeamActivity(running: running, waitingApproval: waiting)
    }

    /// `실행 N · 승인 M`. 둘 다 0 이면 nil.
    var badge: String? {
        if running == 0, waitingApproval == 0 { return nil }
        return String(localized: "실행 \(running) · 승인 \(waitingApproval)")
    }
}

extension TeamMemberState {
    var label: String {
        switch self {
        case .idle: String(localized: "대기")
        case .queued: String(localized: "대기열")
        case .running: String(localized: "실행 중")
        case .waitingApproval: String(localized: "승인 대기")
        case .error: String(localized: "오류")
        case .unknown: String(localized: "알 수 없음")
        }
    }

    /// 상태 점 색(IOS.md 5.4: 시스템 색만).
    var color: Color {
        switch self {
        case .running: .blue
        case .waitingApproval: .yellow
        case .error: .red
        case .queued, .idle: .gray
        case .unknown: .clear
        }
    }
}

/// 세션 홈 "팀" 섹션의 행: 겹친 이모지 아바타(최대 3) + 이름 + 프로젝트 + `실행 N · 승인 M`.
struct TeamRow: View {
    static let maxAvatars = 3

    let team: Team
    let activity: TeamActivity

    /// 오른쪽 텍스트: 배지가 있으면 배지, 없으면 팀원 수.
    static func trailingText(team: Team, activity: TeamActivity) -> String {
        activity.badge ?? String(localized: "팀원 \(team.members.count)명")
    }

    var body: some View {
        let trailing = Self.trailingText(team: team, activity: activity)
        HStack(spacing: 10) {
            avatars
            VStack(alignment: .leading, spacing: 2) {
                Text(team.name)
                    .font(.body)
                    .lineLimit(1)
                Text(Formatters.abbreviatedPath(team.cwd))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.head)
            }
            Spacer(minLength: 0)
            Text(trailing)
                .font(activity.badge == nil ? .caption : .caption.weight(.semibold))
                .foregroundStyle(activity.badge == nil ? .secondary : .primary)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("팀 \(team.name), \(Formatters.abbreviatedPath(team.cwd)), \(trailing)")
        .accessibilityIdentifier("teams.row.\(team.id)")
    }

    private var avatars: some View {
        HStack(spacing: -8) {
            ForEach(Array(team.members.prefix(Self.maxAvatars).enumerated()), id: \.offset) { _, member in
                Text(member.emoji)
                    .font(.body)
                    .frame(width: 28, height: 28)
                    .background(Color(.tertiarySystemGroupedBackground), in: Circle())
                    .overlay(Circle().stroke(Color(.secondarySystemGroupedBackground), lineWidth: 1.5))
            }
        }
        .frame(minWidth: 28)
    }
}
