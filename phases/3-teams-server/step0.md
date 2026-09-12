# Step 0: teams-protocol

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md` (CRITICAL 5: 프로토콜 변경은 fixture 부터)
- `/docs/PROTOCOL.md` 전체 (0절 규약, 1절 REST, 2절 WS, 3절 TimelineItem, 2026-09-10 추가분의 "(YYYY-MM-DD 추가)" 표기 방식)
- `/docs/ADR.md` (ADR-008, 010, 015, 016 과 "미결 사항" 표)
- `/docs/ARCHITECTURE.md` (2.4 SessionManager, 3 저장소 구조)
- `/packages/protocol/src/common.ts`, `session.ts`, `approval.ts`, `timeline.ts`, `rest.ts`, `ws.ts`, `index.ts`
- `/packages/protocol/test/fixtures.test.ts`, `schemas.test.ts`, `index.test.ts`
- `/packages/protocol/fixtures/` 전체 (rest/, ws/, client/ 의 파일 이름과 내용 스타일)
- `/ios/MacAgentTests/ProtocolFixturesTests.swift`, `/ios/MacAgentTests/FixtureLoader.swift`, `/ios/MacAgent/Models/Protocol/JSONValue.swift`

이전 phase 에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 배경: 이 phase 가 만드는 것

사용자가 한 프로젝트(git 저장소)에 **에이전트 팀** 을 꾸린다. 팀원은 이름·이모지·역할(개발자/기획자/팀장/코드 리뷰어/커스텀)·에이전트 종류(Claude Code 또는 Codex)·모드를 가진 **기존 `Session`** 이며, 각자 자기 git worktree 에서 일한다. 방은 그룹방 하나(`#전체`)와 팀원별 DM 방이다. 사용자가 방에 글을 쓰면 서버가 `@이름` 멘션으로 팀원을 골라 그 팀원 세션에 턴을 보내고, 턴이 끝나면 답변을 방에 게시한다. 에이전트끼리 `@이름` 으로 서로 부를 수 있다(홉 상한). 턴 종료 시 서버가 worktree 변경을 커밋하고 "변경 준비됨" 카드를 올리며, 사용자가 방에서 머지를 승인한다.

이 step 은 **계약만** 만든다: 문서, zod 스키마, fixture, TS·Swift 양쪽 fixture 테스트. 서버 코드는 손대지 않는다.

## 확정된 결정 (설계 인터뷰 결과, 바꾸지 마라)

- 그룹방 응답은 **멘션 기반**. 멘션 없으면 팀장(`isLead`)이 응답. DM 방은 그 팀원만 응답하고 DM 안의 다른 멘션은 무시한다.
- `@all` 은 작성자 제외 전원에게 각각 디스패치.
- 에이전트 간 호출 허용, 사용자 메시지 1건당 연쇄 턴 상한 `maxHops` 기본 6.
- 동시 실행 상한 `maxConcurrent` 기본 2. 맥락 상한 `contextMaxMessages` 기본 40(12,000자).
- 에이전트당 세션 하나(그룹방·DM 공유). 답변은 턴이 끝난 뒤 한 번에 게시(스트리밍 없음).
- 서버가 턴 종료 시 worktree 를 자동 커밋(작성자 `<이름> (mam-team) <handle@mam.local>`), 브랜치 `mam/<team-slug>/<handle>`, 머지는 `--no-ff`, 브랜치 유지.
- 팀원 승인은 **기존** `POST /sessions/:id/approvals/:approvalId` 로 응답한다. 방에는 승인 카드를 미러링만 한다.
- 팀은 프로젝트(cwd)에 속하고, 템플릿은 사용자별로 저장.

## 작업

### 1. `docs/PROTOCOL.md` — `## 6. 팀과 방 (2026-09-12 추가)`

기존 5절 뒤에 6절을 추가한다. 기존 절의 표기 관례(엔드포인트 헤딩, 필드 표, nullable 목록, "(2026-09-12 추가)" 인라인)를 따른다. 내용:

