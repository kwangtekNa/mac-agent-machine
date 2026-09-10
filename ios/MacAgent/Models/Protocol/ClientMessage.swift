import Foundation

/// PROTOCOL.md 2절 클라이언트 → 서버 메시지. wire 모양은 `{ "type": "...", ...평탄한 필드 }`.
enum ClientMessage: Codable, Hashable, Sendable {
    case turnStart(text: String, attachments: [Attachment]? = nil)
    case turnInterrupt
    case approvalRespond(approvalId: String, optionId: String, inputs: [String: String]? = nil, message: String? = nil)
    case sessionSetMode(mode: SessionMode)
    case ping

    /// wire 의 `type` 값. **엄격**하다.
    enum MessageType: String, Codable, Hashable, Sendable, CaseIterable {
        case turnStart = "turn.start"
        case turnInterrupt = "turn.interrupt"
        case approvalRespond = "approval.respond"
        case sessionSetMode = "session.setMode"
        case ping
    }

    private enum CodingKeys: String, CodingKey {
        case type, text, attachments, approvalId, optionId, inputs, message, mode
    }

    var type: MessageType {
        switch self {
        case .turnStart: .turnStart
        case .turnInterrupt: .turnInterrupt
        case .approvalRespond: .approvalRespond
        case .sessionSetMode: .sessionSetMode
        case .ping: .ping
        }
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(MessageType.self, forKey: .type)
        switch type {
        case .turnStart:
            self = .turnStart(
                text: try c.decode(String.self, forKey: .text),
                attachments: try c.decodeIfPresent([Attachment].self, forKey: .attachments)
            )
        case .turnInterrupt:
            self = .turnInterrupt
        case .approvalRespond:
            self = .approvalRespond(
                approvalId: try c.decode(String.self, forKey: .approvalId),
                optionId: try c.decode(String.self, forKey: .optionId),
                inputs: try c.decodeIfPresent([String: String].self, forKey: .inputs),
                message: try c.decodeIfPresent(String.self, forKey: .message)
            )
        case .sessionSetMode:
            self = .sessionSetMode(mode: try c.decode(SessionMode.self, forKey: .mode))
        case .ping:
            self = .ping
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(type, forKey: .type)
        switch self {
        case .turnStart(let text, let attachments):
            try c.encode(text, forKey: .text)
            try c.encodeIfPresent(attachments, forKey: .attachments)
        case .turnInterrupt, .ping:
            break
        case .approvalRespond(let approvalId, let optionId, let inputs, let message):
            try c.encode(approvalId, forKey: .approvalId)
            try c.encode(optionId, forKey: .optionId)
            try c.encodeIfPresent(inputs, forKey: .inputs)
            try c.encodeIfPresent(message, forKey: .message)
        case .sessionSetMode(let mode):
            try c.encode(mode, forKey: .mode)
        }
    }
}
