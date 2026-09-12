# Step 5: team-manager

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md` (CRITICAL 2, 3, 4, 6, 7)
- `/docs/PROTOCOL.md` 6절 전체, `/docs/ADR.md` ADR-017, `/docs/ARCHITECTURE.md` 2.4
- `/packages/protocol/src/teams.ts`, `session.ts`
- `/packages/server/src/sessions/manager.ts` (`create` 의 `deferStart`/`instructions`/`team` — step 1, `subscribe`, `startTurn`, `interrupt`, `close`, `detail`, `respondApproval`, `patch`, `setMode`, 상태 전이, `armIdleTimer` 가 구독자가 있으면 멈춘다는 점)
- `/packages/server/src/agents/types.ts`, `/packages/server/src/agents/fake/index.ts`, `session.ts`, `script.ts` (`ScriptContext.cwd` — step 1)
- `/packages/server/src/git/worktree.ts` (step 2), `status.ts`
- `/packages/server/src/teams/types.ts`, `store.ts`, `roles.ts`, `mentions.ts`, `room-manager.ts` (step 3), `dispatcher.ts`, `format.ts`, `summary.ts` (step 4)
- `/packages/server/src/fs/sandbox.ts` (`resolveInsideHome`), `errors.ts`
- `/packages/server/test/sessions/manager.test.ts`, `manager-instructions.test.ts`, `/packages/server/test/git/worktree.test.ts`, `/packages/server/test/teams/*.test.ts`

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

`TeamManager` 를 만든다: 팀·팀원 생명주기(worktree + 지연 시작 세션), 방 메시지 → 디스패치 → 팀원 세션 턴 → 답변 게시, 승인 미러, 턴 종료 자동 커밋과 "변경 준비됨" ChangeSet 게시. 머지·충돌·dismiss·stale 은 step 6, HTTP/WS 는 step 7.

### 확정된 결정

- 팀원 세션은 `manager.create({ agent, cwd: <worktreePath>, mode(기본 auto-edit), model, effort, title: <name>, instructions: buildInstructions(...), team: { teamId, memberId }, deferStart: true })`. 팀 생성 시 어댑터 프로세스를 띄우지 않는다.
- worktree: `~/.mam/teams/<teamId>/worktrees/<memberId>` (`resolveInsideHome` 통과), 브랜치 `mam/<slug(team.name)>/<handle>` (이미 있으면 `-2`…), 베이스 = `detectBaseBranch(cwd)`.
- 자동 커밋: 턴이 끝나면 `commitAll(worktree, { message: "<name>(<roleLabel>): <답변 첫 줄 앞 72자 또는 turnId>", author: "<name> (mam-team) <handle@mam.local>" })`. 커밋이 생겼고 `changesVsBase` 의 commits > 0 이면 `ChangeSet(status: ready)` 를 만들어 **그룹방** 에 `kind: "changes"` 메시지로 게시하고 `teams/<teamId>/changes.json` 에 저장한다. 팀원당 `ready` 는 하나: 새 ChangeSet 이 생기면 이전 `ready` 는 `stale` 로 바꾸고 `room.message.updated`.
- 동시 실행 상한 `team.settings.maxConcurrent`(기본 2), 홉 `maxHops`(기본 6), 맥락 40개/12,000자.
- 답변은 턴 종료 후 한 번에. 스트리밍 없음.
- 팀원 승인은 방에 미러링만. 응답은 기존 `manager.respondApproval` 경로(step 7 의 기존 REST).

### 1. `src/teams/team-manager.ts`

```ts
export interface TeamManagerOptions { dataDir: string; home: string; manager: SessionManager; now?: () => Date; logger?; defaults?: Partial<TeamSettings> }
export class TeamManager {
  static open(opts): Promise<TeamManager>;                 // 모든 팀 로드, RoomManager 열기, changes.json 로드, 재시작 시 running 흔적은 버리고 각 그룹방에 system 메시지 "서버가 다시 시작되어 진행 중이던 작업은 취소됐습니다"
  listTeams(cwd?: string): Team[];
  getTeam(teamId): Team;                                   // 없으면 NotFoundError
  detail(teamId): { team: Team; dispatch: DispatchState; changes: ChangeSet[] };
  createTeam(input: CreateTeamRequest): Promise<Team>;     // 검증(팀장 정확히 1명, 이름 중복, cwd 홈 안·git 저장소·detached 아님), 팀 디렉토리, 방(group "전체" + 팀원별 DM), 팀원 추가(아래), 실패 시 만든 worktree·세션 롤백
  patchTeam(teamId, patch: PatchTeamRequest): Promise<Team>;   // maxConcurrent 변경은 큐에 즉시 반영
  deleteTeam(teamId, opts: { keepWorktrees?: boolean }): Promise<void>;   // 실행 중 턴 interrupt → 세션 close → worktree 제거(더러우면 keepWorktrees 없을 때 ConflictError 409, 아무것도 지우지 않은 상태로) → 파일 제거
  addMember(teamId, input: MemberInput): Promise<Team>;    // handle 생성, 브랜치·worktree, 지연 세션, DM 방 생성
  patchMember(teamId, memberId, patch: PatchMemberRequest): Promise<Team>;   // name/emoji 즉시(핸들은 유지), mode → manager.patch(sessionId,{mode}), model/effort → manager.patch, prompt → 레코드 + manager.setInstructions(sessionId, buildInstructions(...)) (다음 세션부터 적용)
  removeMember(teamId, memberId, opts: { keepWorktree?: boolean }): Promise<Team>;   // 팀장은 제거 불가(400), DM 방은 남기되 memberId 유지
  resetMember(teamId, memberId): Promise<Team>;            // 세션 close → 같은 worktree 로 새 지연 세션, lastSeen 유지
  postUserMessage(teamId, roomId, input: { text; attachments? }): Promise<{ message: RoomMessage; dispatches: string[] }>;
  stop(teamId): Promise<DispatchState>;                     // 실행 중 전부 manager.interrupt, 큐 clear, 각 방에 system 메시지
  interrupt(teamId, memberId?): Promise<void>;
  subscribeRoom(teamId, roomId, since, listener): Promise<() => void>;   // RoomManager 위임
  roomDetail(teamId, roomId, limit?): Promise<RoomDetailResponse>;
  listChanges(teamId): ChangeSet[];
  shutdown(): Promise<void>;                                // 실행 중 턴은 interrupt 하지 않고 구독만 해제, 파일 flush
}
```

SessionManager 에 부족한 것이 있으면 최소로 추가한다(예: `setInstructions(id, text)` 레코드 갱신·영속화, `get` 이 `deferStart` 세션을 돌려주는지 확인). 추가한 API 는 summary 에 적는다.

### 2. 디스패치 실행 (`runDispatch`)

큐 펌프는 `postUserMessage`·`markDone`·`patchTeam` 뒤에 돈다. 한 항목의 실행:

1. 팀원 상태 `running`, `room.status` 발행.
2. worktree 동기화: `worktreeIsDirty` 가 false 이고 `hasMergeInProgress` 가 false 면 `syncFromBase(worktree, baseBranch)`; `conflict` 면 `conflictNote` 로 턴 텍스트 앞에 안내(step 6 이 세부 흐름을 채운다. 여기서는 안내문만).
3. 맥락 수집: 그룹방 + 자기 DM 방의 `messagesSince(lastSeen[roomId])` 를 createdAt 순으로 합쳐 `buildTurnText` → `TurnInput { text, attachments: trigger.attachments }`.
4. `unsubscribe = await manager.subscribe(sessionId, session.lastSeq, listener)` → `manager.startTurn(sessionId, input)`. `SessionBusyError` 면 항목을 큐 뒤로 되돌리고 종료.
5. 리스너: `approval.requested` → 트리거 방에 `kind: "approval"` 메시지(`approval: { memberId, sessionId, approval, resolution: null }`) + 팀원 상태 `waiting_approval` + `room.status`; `approval.resolved` → 해당 메시지 `update({ approval: { …, resolution } })` + 상태 `running`; `turn.completed` → 완료 신호; `session.status` 가 `error` 또는 `error{recoverable:false}` → 실패 신호.
6. 완료 후 `unsubscribe()` (구독을 남기면 세션 idle 타이머가 멈춘다). `lastSeen` 갱신(트리거 seq 까지). 
7. `manager.detail(sessionId)` 로 `extractReply`·`summarizeWork` → 트리거 방에 `{ author: { kind: "agent", memberId }, kind: "text", text: reply, work, hop, dispatchId }` 게시. 답변이 없으면 `system` 메시지 "<name>가 답변 없이 턴을 끝냈습니다".
8. 답변의 멘션(`parseMentions(reply, members, { excludeMemberId })`) → `route` → `nextHop`; `hopExceeded` 면 `system` 메시지 "자동 연쇄 상한(N)에 도달했습니다. 계속하려면 직접 지시하세요" 후 중단; 아니면 enqueue.
9. 자동 커밋 + ChangeSet(위 결정). 커밋 메시지·ChangeSet 게시는 트리거 방이 DM 이어도 **그룹방** 에.
10. 팀원 상태 `idle`(실패면 `error` + `system` 메시지에 오류 문구), `markDone`, `room.status`, 펌프.

`stop`/`interrupt` 로 중단된 턴은 답변을 게시하지 않고 `system` 메시지 "<name>의 작업을 중단했습니다" 만 남긴다.

### 3. 한도 거부 처리(가벼운 버전)

턴이 `error` 로 끝났고 메시지가 `/rate limit|usage limit|too many requests|429/i` 에 맞으면 큐를 **일시 정지**(`paused: true`, `state()` 는 그대로)하고 그룹방에 `system` 메시지 "구독 사용 한도에 걸려 팀 작업을 멈췄습니다. 한도가 풀리면 메시지를 보내 다시 시작하세요". 다음 `postUserMessage` 가 정지를 푼다.

### 4. 영속화

- `team.json` 은 상태 변화마다 tmp+rename(`TeamStore.save`), `lastSeen`·member.state 포함. 재시작 시 `running/queued/waiting_approval` 상태는 `idle` 로 내린다.
- `changes.json` 은 ChangeSet 배열(tmp+rename).
- 큐는 메모리에만.

### 5. 테스트 `test/teams/team-manager.test.ts`

`FakeAdapter` 두 개(claude/codex kind)로 `SessionManager` 를 열고, `tmp-home.ts` 로 git 저장소를 만든 뒤 `TeamManager.open`. 커스텀 스크립트는 `ctx.input.text` 에 따라 동작(예: "write" 가 들어 있으면 `ctx.cwd/out.txt` 를 쓰고 `file_change` 아이템을 낸다; "call @지연" 이 들어 있으면 답변에 `@지연 부탁해` 를 넣는다; "approve" 면 승인 요청).

- 팀 생성: 팀장 없음 400, 두 명 409(이름 중복), cwd 가 git 아님 400, 홈 밖 403; 성공 시 worktree 디렉토리·브랜치·DM 방·`deferStart` 세션(어댑터 `startCalls` 비어 있음)이 생기고 `Team` 이 스키마를 통과.
- 멘션 없음 → 팀장 세션에 턴이 가고 답변이 그룹방에 `author.kind agent` 로 게시되며 `work.toolCalls` 가 스크립트와 일치.
- `@지연` → 지연에게만. `@all` → 둘 다(동시 실행 2 안에서).
- 연쇄: 팀장 답변에 `@지연` → 지연 턴(`hop 1`); `maxHops 0` 팀에서는 시스템 메시지로 중단.
- `maxConcurrent 1` 로 두 팀원 동시 트리거 → 두 번째는 `queued`, 첫 턴 끝나면 실행.
- 승인: 방에 `approval` 메시지가 뜨고 `manager.respondApproval` 로 응답하면 `room.message.updated` 에 resolution 이 채워짐.
- 턴 텍스트에 `[#전체] 사용자:` 접두어와 이전 메시지가 들어 있음(`startCalls`/Fake 의 `input.text` 로 확인).
- 턴 종료 후 세션의 구독자 수가 0(내부 접근자 또는 idle 타이머 동작으로 확인).
- 파일을 쓰는 스크립트 → 커밋이 생기고(`git log` 작성자 `지연 (mam-team)`), 그룹방에 `changes` 메시지, `changes.json` 에 `ready`; 다음 턴이 또 쓰면 이전 것이 `stale`.
- `stop` 이 실행 중 턴을 끊고 큐를 비움. 오류 스크립트("fail")는 팀원 `error` + system 메시지.
- `deleteTeam`: 깨끗하면 worktree 와 파일이 사라지고 세션은 closed; 더러우면 409 이고 아무것도 안 지워짐.
- 재시작(`open` 재호출): 팀·방·메시지·ChangeSet 복원, 상태 idle.

## Acceptance Criteria

```bash
npm ci
npm run typecheck
npm test
test -f packages/server/src/teams/team-manager.ts
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 세션 구독이 턴 동안만 유지되는가? 팀 생성 시 어댑터 프로세스를 띄우지 않는가?
   - 모든 경로가 `resolveInsideHome` 을 거치고 git 은 `worktree.ts` 헬퍼만 쓰는가(CRITICAL 3, 4)?
   - 메시지 본문·프롬프트를 로그에 남기지 않는가(CRITICAL 6)?
   - 방 seq 는 `RoomManager`, 세션 seq 는 `SessionManager` 만 발급하는가(CRITICAL 7)?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약, SessionManager 에 추가한 API 포함)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- 머지·dismiss·충돌 해결 흐름을 구현하지 마라. 이유: step 6 의 범위다. 이 step 은 `ready` ChangeSet 게시까지.
- HTTP 라우트·WS 를 만들지 마라(step 7). `TeamManager` 는 라우트 없이 테스트한다.
- 세션 구독을 영구히 유지하지 마라. 이유: 구독자가 있으면 세션 idle 종료가 막혀 프로세스가 쌓인다.
- 팀 생성·팀원 추가 시 어댑터를 시작하지 마라. 이유: 구독 한도와 Mac 자원을 아끼기 위해 첫 턴에 시작한다.
- `packages/protocol` 을 수정하지 마라. 필요하면 `needs_input`.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
