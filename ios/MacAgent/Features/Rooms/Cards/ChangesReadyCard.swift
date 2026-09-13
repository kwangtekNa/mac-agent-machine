import SwiftUI

/// "변경 준비됨" 카드의 버튼·문구 규칙(순수). 뷰는 그리기만 하고, 상태 확정은 서버(`room.message.updated` 또는 REST 응답의 ChangeSet)다.
/// 낙관적 갱신은 없다: 전송 중은 `MergeSubmitState.submitting` 으로만 표시한다.
struct ChangesCardState: Equatable {
    enum Action: Equatable {
        /// "<baseBranch>에 병합" 버튼(확인 대화상자를 거쳐 `requestMerge`).
        case merge(label: String)
        /// 서버 `merging` 또는 이 변경의 REST 전송 중: 진행 표시 + 버튼 비활성.
        case merging
        case none
    }

    static let maxFiles = 5

    let changeId: String
    let baseBranch: String
    /// `변경 준비됨 · 파일 2개 · 커밋 1개`(message.text).
    let title: String
    /// `mam/backend/jiyeon → main`
    let branchLine: String
    /// 최대 `maxFiles` 개.
    let files: [FileChangeEntry]
    /// 넘치면 `외 N개`.
    let moreFilesLabel: String?
    let action: Action
    /// `ready` | `conflict`.
    let canDismiss: Bool
    /// merged `병합됨 · a1b2c3d`, dismissed `거절됨`, stale `새 변경으로 대체됨`, conflict 안내 캡션.
    let statusLine: String?
    let conflictFiles: [String]
    /// 아이콘(색은 항상 아이콘과 함께, IOS.md 5.4).
    let symbol: String
    /// ready/merging accent, merged green, conflict red, dismissed/stale secondary.
    let tint: Color
    /// `mergeSubmit == .failed(changeId, message)` 의 문구(더러운 작업 트리·다른 브랜치는 서버 메시지 그대로).
    let errorLine: String?

    /// 병합 확인 대화상자 제목.
    var mergeConfirmation: String {
        String(localized: "\(baseBranch)에 병합합니다. 프로젝트의 작업 트리가 깨끗해야 합니다.")
    }

    static func make(message: RoomMessage, member: TeamMember?, submit: MergeSubmitState) -> ChangesCardState {
        guard let change = message.changes else {
            return ChangesCardState(
                changeId: message.id, baseBranch: "", title: message.text, branchLine: "", files: [], moreFilesLabel: nil,
                action: .none, canDismiss: false, statusLine: nil, conflictFiles: [], symbol: "plus.forwardslash.minus",
                tint: .secondary, errorLine: nil
            )
        }
        var isSubmitting = false
        var errorLine: String?
        switch submit {
        case .submitting(let id) where id == change.id:
            isSubmitting = true
        case .failed(let id, let message) where id == change.id:
            errorLine = message
        default:
            break
        }

        let mergeLabel = String(localized: "\(change.baseBranch)에 병합")
        let action: Action
        let canDismiss: Bool
        let statusLine: String?
        let symbol: String
        let tint: Color
        switch change.status {
        case .ready:
            action = isSubmitting ? .merging : .merge(label: mergeLabel)
            canDismiss = true
            statusLine = nil
            symbol = "plus.forwardslash.minus"
            tint = .accentColor
        case .merging:
            action = .merging
            canDismiss = false
            statusLine = nil
            symbol = "plus.forwardslash.minus"
            tint = .accentColor
        case .merged:
            action = .none
            canDismiss = false
            statusLine = String(localized: "병합됨 · \(String(change.commit.prefix(7)))")
            symbol = "checkmark.circle.fill"
            tint = .green
        case .conflict:
            action = isSubmitting ? .merging : .none
            canDismiss = true
            let name = member?.name ?? String(localized: "팀원")
            statusLine = String(localized: "충돌이 났습니다. \(name)\(KoreanParticle.subject(after: name)) worktree 에서 해결하면 새 카드가 올라옵니다")
            symbol = "exclamationmark.triangle.fill"
            tint = .red
        case .dismissed:
            action = .none
            canDismiss = false
            statusLine = String(localized: "거절됨")
            symbol = "xmark.circle"
            tint = .secondary
        case .stale:
            action = .none
            canDismiss = false
            statusLine = String(localized: "새 변경으로 대체됨")
            symbol = "clock.arrow.circlepath"
            tint = .secondary
        case .unknown:
            action = .none
            canDismiss = false
            statusLine = nil
            symbol = "plus.forwardslash.minus"
            tint = .secondary
        }

        let overflow = change.files.count - maxFiles
        return ChangesCardState(
            changeId: change.id,
            baseBranch: change.baseBranch,
            title: message.text,
            branchLine: "\(change.branch) → \(change.baseBranch)",
            files: Array(change.files.prefix(maxFiles)),
            moreFilesLabel: overflow > 0 ? String(localized: "외 \(overflow)개") : nil,
            action: action,
            canDismiss: canDismiss,
            statusLine: statusLine,
            conflictFiles: change.conflictFiles,
            symbol: symbol,
            tint: tint,
            errorLine: errorLine
        )
    }
}