- 6.1 모델: `RolePreset`, `TeamMember`, `TeamSettings`, `Team`, `Room`, `RoomAuthor`, `WorkSummary`, `RoomMessage`, `ChangeSet`, `MergeResult`, `DispatchState`, `TeamTemplate`. 아래 2절의 스키마와 필드 하나하나 일치해야 한다.
- 6.2 REST 엔드포인트 (아래 표), 요청·응답 본문, 오류 코드(팀장 0명 또는 2명 이상 → 400 `invalid_request`; 정규화한 이름 중복 → 409 `conflict`; cwd 가 홈 밖 → 403; cwd 가 git 저장소가 아니거나 detached HEAD → 400; 더러운 worktree 삭제 → 409; `ready` 가 아닌 ChangeSet 머지 → 409).
- 6.3 방 WebSocket `GET /api/v1/teams/:teamId/rooms/:roomId/ws?since=<seq>`: 세션 WS 와 같은 규칙(스냅샷 seq 0 → 재생 → 라이브, ping/pong, 방 없음은 close code 4004). 서버→클라이언트 이벤트와 클라이언트→서버 메시지 표.
- 6.4 디스패치 규칙(멘션 문법, 라우팅, 홉, 동시 실행 상한, 맥락 접두어 형식 `[#전체] 사용자: …` / `[DM] 사용자: …` / `[#전체] @민수(개발자): …` / `[#전체] 시스템: …`).
- 6.5 worktree·커밋·머지 규칙(위 결정 그대로).
- 1절 `Session` 필드 표에 `team(2026-09-12 추가): { teamId, memberId } | 생략` 을 추가한다(일반 세션은 키 자체를 생략).

REST 표:

| 메서드/경로 | 요청 → 응답 |
|---|---|
| `GET /team-roles` | → `{ roles: RolePreset[] }` |
| `GET /teams?cwd=` | → `{ teams: Team[] }` (cwd 생략 시 전체) |
| `POST /teams` | `{ cwd, name, members: MemberInput[], settings?, templateId? }` → 201 `Team` |
| `GET /teams/:id` | → `{ team, dispatch: DispatchState, changes: ChangeSet[] }` |
| `PATCH /teams/:id` | `{ name?, settings? }` → `Team` |
| `DELETE /teams/:id?keepWorktrees=true` | → `{ ok: true }` |
| `POST /teams/:id/members` | `MemberInput` → 201 `Team` |
| `PATCH /teams/:id/members/:memberId` | `{ name?, emoji?, prompt?, mode?, model?, effort? }` → `Team` (prompt/model 은 `appliesAt: "next_session"` 이라는 뜻을 문서에 적는다) |
| `DELETE /teams/:id/members/:memberId?keepWorktree=true` | → `Team` |
| `POST /teams/:id/members/:memberId/reset` | → `Team` (기억 초기화: 새 세션, 같은 worktree) |
| `POST /teams/:id/stop` | → `DispatchState` |
| `GET /teams/:id/rooms/:roomId?limit=` | → `{ room, messages: RoomMessage[], truncated }` (기본 최근 200) |
| `POST /teams/:id/rooms/:roomId/messages` | `{ text, attachments? }` → 201 `{ message: RoomMessage, dispatches: string[] }` |
| `GET /teams/:id/changes` | → `{ changes: ChangeSet[] }` |
| `POST /teams/:id/changes/:changeId/merge` | → `MergeResult` |
| `POST /teams/:id/changes/:changeId/dismiss` | → `ChangeSet` |
| `GET /team-templates` · `POST /team-templates` · `PATCH /team-templates/:id` · `DELETE /team-templates/:id` | `{ templates: TeamTemplate[] }` / `TeamTemplate` / `TeamTemplate` / `{ ok: true }` |

`MemberInput { name, role, roleLabel?, agent, emoji?, prompt?, mode? (기본 auto-edit), model?, effort?, handle?, isLead? }`.

### 2. zod 스키마 `packages/protocol/src/teams.ts` (+ `common.ts`, `session.ts`, `index.ts`)

`common.ts` 에 `TeamIdSchema = idSchema("team_")`, `MemberIdSchema("agt_")`, `RoomIdSchema("room_")`, `MessageIdSchema("msg_")`, `ChangeIdSchema("chg_")`, `TemplateIdSchema("tpl_")`, `DispatchIdSchema("dsp_")` 를 추가한다.

