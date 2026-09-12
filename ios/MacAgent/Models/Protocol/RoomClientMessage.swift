import Foundation

/// PROTOCOL.md 6.3 방 WebSocket 클라이언트 → 서버 메시지(2026-09-12 추가). wire 모양은 `{ "type": "...", ...평탄한 필드 }`.
/// 승인 응답은 방 WS 로 보내지 않는다(기존 `POST /sessions/:id/approvals/:approvalId`).
enum RoomClientMessage: Codable, Hashable, Sendable {
    /// `POST .../messages` 와 같은 본문·규칙. 결과는 `room.message` 로 온다.
    case send(text: String, attachments: [Attachment]? = nil)
    /// 그 팀원의 실행 중 턴 중단. `memberId` 생략 시 팀 전체(`POST /teams/:id/stop`).
    case interrupt(memberId: String? = nil)
    case ping

    /// wire 의 `type` 값. **엄격**하다.
    enum MessageType: String, Codable, Hashable, Sendable, CaseIterable {
        case send = "room.send"
        case interrupt = "room.interrupt"
        case ping
    }

    private enum CodingKeys: String, CodingKey {
        case type, text, attachments, memberId
    }

    var type: MessageType {
        switch self {
        case .send: .send
        case .interrupt: .interrupt
        case .ping: .ping
        }
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(MessageType.self, forKey: .type) {
        case .send:
            self = .send(
                text: try c.decode(String.self, forKey: .text),
                attachments: try c.decodeIfPresent([Attachment].self, forKey: .attachments)
            )
        case .interrupt:
            self = .interrupt(memberId: try c.decodeIfPresent(String.self, forKey: .memberId))
        case .ping:
            self = .ping
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(type, forKey: .type)
        switch self {
        case .send(let text, let attachments):
            try c.encode(text, forKey: .text)
            try c.encodeIfPresent(attachments, forKey: .attachments)
        case .interrupt(let memberId):
            try c.encodeIfPresent(memberId, forKey: .memberId)
        case .ping:
            break
        }
    }
}
