import Foundation

/// 승인 옵션. `id` 는 어댑터가 정한다(공통 값: `allow`, `allow_session`, `deny`, `abort`, `submit`, `cancel`).
struct ApprovalOption: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var label: String
    var style: ApprovalOptionStyle

    init(id: String, label: String, style: ApprovalOptionStyle) {
        self.id = id
        self.label = label
        self.style = style
    }
}

/// `user_input` 승인의 입력 필드. `choices` 는 `type == .choice` 일 때만 온다.
struct InputField: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var label: String
    var type: InputFieldType
    var choices: [String]?

    init(id: String, label: String, type: InputFieldType, choices: [String]? = nil) {
        self.id = id
        self.label = label
        self.type = type
        self.choices = choices
    }
}

/// PROTOCOL.md 3절 `Approval`.
struct Approval: Codable, Identifiable, Hashable, Sendable {
    var approvalId: String
    var itemId: String
    var kind: ApprovalKind
    var title: String
    var prompt: String
    /// nullable
    var detail: String?
    /// nullable. `file_change` 는 unified diff.
    var diff: String?
    var options: [ApprovalOption]
    var inputFields: [InputField]
    var requestedAt: Date

    var id: String { approvalId }

    init(
        approvalId: String,
        itemId: String,
        kind: ApprovalKind,
        title: String,
        prompt: String,
        detail: String?,
        diff: String?,
        options: [ApprovalOption],
        inputFields: [InputField],
        requestedAt: Date
    ) {
        self.approvalId = approvalId
        self.itemId = itemId
        self.kind = kind
        self.title = title
        self.prompt = prompt
        self.detail = detail
        self.diff = diff
        self.options = options
        self.inputFields = inputFields
        self.requestedAt = requestedAt
    }

    private enum CodingKeys: String, CodingKey {
        case approvalId, itemId, kind, title, prompt, detail, diff, options, inputFields, requestedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        approvalId = try c.decode(String.self, forKey: .approvalId)
        itemId = try c.decode(String.self, forKey: .itemId)
        kind = try c.decode(ApprovalKind.self, forKey: .kind)
        title = try c.decode(String.self, forKey: .title)
        prompt = try c.decode(String.self, forKey: .prompt)
        detail = try c.decodeIfPresent(String.self, forKey: .detail)
        diff = try c.decodeIfPresent(String.self, forKey: .diff)
        options = try c.decode([ApprovalOption].self, forKey: .options)
        inputFields = try c.decode([InputField].self, forKey: .inputFields)
        requestedAt = try c.decode(Date.self, forKey: .requestedAt)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(approvalId, forKey: .approvalId)
        try c.encode(itemId, forKey: .itemId)
        try c.encode(kind, forKey: .kind)
        try c.encode(title, forKey: .title)
        try c.encode(prompt, forKey: .prompt)
        try c.encode(detail, forKey: .detail)
        try c.encode(diff, forKey: .diff)
        try c.encode(options, forKey: .options)
        try c.encode(inputFields, forKey: .inputFields)
        try c.encode(requestedAt, forKey: .requestedAt)
    }
}

/// 승인이 처리된 결과. `approval` 아이템 payload 의 `resolution` 에 붙는다.
struct ApprovalResolution: Codable, Hashable, Sendable {
    var optionId: String
    var by: ApprovalResolvedBy
    var at: Date

    init(optionId: String, by: ApprovalResolvedBy, at: Date) {
        self.optionId = optionId
        self.by = by
        self.at = at
    }
}

/// `kind == approval` 아이템의 payload. `Approval` 필드 + `resolution?`.
struct ApprovalPayload: Codable, Hashable, Sendable {
    var approval: Approval
    var resolution: ApprovalResolution?

    init(approval: Approval, resolution: ApprovalResolution? = nil) {
        self.approval = approval
        self.resolution = resolution
    }

    private enum CodingKeys: String, CodingKey {
        case resolution
    }

    init(from decoder: Decoder) throws {
        approval = try Approval(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        resolution = try c.decodeIfPresent(ApprovalResolution.self, forKey: .resolution)
    }

    func encode(to encoder: Encoder) throws {
        try approval.encode(to: encoder)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(resolution, forKey: .resolution)
    }
}