```ts
export const RoleIdSchema = z.enum(["developer", "planner", "team-lead", "code-reviewer", "custom"]);
export const RolePresetSchema = z.object({ id: RoleIdSchema, label: z.string(), emoji: z.string(), prompt: z.string() });
export const TeamMemberStateSchema = z.enum(["idle", "queued", "running", "waiting_approval", "error"]);
export const TeamMemberSchema = z.object({
  id: MemberIdSchema, name: z.string().min(1).max(40), handle: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  role: RoleIdSchema, roleLabel: z.string(), emoji: z.string(), agent: AgentKindSchema, prompt: z.string(),
  mode: SessionModeSchema, model: z.string().nullable(), effort: z.string().nullable(),
  sessionId: SessionIdSchema.nullable(), branch: z.string(), worktreePath: z.string(), isLead: z.boolean(),
  state: TeamMemberStateSchema, createdAt: IsoDateSchema, updatedAt: IsoDateSchema,
});
export const TeamSettingsSchema = z.object({ maxHops: z.number().int().min(0).max(50), maxConcurrent: z.number().int().min(1).max(8), contextMaxMessages: z.number().int().min(1).max(500) });
export const RoomKindSchema = z.enum(["group", "dm"]);
export const RoomSchema = z.object({ id: RoomIdSchema, teamId: TeamIdSchema, kind: RoomKindSchema, memberId: MemberIdSchema.nullable(), name: z.string(), lastSeq: SeqSchema, lastMessageAt: IsoDateSchema.nullable() });
export const TeamSchema = z.object({ id: TeamIdSchema, name: z.string().min(1).max(60), cwd: z.string(), baseBranch: z.string(), settings: TeamSettingsSchema, members: z.array(TeamMemberSchema), rooms: z.array(RoomSchema), createdAt: IsoDateSchema, updatedAt: IsoDateSchema });
export const RoomAuthorSchema = z.discriminatedUnion("kind", [ z.object({ kind: z.literal("user") }), z.object({ kind: z.literal("agent"), memberId: MemberIdSchema }), z.object({ kind: z.literal("system") }) ]);
export const WorkSummarySchema = z.object({ sessionId: SessionIdSchema, turnId: TurnIdSchema, toolCalls: z.number().int().min(0), filesChanged: z.array(z.string()), durationMs: z.number().int().min(0), usage: UsageSchema, costUsd: z.number().optional() });
export const ChangeSetStatusSchema = z.enum(["ready", "merging", "merged", "conflict", "dismissed", "stale"]);
export const ChangeSetSchema = z.object({ id: ChangeIdSchema, teamId, memberId, sessionId, turnId, branch: z.string(), baseBranch: z.string(), commit: z.string(), files: z.array(FileChangeEntrySchema), commits: z.number().int().min(1), status: ChangeSetStatusSchema, conflictFiles: z.array(z.string()), messageId: MessageIdSchema, createdAt, updatedAt });
export const RoomMessageKindSchema = z.enum(["text", "approval", "changes", "system"]);
export const RoomMessageSchema = z.object({
  id: MessageIdSchema, roomId: RoomIdSchema, seq: SeqSchema, author: RoomAuthorSchema, kind: RoomMessageKindSchema,
  text: z.string(), mentions: z.array(MemberIdSchema), hop: z.number().int().min(0), dispatchId: DispatchIdSchema.nullable(), createdAt: IsoDateSchema,
  work: WorkSummarySchema.nullable(),
  approval: z.object({ memberId: MemberIdSchema, sessionId: SessionIdSchema, approval: ApprovalSchema, resolution: ApprovalResolutionSchema.nullable() }).nullable(),
  changes: ChangeSetSchema.nullable(),
});
export const MergeResultSchema = z.object({ change: ChangeSetSchema, mergeCommit: z.string().nullable() });
export const DispatchStateSchema = z.object({
  running: z.array(z.object({ dispatchId: DispatchIdSchema, memberId: MemberIdSchema, roomId: RoomIdSchema, sessionId: SessionIdSchema, turnId: TurnIdSchema.nullable(), hop: z.number().int() })),
  queued: z.array(z.object({ dispatchId: DispatchIdSchema, memberId: MemberIdSchema, roomId: RoomIdSchema, hop: z.number().int(), enqueuedAt: IsoDateSchema })),
});
export const TeamTemplateMemberSchema = TeamMemberSchema.pick({ name, handle, role, roleLabel, emoji, agent, prompt, mode, model, effort, isLead });
export const TeamTemplateSchema = z.object({ id: TemplateIdSchema, name: z.string().min(1).max(60), settings: TeamSettingsSchema, members: z.array(TeamTemplateMemberSchema), createdAt, updatedAt });
```

