import SwiftUI

/// 세션 목록 행. 탭하면 `Session` 값을 NavigationStack 에 push 한다(목적지는 홈이 `TimelineView` 로 매핑).
/// 스와이프 "닫기"는 `onClose` 가 있고 세션이 닫히지 않았을 때만 보인다.
struct SessionRowView: View {
    let session: Session
    var onClose: (() -> Void)?
    /// iPad 사이드바: 값이 있으면 push 대신 이 콜백으로 선택한다.
    var onSelect: ((Session) -> Void)? = nil
    var isSelected = false
    /// 팀원 세션이면 `TeamsStore.badge(for:teams:)` 결과(`🧑‍💻 지연 · backend`). 경로 대신 캡션에 보인다.
    var teamBadge: String? = nil

    var body: some View {
        Group {
            if let onSelect {
                Button {
                    onSelect(session)
                } label: {
                    rowContent
                }
                .buttonStyle(.plain)
                .listRowBackground(isSelected ? Color.accentColor.opacity(0.14) : nil)
                .accessibilityAddTraits(isSelected ? .isSelected : [])
            } else {
                NavigationLink(value: session) {
                    rowContent
                }
            }
        }
        .accessibilityLabel(accessibilityText)
        .swipeActions(edge: .trailing) {
            if session.status != .closed, let onClose {
                Button("닫기", systemImage: "xmark.circle", action: onClose)
                    .tint(.gray)
            }
        }
    }

    private var rowContent: some View {
            HStack(alignment: .top, spacing: 10) {
                statusIndicator
                    .padding(.top, 5)
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        AgentBadge(agent: session.agent)
                        Text(session.displayTitle)
                            .font(.body)
                            .lineLimit(1)
                    }
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                if session.status == .waitingApproval || session.pendingApprovals > 0 {
                    ApprovalBadge(count: max(session.pendingApprovals, 1))
                }
            }
            .padding(.vertical, 2)
            .contentShape(Rectangle())
    }

    private var subtitle: String {
        "\(teamBadge ?? Formatters.abbreviatedPath(session.cwd)) · \(Formatters.relativeTime(session.updatedAt))"
    }

    private var accessibilityText: String {
        "\(session.agent.displayName), \(session.displayTitle), \(session.status.label)"
    }

    /// 상태 점(IOS.md 5.2 의 색 규칙). `running` 은 점 대신 진행 표시, `closed` 는 없음.
    @ViewBuilder
    private var statusIndicator: some View {
        switch session.status {
        case .running:
            ProgressView()
                .controlSize(.mini)
                .tint(.blue)
                .frame(width: 10, height: 10)
        case .closed:
            Color.clear.frame(width: 10, height: 10)
        default:
            Circle()
                .fill(session.status.color)
                .frame(width: 10, height: 10)
        }
    }
}

/// "Claude" / "Codex" 텍스트 캡슐.
struct AgentBadge: View {
    let agent: AgentKind

    var body: some View {
        Text(agent.shortName)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(.secondary.opacity(0.18), in: Capsule())
    }
}

/// 승인 대기 건수. 노란 손 + 숫자.
struct ApprovalBadge: View {
    let count: Int

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "hand.raised.fill")
            Text(count, format: .number)
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(.yellow)
        .accessibilityLabel("승인 대기 \(count)건")
    }
}

extension Session {
    /// 제목 → preview 첫 줄 → "새 세션".
    var displayTitle: String {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { return trimmed }
        if let firstLine = preview?
            .split(separator: "\n", omittingEmptySubsequences: true)
            .map({ $0.trimmingCharacters(in: .whitespaces) })
            .first(where: { !$0.isEmpty })
        {
            return firstLine
        }
        return String(localized: "새 세션")
    }
}

extension AgentKind {
    /// 배지용 짧은 이름.
    var shortName: String {
        switch self {
        case .claude: return "Claude"
        case .codex: return "Codex"
        case .unknown: return rawValue
        }
    }
}

extension SessionStatus {
    var label: String {
        switch self {
        case .starting: return String(localized: "시작 중")
        case .idle: return String(localized: "대기")
        case .running: return String(localized: "실행 중")
        case .waitingApproval: return String(localized: "승인 대기")
        case .error: return String(localized: "오류")
        case .closed: return String(localized: "닫힘")
        case .unknown: return String(localized: "알 수 없음")
        }
    }

    /// 상태 점 색(IOS.md 5.4: 시스템 색만).
    var color: Color {
        switch self {
        case .running: return .blue
        case .waitingApproval: return .yellow
        case .error: return .red
        case .idle, .starting: return .gray
        case .closed, .unknown: return .clear
        }
    }
}
