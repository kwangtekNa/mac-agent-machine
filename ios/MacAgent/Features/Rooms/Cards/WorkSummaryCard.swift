import SwiftUI

/// 에이전트 답변 아래 접힌 작업 요약 한 줄(순수): `도구 7회 · 파일 3개 변경 · 12초`(+ ` · $0.04 추정`). 파일 0개면 `파일 변경 없음`.
/// 비용은 어댑터 추정치라 단정하지 않고 "추정" 을 붙인다(ADR-016).
enum WorkSummaryLabel {
    static func parts(_ work: WorkSummary) -> [String] {
        var parts = [String(localized: "도구 \(work.toolCalls)회")]
        parts.append(
            work.filesChanged.isEmpty
                ? String(localized: "파일 변경 없음")
                : String(localized: "파일 \(work.filesChanged.count)개 변경")
        )
        parts.append(Formatters.duration(ms: work.durationMs))
        if let cost = work.costUsd {
            parts.append(String(localized: "\(Formatters.usd(cost)) 추정"))
        }
        return parts
    }

    static func line(_ work: WorkSummary) -> String {
        parts(work).joined(separator: " · ")
    }

    /// VoiceOver: "작업 요약, 도구 7회, 파일 3개 변경, 12초".
    static func accessibilityLabel(_ work: WorkSummary) -> String {
        ([String(localized: "작업 요약")] + parts(work)).joined(separator: ", ")
    }
}

/// 에이전트 `MessageCard` 바로 아래의 접힌 한 줄. 전체가 버튼이며 탭하면 그 팀원의 타임라인(`work.sessionId`)을 연다.
struct WorkSummaryCard: View {
    let messageId: String
    let member: TeamMember?
    let work: WorkSummary
    let onOpen: (String) -> Void

    var body: some View {
        Button {
            onOpen(work.sessionId)
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "hammer")
                    .foregroundStyle(.secondary)
                    .frame(width: 24)
                Text(WorkSummaryLabel.line(work))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 4)
                Image(systemName: "chevron.right")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(WorkSummaryLabel.accessibilityLabel(work))
        .accessibilityHint(hint)
        .accessibilityIdentifier("room.workSummary.\(messageId)")
    }

    private var hint: String {
        if let member { return String(localized: "\(member.name)의 타임라인 열기") }
        return String(localized: "팀원 타임라인 열기")
    }
}
