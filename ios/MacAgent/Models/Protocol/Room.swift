import Foundation

// PROTOCOL.md 6.1 방·메시지·변경 모델(2026-09-12 추가). `RoomAuthor.kind` 만 엄격한 판별자다.

enum RoomKind: String, LenientRawEnum {
    case group, dm
    case unknown
}

struct Room: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var teamId: String
    var kind: RoomKind
    /// nullable. DM 상대. 그룹방은 `null`.
    var memberId: String?
    /// 그룹방 `전체`, DM 은 팀원 이름.
    var name: String
    /// 방 이벤트 로그의 마지막 seq(세션 seq 와 별개).
    var lastSeq: Int
    /// nullable. 메시지가 없으면 `null`.
    var lastMessageAt: Date?
}

/// 메시지 작성자. `kind` 판별자는 **엄격**하다: 모르는 값이면 `DecodingError`(PROTOCOL.md 0절).
enum RoomAuthor: Codable, Hashable, Sendable {
    case user
    case agent(memberId: String)
    case system

    enum Kind: String, Codable, Hashable, Sendable, CaseIterable {
        case user, agent, system
    }

    private enum CodingKeys: String, CodingKey {
        case kind, memberId
    }

    var kind: Kind {
        switch self {
        case .user: .user
        case .agent: .agent
        case .system: .system
        }
    }

    /// `.agent` 일 때만 값.
    var memberId: String? {
        if case .agent(let memberId) = self { return memberId }
        return nil
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(Kind.self, forKey: .kind) {
        case .user: self = .user
        case .agent: self = .agent(memberId: try c.decode(String.self, forKey: .memberId))
        case .system: self = .system
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(kind, forKey: .kind)
        if case .agent(let memberId) = self {
            try c.encode(memberId, forKey: .memberId)
        }
    }
}

/// 에이전트 답변 메시지에 붙는 턴 요약(접힌 작업 카드의 재료).
struct WorkSummary: Codable, Hashable, Sendable {
    var sessionId: String
    var turnId: String
    /// 턴 안의 `tool_call` 아이템 수.
    var toolCalls: Int
    /// worktree 기준 상대 경로.
    var filesChanged: [String]
    var durationMs: Int
    /// `turn.completed` 와 같은 객체.
    var usage: Usage
    /// optional(키 생략 가능). 어댑터가 주지 않으면(Codex) 없다.
    var costUsd: Double?
}

enum RoomMessageKind: String, LenientRawEnum {
    case text, approval, changes, system
    case unknown
}

/// 방에 미러링된 승인. 실제 응답은 기존 `POST /sessions/:sessionId/approvals/:approvalId`.
struct RoomApproval: Codable, Hashable, Sendable {
    var memberId: String
    var sessionId: String
    var approval: Approval
    /// nullable. 응답 전 `null`.
    var resolution: ApprovalResolution?
}

/// `stale` 은 같은 팀원의 더 새로운 ChangeSet 이 생겨 대체된 것.
enum ChangeSetStatus: String, LenientRawEnum {
    case ready, merging, merged, conflict, dismissed, stale
    case unknown
}

/// 턴 종료 시 서버가 worktree 를 커밋해 만든 "변경 준비됨" 묶음.
struct ChangeSet: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var teamId: String
    var memberId: String
    var sessionId: String
    var turnId: String
    var branch: String
    var baseBranch: String
    /// 팀원 브랜치 HEAD(40자 hex).
    var commit: String
    /// `file_change.files[]` 와 같은 모양.
    var files: [FileChangeEntry]
    /// `baseBranch` 대비 앞선 커밋 수.
    var commits: Int
    var status: ChangeSetStatus
    /// `conflict` 일 때 충돌 파일. 그 외 `[]`.
    var conflictFiles: [String]
    /// 이 ChangeSet 을 담은 방 메시지(그룹방, `kind: "changes"`).
    var messageId: String
    var createdAt: Date
    var updatedAt: Date
}

struct RoomMessage: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var roomId: String
    /// 이 메시지를 게시한 `room.message` 이벤트의 seq. 갱신돼도 바뀌지 않는다.
    var seq: Int
    var author: RoomAuthor
    var kind: RoomMessageKind
    /// `text` 는 본문(마크다운). `approval` 은 승인 제목, `changes` 는 한 줄 요약, `system` 은 안내문.
    var text: String
    /// 본문에서 해석된 멘션의 팀원 ID. `@all` 은 펼쳐서 넣는다.
    var mentions: [String]
    /// 연쇄 깊이. 사용자 0, 그 멘션으로 실행된 턴의 결과 1, …
    var hop: Int
    /// nullable. 사용자·시스템 메시지는 `null`.
    var dispatchId: String?
    var createdAt: Date
    /// nullable. `kind: "text"` 이고 작성자가 에이전트일 때만 값.
    var work: WorkSummary?
    /// nullable. `kind: "approval"` 일 때만 값.
    var approval: RoomApproval?
    /// nullable. `kind: "changes"` 일 때만 값.
    var changes: ChangeSet?
}

/// `POST /teams/:id/changes/:changeId/merge` 응답. `merged` 면 `--no-ff` 머지 커밋, `conflict` 면 `null`.
struct MergeResult: Codable, Hashable, Sendable {
    var change: ChangeSet
    /// nullable
    var mergeCommit: String?
}

struct RunningDispatch: Codable, Hashable, Sendable {
    var dispatchId: String
    var memberId: String
    var roomId: String
    var sessionId: String
    /// nullable. 어댑터가 턴 ID 를 보고하기 전 `null`.
    var turnId: String?
    var hop: Int
}

struct QueuedDispatch: Codable, Hashable, Sendable {
    var dispatchId: String
    var memberId: String
    var roomId: String
    var hop: Int
    var enqueuedAt: Date
}

/// 팀 전체의 실행 중·대기 중 디스패치.
struct DispatchState: Codable, Hashable, Sendable {
    var running: [RunningDispatch]
    var queued: [QueuedDispatch]
}

/// `room.snapshot`·`room.status` 의 팀원 상태 한 줄.
struct RoomMemberStatus: Codable, Hashable, Sendable {
    var memberId: String
    var state: TeamMemberState
    /// nullable
    var sessionId: String?
}

// MARK: - REST

/// `GET /teams/:id/rooms/:roomId` — 최근 `limit`(기본 200)개. 더 있으면 `truncated: true`.
struct RoomDetailResponse: Codable, Hashable, Sendable {
    var room: Room
    var messages: [RoomMessage]
    var truncated: Bool
}

/// `POST /teams/:id/rooms/:roomId/messages` 본문. `attachments` 는 디스패치되는 턴에만 전달되고 RoomMessage 에는 남지 않는다.
struct PostRoomMessageRequest: Codable, Hashable, Sendable {
    var text: String
    var attachments: [Attachment]?

    init(text: String, attachments: [Attachment]? = nil) {
        self.text = text
        self.attachments = attachments
    }
}

/// → 201. `dispatches` 는 이 메시지로 만들어진 디스패치 ID(실행·대기 포함).
struct PostRoomMessageResponse: Codable, Hashable, Sendable {
    var message: RoomMessage
    var dispatches: [String]
}

/// `GET /teams/:id/changes`
struct ChangesResponse: Codable, Hashable, Sendable {
    var changes: [ChangeSet]
}
