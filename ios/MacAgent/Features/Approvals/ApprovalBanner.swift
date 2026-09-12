import SwiftUI

/// 배너·시트 버튼 스타일(IOS.md 5.3): primary → borderedProminent, secondary → bordered, destructive → bordered + tint(.red).
enum ApprovalButtonStyle: Equatable {
    case prominent, bordered, destructive

    static func map(_ style: ApprovalOptionStyle) -> ApprovalButtonStyle {
        switch style {
        case .primary: .prominent
        case .destructive: .destructive
        case .secondary, .unknown: .bordered
        }
    }
}

/// 배너에 무엇을 그릴지 계산한 결과. 뷰와 테스트가 같은 규칙을 쓴다.
struct ApprovalBannerState: Equatable {
    enum Action: Equatable {
        case option(ApprovalOption)
        /// 옵션이 3개를 넘을 때 처음 2개 뒤에 붙는 "더 보기"(시트).
        case more
        /// `user_input` 은 버튼 대신 "답변하기" 하나(시트).
        case answer
    }

    enum Subtitle: Equatable {
        case text(String)
        /// monospaced 로 그리는 `$` 명령 줄.
        case command(String)
    }

    static let maxInlineOptions = 3

    /// 가장 오래된 대기 승인.
    let approval: Approval
    let othersCount: Int
    let actions: [Action]
    let subtitle: Subtitle?

    /// 옵션 버튼의 VoiceOver 힌트: 대상 + 라벨. "이 명령 실행을 허용합니다".
    static func accessibilityHint(for option: ApprovalOption, kind: ApprovalKind) -> String {
        let subject: String
        switch kind {
        case .command: subject = String(localized: "이 명령 실행을")
        case .fileChange: subject = String(localized: "이 파일 변경을")
        case .permission: subject = String(localized: "이 권한 요청을")
        case .userInput: subject = String(localized: "이 질문에")
        case .other, .unknown: subject = String(localized: "이 요청을")
        }
        return "\(subject) \(option.label)합니다"
    }

    var othersLabel: String? {
        othersCount > 0 ? String(localized: "외 \(othersCount)건") : nil
    }

    static func make(pending: [Approval]) -> ApprovalBannerState? {
        guard let oldest = pending.min(by: { $0.requestedAt < $1.requestedAt }) else { return nil }
        return ApprovalBannerState(
            approval: oldest,
            othersCount: pending.count - 1,
            actions: actions(for: oldest),
            subtitle: subtitle(for: oldest)
        )
    }

    static func actions(for approval: Approval) -> [Action] {
        if approval.kind == .userInput { return [.answer] }
        if approval.options.count > maxInlineOptions {
            return approval.options.prefix(2).map(Action.option) + [.more]
        }
        return approval.options.map(Action.option)
    }

    static func subtitle(for approval: Approval) -> Subtitle? {
        switch approval.kind {
        case .command:
            return commandLine(approval.detail).map(Subtitle.command)
        case .fileChange:
            return .text(String(localized: "파일 \(fileCount(approval))개"))
        case .permission:
            return .text(String(localized: "권한 요청"))
        case .userInput:
            return .text(String(localized: "질문 \(approval.inputFields.count)개"))
        case .other, .unknown:
            return nil
        }
    }

    /// `detail` 에서 `$` 로 시작하는 첫 줄.
    static func commandLine(_ detail: String?) -> String? {
        detail?
            .split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first { $0.hasPrefix("$") }
    }

    /// diff 의 `diff --git` 헤더 수. 없으면 detail 이 있을 때 1.
    static func fileCount(_ approval: Approval) -> Int {
        let headers = approval.diff?.split(separator: "\n").filter { $0.hasPrefix("diff --git") }.count ?? 0
        if headers > 0 { return headers }
        return approval.detail == nil ? 0 : 1
    }
}

/// 옵션 버튼 하나. 배너와 시트가 같은 스타일 매핑을 쓴다.
struct ApprovalOptionButton: View {
    let option: ApprovalOption
    var fullWidth = false
    /// VoiceOver 힌트("이 명령 실행을 허용합니다"). `ApprovalBannerState.accessibilityHint` 로 만든다.
    var hint: String? = nil
    let action: () -> Void

    var body: some View {
        Group {
            switch ApprovalButtonStyle.map(option.style) {
            case .prominent:
                Button(action: action) { label }.buttonStyle(.borderedProminent)
            case .bordered:
                Button(action: action) { label }.buttonStyle(.bordered)
            case .destructive:
                Button(action: action) { label }.buttonStyle(.bordered).tint(.red)
            }
        }
        .accessibilityIdentifier("approval.option.\(option.id)")
        .accessibilityHint(hint ?? "")
    }