요청 스키마: `MemberInputSchema`, `CreateTeamRequestSchema`, `PatchTeamRequestSchema`, `PatchMemberRequestSchema`, `PostRoomMessageRequestSchema { text: min 1, attachments?: Attachment[] }`, `CreateTeamTemplateRequestSchema { name, settings?, members: TeamTemplateMember[] }`, `PatchTeamTemplateRequestSchema`. 응답 스키마: `TeamRolesResponseSchema`, `TeamsResponseSchema`, `TeamDetailResponseSchema`, `RoomDetailResponseSchema`, `PostRoomMessageResponseSchema`, `ChangesResponseSchema`, `TeamTemplatesResponseSchema`. 기존 이름·타입(`IsoDateSchema`, `SeqSchema`, `UsageSchema`, `FileChangeEntrySchema`, `ApprovalSchema`, `ApprovalResolutionSchema`, `AttachmentSchema`)은 실제 파일에서 확인해 정확히 재사용하라. 여기 스니펫에서 생략한 필드 타입은 같은 규칙으로 채운다.

방 WS 스키마 (`teams.ts` 또는 `room-ws.ts`, `index.ts` 에서 재export). **`ServerEventSchema`/`ClientMessageSchema` 와 합치지 마라** (iOS 가 `ws/` 폴더 전체를 엄격한 `ServerEvent` enum 으로 디코드한다):

```ts
const roomBase = { seq: SeqSchema, roomId: RoomIdSchema, teamId: TeamIdSchema, ts: IsoDateSchema };
export const RoomServerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("room.snapshot"), ...roomBase, room: RoomSchema, messages: z.array(RoomMessageSchema), pendingApprovals: z.array(RoomMessageSchema.shape.approval.unwrap()), dispatch: DispatchStateSchema, members: z.array(z.object({ memberId, state: TeamMemberStateSchema, sessionId: SessionIdSchema.nullable() })), replayFrom: SeqSchema, truncated: z.boolean() }),
  z.object({ type: z.literal("room.message"), ...roomBase, message: RoomMessageSchema }),
  z.object({ type: z.literal("room.message.updated"), ...roomBase, message: RoomMessageSchema }),
  z.object({ type: z.literal("room.status"), ...roomBase, dispatch: DispatchStateSchema, members: z.array(z.object({ memberId, state, sessionId })) }),
  z.object({ type: z.literal("room.error"), ...roomBase, message: z.string(), recoverable: z.boolean() }),
  z.object({ type: z.literal("pong"), ...roomBase }),
]);
export const RoomClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("room.send"), text: z.string().min(1), attachments: z.array(AttachmentSchema).optional() }),
  z.object({ type: z.literal("room.interrupt"), memberId: MemberIdSchema.optional() }),
  z.object({ type: z.literal("ping") }),
]);
```

`session.ts` 의 `SessionSchema` 에 `team: z.object({ teamId: TeamIdSchema, memberId: MemberIdSchema }).optional()` 을 추가한다(순환 import 를 피하려면 팀 ID 스키마는 `common.ts` 에 둔다). `index.ts` 에서 타입(`Team`, `TeamMember`, `RoomMessage`, `RoomServerEvent`, `RoomClientMessage` 등)과 `parseRoomServerEvent`/`parseRoomClientMessage`/`safeParseRoomClientMessage` 를 기존 `parseServerEvent` 와 같은 방식으로 내보낸다.

### 3. Fixture 23개

값은 서로 일관되어야 한다(같은 teamId `team_…`, 팀원 2명: 팀장 `민수`(`handle: minsu`, 🧑‍💼, team-lead, claude)와 개발자 `지연`(`handle: jiyeon`, 🧑‍💻, developer, codex), 그룹방 `전체`, DM 방 2개, 브랜치 `mam/backend/minsu` 등). ULID 는 기존 fixture 의 스타일로 만든다.

- `rest/team-roles.json`(프리셋 5개, prompt 는 짧은 영어 문장이면 충분), `rest/teams.json`, `rest/team.json`, `rest/team-detail.json`(dispatch 에 running 1·queued 1, changes 1), `rest/room.json`(messages 에 text/approval/changes/system 네 종류 모두, `truncated: false`), `rest/room-message-post.json`, `rest/changes.json`, `rest/merge-result.json`(`merged` + mergeCommit), `rest/team-templates.json`, `rest/team-template.json`
- `room-ws/room.snapshot.json`(seq 0), `room-ws/room.message.user.json`(멘션 1개), `room-ws/room.message.agent.json`(`work` 포함, `hop: 1`), `room-ws/room.message.approval.json`, `room-ws/room.message.changes.json`, `room-ws/room.message.system.json`, `room-ws/room.message.updated.json`(승인 resolution 채워진 것), `room-ws/room.status.json`, `room-ws/room.error.json`, `room-ws/pong.json`
- `room-client/room.send.json`, `room-client/room.interrupt.json`, `room-client/ping.json`