/// "변경 준비됨" 카드(PROTOCOL.md 6.5). 브랜치 줄, 파일 행(`FileChangeRow`), "<base>에 병합"(확인 후 `requestMerge`) · "거절"(`dismiss`).
/// 충돌이면 빨간 아이콘 + 충돌 파일 + 안내 캡션(해결 UI 는 없다. 해결은 에이전트 턴이 한다).
/// 버튼이 있으므로 접근성은 `.contain`(combine 금지).
struct ChangesReadyCard: View {
    let message: RoomMessage
    let member: TeamMember?
    let submit: MergeSubmitState
    let onMerge: () -> Void
    let onDismiss: () -> Void
    @State private var confirmsMerge = false

    var body: some View {
        let state = ChangesCardState.make(message: message, member: member, submit: submit)
        ItemCard(
            chrome: CardChrome(status: .completed, createdAt: message.createdAt, summary: nil),
            style: ItemStyle(symbol: state.symbol, tint: state.tint, defaultExpanded: true),
            title: state.title,
            accessibilityChildren: .contain
        ) {
            if let member {
                MemberChip(member: member)
            }
            Text(state.branchLine)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            ForEach(Array(state.files.enumerated()), id: \.offset) { _, file in
                FileChangeRow(file: file)
            }
            if let more = state.moreFilesLabel {
                Text(more)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ForEach(state.conflictFiles, id: \.self) { path in
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                        .frame(width: 14)
                    Text(path)
                        .font(.caption.monospaced())
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel(String(localized: "충돌 파일 \(path)"))
            }
            if let statusLine = state.statusLine {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: state.symbol)
                        .foregroundStyle(state.tint)
                    Text(statusLine)
                        .foregroundStyle(.secondary)
                }
                .font(.caption)
                .accessibilityElement(children: .combine)
            }
            actions(state)
            if let errorLine = state.errorLine {
                Text(errorLine)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .accessibilityIdentifier("room.changes.\(state.changeId)")
        .confirmationDialog(state.mergeConfirmation, isPresented: $confirmsMerge, titleVisibility: .visible) {
            Button(String(localized: "\(state.baseBranch)에 병합"), action: onMerge)
            Button("취소", role: .cancel) {}
        }
    }

    @ViewBuilder
    private func actions(_ state: ChangesCardState) -> some View {
        if state.action != .none || state.canDismiss {
            HStack(spacing: 8) {
                switch state.action {
                case .merge(let label):
                    Button(label) { confirmsMerge = true }
                        .buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("room.merge.\(state.changeId)")
                case .merging:
                    ProgressView().controlSize(.small)
                case .none:
                    EmptyView()
                }
                if state.canDismiss {
                    Button("거절", action: onDismiss)
                        .buttonStyle(.bordered)
                        .disabled(state.action == .merging)
                        .accessibilityIdentifier("room.dismiss.\(state.changeId)")
                }
            }
            .controlSize(.small)
            .padding(.top, 2)
        }
    }
}