    private var label: some View {
        Text(option.label)
            .lineLimit(1)
            .frame(maxWidth: fullWidth ? .infinity : nil)
    }
}

/// 컴포저 위 승인 배너(IOS.md 5.3). 대기 승인이 있을 때만 보이며 가장 오래된 1건과 "외 N건"을 그린다.
/// 등장은 아래에서 올라오는 애니메이션 1회(모션 줄이기면 없음), 사라질 때는 즉시. 그 외 애니메이션 없음.
/// 세션 화면과 방 화면이 같은 배너를 쓴다(`ApprovalResponding`). 방에서는 제목 위에 작성자 캡션 한 줄이 붙는다.
struct ApprovalBanner: View {
    let model: any ApprovalResponding
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var detailApproval: Approval?
    @State private var showsPendingList = false

    var body: some View {
        let state = ApprovalBannerState.make(pending: model.pendingApprovals)
        VStack(spacing: 0) {
            if let state {
                banner(state)
                    .transition(reduceMotion
                        ? .identity
                        : .asymmetric(insertion: .move(edge: .bottom).combined(with: .opacity), removal: .identity))
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.25), value: state != nil)
        .sheet(item: $detailApproval) { approval in
            ApprovalSheet(model: model, approvalId: approval.approvalId)
        }
        .sheet(isPresented: $showsPendingList) {
            PendingApprovalsSheet(model: model)
        }
    }

    private func banner(_ state: ApprovalBannerState) -> some View {
        let approval = state.approval
        let isSubmitting = model.approvalSubmit == .submitting(approvalId: approval.approvalId)
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "hand.raised.fill")
                    .font(.title3)
                    .foregroundStyle(.yellow)
                    .frame(width: 24)
                VStack(alignment: .leading, spacing: 2) {
                    if let author = model.authorLabel(for: approval) {
                        Text(author)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Text(approval.title)
                        .font(.subheadline.weight(.bold))
                        .lineLimit(1)
                    Text(approval.prompt)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    subtitleView(state.subtitle)
                    if case .failed(let id, let message) = model.approvalSubmit, id == approval.approvalId {
                        Text(message)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }
                Spacer(minLength: 0)
                if let others = state.othersLabel {
                    Button(others) { showsPendingList = true }
                        .font(.caption)
                        .buttonStyle(.borderless)
                        .accessibilityLabel("대기 중인 승인 \(state.othersCount + 1)건 보기")
                }
            }
            // 큰 글자(Dynamic Type 접근성 크기)에서 버튼이 잘리지 않도록 가로가 모자라면 세로로 쌓는다.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    actionButtons(state, approval: approval, isSubmitting: isSubmitting)
                }
                VStack(alignment: .leading, spacing: 8) {
                    actionButtons(state, approval: approval, isSubmitting: isSubmitting)
                }
            }
            .controlSize(.small)
            .disabled(isSubmitting)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.yellow.opacity(0.18))
        .contentShape(Rectangle())
        .onTapGesture { detailApproval = approval }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("승인 요청: \(approval.title)")
    }

    @ViewBuilder
    private func subtitleView(_ subtitle: ApprovalBannerState.Subtitle?) -> some View {
        switch subtitle {
        case .command(let line):
            Text(line).font(.caption.monospaced()).lineLimit(1).truncationMode(.middle)
        case .text(let text):
            Text(text).font(.caption).foregroundStyle(.secondary)
        case nil:
            EmptyView()
        }
    }

    @ViewBuilder
    private func actionButtons(_ state: ApprovalBannerState, approval: Approval, isSubmitting: Bool) -> some View {
        ForEach(Array(state.actions.enumerated()), id: \.offset) { _, action in
            actionButton(action, approval: approval)
        }
        if isSubmitting {
            ProgressView().controlSize(.small)
        }
    }

    @ViewBuilder
    private func actionButton(_ action: ApprovalBannerState.Action, approval: Approval) -> some View {
        switch action {
        case .option(let option):
            ApprovalOptionButton(option: option, hint: ApprovalBannerState.accessibilityHint(for: option, kind: approval.kind)) {
                Task { await model.respond(to: approval, optionId: option.id, inputs: nil, message: nil) }
            }
        case .more:
            Button("더 보기") { detailApproval = approval }
                .buttonStyle(.bordered)
        case .answer:
            Button("답변하기") { detailApproval = approval }
                .buttonStyle(.borderedProminent)
        }
    }
}
