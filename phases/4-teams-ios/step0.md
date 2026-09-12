# Step 0: ios-team-models-fixtures

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md` (CRITICAL 5, 8)
- `/docs/PROTOCOL.md` 0절(모르는 키 무시·모르는 판별자 실패), **6절 팀과 방 전체**(6.1 모델, 6.2 REST, 6.3 방 WS)
- `/docs/IOS.md` 3절 디렉토리, 6절 상태 흐름, 8절 테스트 전략
- `/packages/protocol/src/teams.ts`, `room-ws.ts`, `session.ts`(`SessionTeamRefSchema`), `common.ts`
- `/packages/protocol/fixtures/rest/team*.json`, `room.json`, `room-message-post.json`, `changes.json`, `merge-result.json`, `/packages/protocol/fixtures/room-ws/*.json`, `/packages/protocol/fixtures/room-client/*.json`
- `/ios/MacAgent/Models/Protocol/*.swift` (특히 `LenientEnum.swift`, `Enums.swift`, `ServerEvent.swift` 의 엄격 `type` 판별 방식, `ClientMessage.swift` 의 인코딩 방식, `Session.swift`, `REST.swift`, `Approval.swift`, `TimelineItem.swift` 의 `FileChangeEntry`, `JSONCoding.swift`)
- `/ios/MacAgent/Networking/APIClient.swift`
- `/ios/MacAgentTests/ProtocolFixturesTests.swift` (현재 `ADDED_2026_09_12` 23개가 `JSONValue` 로 등록돼 있고 파일 수는 69), `FixtureLoader.swift`, `LenientEnumTests.swift`, `Networking/APIClientTests.swift`, `Networking/StubURLProtocol.swift`

이전 phase 에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 배경: 이 phase 가 만드는 것

서버 phase(`3-teams-server`)가 에이전트 팀 API 를 완성했다. 이 iOS phase 는 세션 홈에 "팀" 섹션을 더해 팀을 만들고(프리셋 역할·이름·이모지·Claude/Codex 선택), 그룹방 `#전체` 와 팀원별 DM 방에서 슬랙처럼 대화하며, 에이전트 답변에 붙은 접힌 작업 요약 카드로 팀원 타임라인을 열고, 방 안에서 승인과 머지를 처리하게 한다. 이 step 은 그 **모델과 REST 클라이언트** 만 만든다(UI 없음).

## 작업

### 1. `Models/Protocol/Team.swift`

PROTOCOL 6.1 을 그대로 옮긴다. 판별자가 아닌 문자열 열거형은 `LenientRawEnum`(`.unknown` 포함), 나머지는 기존 `Session`/`REST` 파일의 관례(명시적 `init(from:)` 로 nullable 은 `decodeIfPresent`, 멤버와이즈 init 유지).

- `RoleId: LenientRawEnum` (`developer, planner, teamLead = "team-lead", codeReviewer = "code-reviewer", custom, unknown`), `RolePreset { id, label, emoji, prompt }`
- `TeamMemberState: LenientRawEnum` (`idle, queued, running, waitingApproval = "waiting_approval", error, unknown`)
- `TeamMember: Identifiable` (`id, name, handle, role, roleLabel, emoji, agent: AgentKind, prompt, mode: SessionMode, model?, effort?, sessionId?, branch, worktreePath, isLead, state, createdAt, updatedAt`)
- `TeamSettings { maxHops, maxConcurrent, contextMaxMessages }`
- `Team: Identifiable` (`id, name, cwd, baseBranch, settings, members, rooms: [Room], createdAt, updatedAt`)
- `TeamTemplateMember`, `TeamTemplate: Identifiable`
- 요청: `MemberInput { name, role, roleLabel?, agent, emoji?, prompt?, mode?, model?, effort?, handle?, isLead? }`, `CreateTeamRequest { cwd, name, members, settings?, templateId? }`, `PatchTeamRequest { name?, settings? }`, `PatchMemberRequest { name?, emoji?, prompt?, mode?, model?, effort? }`, `CreateTeamTemplateRequest`, `PatchTeamTemplateRequest` — nil 은 키 생략(합성 `encodeIfPresent`, `PatchSessionRequest` 와 같은 방식)
- 응답: `TeamRolesResponse { roles }`, `TeamsResponse { teams }`, `TeamDetailResponse { team, dispatch, changes }`, `TeamTemplatesResponse { templates }`

### 2. `Models/Protocol/Room.swift`

- `RoomKind: LenientRawEnum` (`group, dm, unknown`), `Room: Identifiable` (`id, teamId, kind, memberId?, name, lastSeq, lastMessageAt?`)
- `RoomAuthor` — **엄격** 판별자 `kind`: `.user`, `.agent(memberId:)`, `.system`. 모르는 kind 는 디코드 실패(`ServerEvent` 와 같은 규칙). `Hashable`.
- `WorkSummary { sessionId, turnId, toolCalls, filesChanged: [String], durationMs, usage: Usage, costUsd? }`
- `RoomMessageKind: LenientRawEnum` (`text, approval, changes, system, unknown`)
- `RoomApproval { memberId, sessionId, approval: Approval, resolution: ApprovalResolution? }`
- `ChangeSetStatus: LenientRawEnum` (`ready, merging, merged, conflict, dismissed, stale, unknown`)
- `ChangeSet: Identifiable` (`id, teamId, memberId, sessionId, turnId, branch, baseBranch, commit, files: [FileChangeEntry], commits, status, conflictFiles, messageId, createdAt, updatedAt`)
- `RoomMessage: Identifiable` (`id, roomId, seq, author, kind, text, mentions: [String], hop, dispatchId?, createdAt, work?, approval: RoomApproval?, changes?`)
- `MergeResult { change, mergeCommit? }`, `DispatchState { running: [RunningDispatch], queued: [QueuedDispatch] }`(`RunningDispatch { dispatchId, memberId, roomId, sessionId, turnId?, hop }`, `QueuedDispatch { dispatchId, memberId, roomId, hop, enqueuedAt }`), `RoomMemberStatus { memberId, state: TeamMemberState, sessionId? }`
- `RoomDetailResponse { room, messages, truncated }`, `PostRoomMessageRequest { text, attachments? }`, `PostRoomMessageResponse { message, dispatches: [String] }`, `ChangesResponse { changes }`

### 3. `Models/Protocol/RoomEvent.swift`, `RoomClientMessage.swift`

`ServerEvent.swift` 와 같은 구조로:

```swift
enum RoomEvent: Decodable, Hashable, Sendable {
    case roomSnapshot(RoomSnapshotEvent)      // room, messages, pendingApprovals: [RoomApproval], dispatch, members: [RoomMemberStatus], replayFrom, truncated
    case roomMessage(RoomMessageEvent)        // message
    case roomMessageUpdated(RoomMessageEvent)
    case roomStatus(RoomStatusEvent)          // dispatch, members
    case roomError(RoomErrorEvent)            // message, recoverable
    case pong(RoomPongEvent)
    enum EventType: String, CaseIterable { case roomSnapshot = "room.snapshot", roomMessage = "room.message", roomMessageUpdated = "room.message.updated", roomStatus = "room.status", roomError = "room.error", pong }
    var type: EventType; var seq: Int; var roomId: String; var teamId: String; var ts: Date
}
enum RoomClientMessage: Encodable, Hashable, Sendable {
    case send(text: String, attachments: [Attachment]?)
    case interrupt(memberId: String?)
    case ping
    enum MessageType: String, CaseIterable { case send = "room.send", interrupt = "room.interrupt", ping }
}
```

인코딩은 `room-client/*.json` 과 **왕복이 같아야** 한다(`ClientMessage` 의 왕복 테스트와 같은 규칙: nil 필드 키 생략).

### 4. `Session.team`

`Session.swift` 에 `team: SessionTeamRef?`(`{ teamId, memberId }`)를 `decodeIfPresent` 로 추가한다. 멤버와이즈 init 의 마지막 기본값 파라미터로 붙여 기존 테스트 헬퍼가 그대로 컴파일되게 한다.

### 5. `APIClient`

PROTOCOL 6.2 표의 엔드포인트 전부(경로 프리픽스 `/api/v1`):

```swift
func teamRoles() async throws -> [RolePreset]
func teams(cwd: String? = nil) async throws -> [Team]
func createTeam(_ req: CreateTeamRequest) async throws -> Team          // 201
func team(id: String) async throws -> TeamDetailResponse
func patchTeam(id: String, _ req: PatchTeamRequest) async throws -> Team
func deleteTeam(id: String, keepWorktrees: Bool = false) async throws  // ?keepWorktrees=true 일 때만 쿼리
func addMember(teamId: String, _ req: MemberInput) async throws -> Team
func patchMember(teamId: String, memberId: String, _ req: PatchMemberRequest) async throws -> Team
func removeMember(teamId: String, memberId: String, keepWorktree: Bool = false) async throws -> Team
func resetMember(teamId: String, memberId: String) async throws -> Team
func stopTeam(id: String) async throws -> DispatchState
func room(teamId: String, roomId: String, limit: Int? = nil) async throws -> RoomDetailResponse
func postRoomMessage(teamId: String, roomId: String, _ req: PostRoomMessageRequest) async throws -> PostRoomMessageResponse
func changes(teamId: String) async throws -> [ChangeSet]
func mergeChange(teamId: String, changeId: String) async throws -> MergeResult
func dismissChange(teamId: String, changeId: String) async throws -> ChangeSet
func teamTemplates() async throws -> [TeamTemplate]
func createTeamTemplate(_:) / patchTeamTemplate(id:_:) / deleteTeamTemplate(id:)
```

### 6. 테스트 (먼저 쓴다)

- `ProtocolFixturesTests.swift`: `ADDED_2026_09_12` 의 `JSONValue` 임시 등록을 **실제 타입** 으로 바꾼다 — rest 10개는 각 응답 타입, `room-ws/` 10개는 `roomWsExpectations: [String: RoomEvent.EventType]` 테이블로 `RoomEvent`, `room-client/` 3개는 `roomClientExpectations: [String: RoomClientMessage.MessageType]` 로 왕복 검사. `RoomEvent.EventType.allCases`·`RoomClientMessage.MessageType.allCases` 가 테이블에 전부 있는지 검사. 파일 수 69 는 그대로(이 phase 는 fixture 를 추가하지 않는다).
- `TeamModelsTests.swift`(`MacAgentTests/Models/`): `RoomAuthor` 모르는 kind → 실패, `RoomEvent` 모르는 type → 실패; `ChangeSetStatus`·`RoleId`·`TeamMemberState`·`RoomMessageKind` 모르는 값 → `.unknown`; `RoomMessage` 의 `work/approval/changes` null·값 케이스(`room.snapshot.json` 의 4개 메시지); `Session` 에 `team` 이 없어도 디코드; `team.json` 의 rooms 가 group 1 + dm 2.
- `APIClientTests.swift` 확장: 위 메서드의 메서드·경로·쿼리(`keepWorktrees=true` 는 true 일 때만)·본문 키 생략(`PatchMemberRequest` nil), 201/200 처리, 오류 봉투.

## Acceptance Criteria

```bash
cd ios && xcodegen generate --quiet && xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet test && cd ..
test -f ios/MacAgent/Models/Protocol/Team.swift
test -f ios/MacAgent/Models/Protocol/Room.swift
test -f ios/MacAgent/Models/Protocol/RoomEvent.swift
test -f ios/MacAgent/Models/Protocol/RoomClientMessage.swift
! grep -n "JSONValue.self" ios/MacAgentTests/ProtocolFixturesTests.swift
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 판별자(`RoomAuthor.kind`, `RoomEvent.type`, `RoomClientMessage.type`)는 엄격, 나머지 열거형은 lenient 인가(PROTOCOL 0절)?
   - fixture 69개가 전부 실제 타입으로 디코드되고 `room-client` 왕복이 같은가?
   - Swift 파일을 추가했으므로 `xcodegen generate` 를 실행했는가(CRITICAL 8)? `*.xcodeproj` 를 커밋 대상에 넣지 않았는가?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- `packages/protocol/fixtures` 를 수정하거나 iOS 쪽에 fixture JSON 을 손으로 만들지 마라. 이유: CRITICAL 5 — 계약은 서버 phase 가 확정했다. 불일치를 발견하면 `needs_input`.
- `RoomAuthor.kind` 를 lenient 로 만들지 마라. 이유: 판별자는 모르는 값에 실패해야 한다.
- 뷰·모델(`RoomModel`, `TeamsStore`)을 만들지 마라. 이유: step 2·4 의 범위.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
