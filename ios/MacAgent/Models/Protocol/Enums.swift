import Foundation

// PROTOCOL.md 의 문자열 열거형. 판별자(`TimelineItemKind`, `ServerEvent.type`, `ClientMessage.type`)가
// 아닌 것은 전부 lenient(`unknown` 포함)다. 판별자는 TimelineItem.swift / ServerEvent.swift 에 있다.

enum AgentKind: String, LenientRawEnum {
    case claude, codex
    case unknown
}

enum SessionMode: String, LenientRawEnum {
    case ask
    case autoEdit = "auto-edit"
    case fullAuto = "full-auto"
    case plan
    case unknown
}

enum SessionStatus: String, LenientRawEnum {
    case starting, idle, running
    case waitingApproval = "waiting_approval"
    case error, closed
    case unknown
}

enum ItemStatus: String, LenientRawEnum {
    case running, completed, failed, cancelled
    case unknown
}

enum ToolName: String, LenientRawEnum {
    case bash, read, write, edit, glob, grep, web, mcp, task, other
    case unknown
}

enum ApprovalKind: String, LenientRawEnum {
    case command
    case fileChange = "file_change"
    case permission
    case userInput = "user_input"
    case other
    case unknown
}

enum ApprovalOptionStyle: String, LenientRawEnum {
    case primary, secondary, destructive
    case unknown
}

enum ApprovalResolvedBy: String, LenientRawEnum {
    case client, timeout, system
    case unknown
}

enum FileChangeKind: String, LenientRawEnum {
    case add, modify, delete, rename
    case unknown
}

enum PlanStepStatus: String, LenientRawEnum {
    case pending
    case inProgress = "in_progress"
    case completed
    case unknown
}

enum InputFieldType: String, LenientRawEnum {
    case text, secret, choice
    case unknown
}

enum AssistantMessagePhase: String, LenientRawEnum {
    case commentary, final
    case unknown
}

enum FsEntryType: String, LenientRawEnum {
    case file, dir, symlink, other
    case unknown
}

/// `git status --porcelain` 이 준 한 글자 코드.
enum GitStatusCode: String, LenientRawEnum {
    case modified = "M"
    case added = "A"
    case deleted = "D"
    case renamed = "R"
    case untracked = "?"
    case ignored = "!"
    case unknown
}

enum LoginFlowStatus: String, LenientRawEnum {
    case pending, done, error
    case unknown
}

enum ErrorCode: String, LenientRawEnum {
    case notFound = "not_found"
    case forbidden
    case invalidRequest = "invalid_request"
    case conflict
    case agentUnavailable = "agent_unavailable"
    case internalError = "internal"
    case unknown
}

/// `item.delta` 가 append 할 대상 필드.
enum ItemDeltaField: String, LenientRawEnum {
    case text, output, patch
    case unknown
}