### 4. 테스트

- `packages/protocol/test/fixtures.test.ts`: `REST` 테이블에 10개 추가, 새 테이블 `ROOM_WS`(type 별)와 `ROOM_CLIENT` 를 만들고 기존 `ws/`·`client/` 와 같은 세 검사("폴더 == 테이블", "union 의 모든 type 에 fixture", 무손실 왕복)를 `room-ws/`·`room-client/` 에도 적용. `ADDED_2026_09_12` 배열(23개)을 두고 전부 매핑표에 있는지 검사.
- `schemas.test.ts` 음수 케이스: `hop: -1`, `handle: "민수"`, 잘못된 접두어 `team_` 자리에 `ses_`, `room.send` 빈 `text`, `maxConcurrent: 0`, `RoomAuthor` 모르는 kind, `RoomServerEvent` 모르는 type.
- `index.test.ts`: 새 파서 export 확인.
- `ios/MacAgentTests/ProtocolFixturesTests.swift`: `table()` 에 23개 경로를 **`decode(JSONValue.self)`** 로 추가하고(임시; iOS phase 가 실제 타입으로 바꾼다), `XCTAssertEqual(files.count, 46)` 을 69 로, `ADDED_2026_09_10` 옆에 `ADDED_2026_09_12` 집합 검사를 추가. `ws/` 전용 검사(`wsExpectations`)는 건드리지 않는다. Swift 파일을 새로 만들지 않으므로 `xcodegen generate` 는 필요 없지만 AC 의 `bash scripts/test.sh` 가 어차피 실행한다.

### 5. `docs/ADR.md` — ADR-017

`## ADR-017 에이전트 팀: 팀원은 세션, 방은 별도 스트림, worktree 격리, 서버 커밋, 멘션 라우팅` 을 ADR-016 뒤에 추가한다. 결정과 이유(위 "확정된 결정" 전부, 방 seq 를 세션 seq 와 분리하는 이유, worktree 를 `~/.mam/teams/<teamId>/worktrees/<memberId>` 에 두는 이유 = 저장소 밖이라 git status·glob·Codex writableRoots 가 이웃 worktree 를 보지 않고 홈 안이라 샌드박스를 지킴, 서버가 커밋하는 이유 = Codex 샌드박스가 .git 쓰기를 막음)를 기존 ADR 문체로 적는다. "미결 사항" 표에 "Claude systemPrompt snapshot 때문에 프롬프트 수정은 다음 세션부터" 를 추가.

## Acceptance Criteria

```bash
npm ci
npm run typecheck
npm test
test -f packages/protocol/fixtures/room-ws/room.snapshot.json
test -f packages/protocol/fixtures/room-client/room.send.json
grep -q "## 6. 팀과 방" docs/PROTOCOL.md
grep -q "ADR-017" docs/ADR.md
grep -q "ADDED_2026_09_12" packages/protocol/test/fixtures.test.ts
grep -q "room-ws/room.snapshot.json" ios/MacAgentTests/ProtocolFixturesTests.swift
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - fixture → zod → 문서가 필드 단위로 일치하는가? `expectLossless` 가 모든 새 fixture 를 통과하는가?
   - 기존 fixture 와 스키마는 추가만 있고 바뀐 것이 없는가(기존 클라이언트 호환)?
   - `ws/`·`client/` 폴더에 파일을 추가하지 않았는가?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약: 추가한 스키마·fixture 이름 목록 포함)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- `packages/server` 를 수정하지 마라. 이유: 이 step 은 계약만 만든다. 서버는 step 1 부터.
- `fixtures/ws/`, `fixtures/client/` 에 파일을 추가하거나 `ServerEventSchema`/`ClientMessageSchema` 에 방 이벤트를 넣지 마라. 이유: iOS 가 그 폴더 전체를 엄격한 enum 으로 디코드해 빌드 게이트가 깨진다.
- Swift 파일을 새로 만들지 마라. 이유: iOS 타입은 phase `4-teams-ios` 가 만든다. 테이블에 `JSONValue` 로만 등록한다.
- `MAM_TEST_SKIP_IOS=1` 로 게이트를 우회하지 마라. 이유: iOS 테이블·개수를 이 step 에서 맞추는 것이 이 step 의 책임이다.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
