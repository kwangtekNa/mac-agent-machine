import SwiftUI

/// 승인 시트의 입력 폼 상태. 뷰와 테스트가 같은 검증 규칙을 쓴다.
struct ApprovalFormState: Equatable {
    /// fieldId → 입력값. `choice` 는 첫 선택지가 기본값.
    var inputs: [String: String]
    /// "거절" 계열 옵션의 선택적 사유.
    var denyReason = ""
    /// 사유 필드가 펼쳐진 옵션 id.
    var expandedDenyOptionId: String?

    init(inputs: [String: String] = [:]) {
        self.inputs = inputs
    }

    init(approval: Approval) {
        var inputs: [String: String] = [:]
        for field in approval.inputFields {
            inputs[field.id] = field.type == .choice ? (field.choices?.first ?? "") : ""
        }
        self.inputs = inputs
    }

    /// `deny`, `abort` 는 사유를 받을 수 있다.
    static func isDenyLike(_ optionId: String) -> Bool {
        optionId == "deny" || optionId == "abort"
    }

    /// 입력을 함께 보내는 옵션(거절·취소 계열 제외).
    static func requiresInputs(_ optionId: String) -> Bool {
        !isDenyLike(optionId) && optionId != "cancel"
    }

    /// 모든 입력 필드가 채워졌는가(공백만은 비어 있는 것). 필드가 없으면 항상 true.
    func canSubmit(_ approval: Approval) -> Bool {
        approval.inputFields.allSatisfy { field in
            !(inputs[field.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    /// 필드가 없으면 nil(키 생략). 값은 트림.
    func payloadInputs(_ approval: Approval) -> [String: String]? {
        guard !approval.inputFields.isEmpty else { return nil }
        var result: [String: String] = [:]
        for field in approval.inputFields {
            result[field.id] = (inputs[field.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return result
    }

    /// 트림한 사유. 비어 있으면 nil(보내지 않는다).
    var reasonMessage: String? {
        let trimmed = denyReason.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

extension ApprovalKind {
    var symbol: String {
        switch self {
        case .command: "terminal"
        case .fileChange: "pencil.line"
        case .permission: "lock.shield"
        case .userInput: "questionmark.bubble"
        case .other, .unknown: "hand.raised.fill"
        }
    }
}

/// 승인 상세 시트. `NavigationStack` 안 `Form`. 처리되면(pending 에서 빠지면) 자동으로 닫힌다.
struct ApprovalSheet: View {
    let model: any ApprovalResponding
    let approvalId: String

    var body: some View {
        NavigationStack {
            ApprovalDetailForm(model: model, approvalId: approvalId)
        }
    }
}

/// 승인 상세 폼: 헤더, 내용(detail·diff), 입력 필드, 거절 사유, 옵션 버튼. 시트와 대기 목록(push) 양쪽에서 쓴다.
struct ApprovalDetailForm: View {
    @Environment(\.dismiss) private var dismiss
    let model: any ApprovalResponding
    let approvalId: String
    @State private var form: ApprovalFormState

    init(model: any ApprovalResponding, approvalId: String) {
        self.model = model
        self.approvalId = approvalId
        let approval = model.pendingApprovals.first { $0.approvalId == approvalId }
        _form = State(initialValue: approval.map(ApprovalFormState.init(approval:)) ?? ApprovalFormState())
    }

    private var approval: Approval? {
        model.pendingApprovals.first { $0.approvalId == approvalId }
    }

    private var isSubmitting: Bool {
        model.approvalSubmit == .submitting(approvalId: approvalId)
    }

    var body: some View {
        Group {
            if let approval {
                content(approval)
            } else {
                ContentUnavailableView("처리된 요청입니다", systemImage: "hand.raised")
            }
        }
        .navigationTitle("승인 요청")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("닫기") { dismiss() }
            }
        }
        .onChange(of: approval == nil) { _, gone in
            if gone { dismiss() }
        }
    }

    private func content(_ approval: Approval) -> some View {
        Form {
            Section {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: approval.kind.symbol)
                        .font(.title2)
                        .foregroundStyle(.yellow)
                        .frame(width: 28)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(approval.title).font(.headline)
                        Text(approval.prompt).font(.subheadline).foregroundStyle(.secondary)
                    }
                }
            }
            if approval.detail != nil || approval.diff != nil {
                Section("내용") {
                    if let detail = approval.detail {
                        Text(detail)
                            .font(.callout.monospaced())
                            .textSelection(.enabled)
                    }
                    if let diff = approval.diff {
                        DiffTextView(patch: diff)
                            .listRowInsets(EdgeInsets(top: 4, leading: 4, bottom: 4, trailing: 4))
                    }
                }
            }
            if !approval.inputFields.isEmpty {
                Section("답변") {
                    ForEach(approval.inputFields) { field in
                        inputRow(field)
                    }
                }
            }
            Section {
                ForEach(approval.options) { option in
                    optionRow(option, approval: approval)
                }
                if isSubmitting {
                    HStack {
                        Spacer()
                        ProgressView()
                        Spacer()
                    }
                }
                if case .failed(let id, let message) = model.approvalSubmit, id == approvalId {
                    Text(message).font(.caption).foregroundStyle(.red)
                }
            }
            .disabled(isSubmitting)
        }
    }

    @ViewBuilder
    private func inputRow(_ field: InputField) -> some View {
        switch field.type {
        case .secret:
            SecureField(field.label, text: binding(field.id))
        case .choice:
            Picker(field.label, selection: binding(field.id)) {
                ForEach(field.choices ?? [], id: \.self) { choice in
                    Text(choice).tag(choice)
                }
            }
        case .text, .unknown:
            TextField(field.label, text: binding(field.id))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        }
    }

    private func binding(_ fieldId: String) -> Binding<String> {
        Binding(
            get: { form.inputs[fieldId] ?? "" },
            set: { form.inputs[fieldId] = $0 }
        )
    }

    @ViewBuilder
    private func optionRow(_ option: ApprovalOption, approval: Approval) -> some View {
        if ApprovalFormState.isDenyLike(option.id) {
            ApprovalOptionButton(option: option, fullWidth: true) {
                form.expandedDenyOptionId = form.expandedDenyOptionId == option.id ? nil : option.id
            }
            if form.expandedDenyOptionId == option.id {
                TextField("사유(선택)", text: $form.denyReason, axis: .vertical)
                    .lineLimit(1...3)
                Button {
                    respond(approval, option)
                } label: {
                    Text("확인").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .tint(.red)
            }
        } else {
            ApprovalOptionButton(option: option, fullWidth: true) {
                respond(approval, option)
            }
            .disabled(ApprovalFormState.requiresInputs(option.id) && !form.canSubmit(approval))
        }
    }

    private func respond(_ approval: Approval, _ option: ApprovalOption) {
        let inputs = ApprovalFormState.requiresInputs(option.id) ? form.payloadInputs(approval) : nil
        let message = ApprovalFormState.isDenyLike(option.id) ? form.reasonMessage : nil
        Task { await model.respond(to: approval, optionId: option.id, inputs: inputs, message: message) }
    }
}
