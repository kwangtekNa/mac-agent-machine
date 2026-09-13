import SwiftUI

/// 팀원 이모지 아바타: 원형 `tertiarySystemGroupedBackground` 위 이모지. 크기는 Dynamic Type 스타일로 근사한다(고정 포인트 폰트 없음).
struct MemberAvatar: View {
    let member: TeamMember
    var size: CGFloat = 28

    var body: some View {
        Text(member.emoji)
            .font(size <= 22 ? .callout : (size <= 32 ? .body : .title2))
            .frame(width: size, height: size)
            .background(Color(.tertiarySystemGroupedBackground), in: Circle())
            .accessibilityHidden(true)
    }
}

/// 역할 캡슐(`개발자`, `팀장`). `.caption2`, 시스템 색만.
struct RoleBadge: View {
    let label: String

    var body: some View {
        Text(label)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(.secondary.opacity(0.18), in: Capsule())
            .lineLimit(1)
    }
}

/// 팀원 칩: 아바타 + 이름 + 역할 배지 + Claude/Codex 캡션. `compact` 는 아바타와 이름만(제안 칩·툴바용).
struct MemberChip: View {
    let member: TeamMember
    var compact = false

    /// 접근성·테스트용 한 줄: `🧑‍💻 지연 · 개발자 · Codex`.
    static func text(for member: TeamMember) -> String {
        "\(member.emoji) \(member.name) · \(member.roleLabel) · \(member.agent.shortName)"
    }

    var body: some View {
        HStack(spacing: 6) {
            MemberAvatar(member: member, size: compact ? 20 : 28)
            Text(member.name)
                .font(compact ? .subheadline.weight(.semibold) : .subheadline.weight(.semibold))
                .lineLimit(1)
            if !compact {
                RoleBadge(label: member.roleLabel)
                Text(member.agent.shortName)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(compact ? "\(member.emoji) \(member.name)" : Self.text(for: member))
    }
}

/// 팀원 상태 점(IOS.md 5.4: 시스템 색 + 아이콘 동반). idle 회색 원, queued 노란 테두리 원, running 파랑 진행 표시,
/// waitingApproval 노란 손, error 빨간 삼각형.
struct MemberStatusDot: View {
    let state: TeamMemberState

    var body: some View {
        Group {
            switch state {
            case .idle:
                Image(systemName: "circle.fill").foregroundStyle(.gray)
            case .queued:
                Image(systemName: "circle").foregroundStyle(.yellow)
            case .running:
                ProgressView().controlSize(.mini).tint(.blue)
            case .waitingApproval:
                Image(systemName: "hand.raised.fill").foregroundStyle(.yellow)
            case .error:
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
            case .unknown:
                Image(systemName: "questionmark.circle").foregroundStyle(.secondary)
            }
        }
        .font(.caption)
        .frame(width: 16, height: 16)
        .accessibilityLabel(state.label)
    }
}
