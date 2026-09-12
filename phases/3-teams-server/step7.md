# Step 7: teams-routes-ws

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md` (CRITICAL 1, 2, 3)
- `/docs/PROTOCOL.md` 0절(오류 봉투, 헤더), 6.2 REST, 6.3 방 WS
- `/docs/ARCHITECTURE.md` 2.2 agent-host, 6 보안 모델
- `/packages/protocol/src/teams.ts`, `index.ts` (`parseRoomClientMessage` 등)
- `/packages/server/src/agent-host/http.ts` (`AgentHostContext`, `validate`, `send`), `app.ts`, `server.ts`, `ws.ts` (세션 WS: ping/pong, 큐·스냅샷, close code 4004), `routes/sessions.ts`, `routes/fs.ts`, `routes/usage.ts`
- `/packages/server/src/teams/team-manager.ts`, `store.ts`, `roles.ts` (step 3~6)
- `/packages/server/src/errors.ts` (MamError → HTTP 상태 매핑)
- `/packages/server/test/agent-host/rest.test.ts`, `ws.test.ts` (테스트 스타일: `buildApp` + inject / ws 클라이언트)

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

`TeamManager` 를 agent-host 에 연결하고 REST 라우트와 방 WebSocket 을 만든다. 신원·권한 로직은 넣지 않는다(gateway 가 이미 확정한 사용자의 agent-host 안에서만 돈다).

### 1. 컨텍스트·조립

- `AgentHostContext` 에 `teams: TeamManager` 추가. `server.ts` 는 `SessionManager.open` 다음에 `TeamManager.open({ dataDir, home, manager })` 를 열고, 종료 시 **teams → manager** 순서로 `shutdown`.
- `app.ts` 에 `registerTeamRolesRoutes`, `registerTeamsRoutes`, `registerTeamTemplatesRoutes`, `registerRoomWsRoutes` 등록(기존 라우트 뒤).
- 테스트용 `buildApp` 옵션에 `teams` 를 주입할 수 있게 한다(기존 `manager` 주입 방식과 동일).

### 2. `routes/team-roles.ts`, `routes/teams.ts`, `routes/team-templates.ts`

PROTOCOL.md 6.2 의 표 그대로. 공통 규칙:

- 본문·쿼리는 `validate({ body: …Schema, query: … })` 로, 응답은 `send(host, reply, …ResponseSchema, payload, status)` 로 검증한다.
- `POST /teams` 의 `cwd` 는 `resolveInsideHome(home, cwd)` 를 거친 realpath 로 `TeamManager` 에 넘긴다(홈 밖 403). git 저장소가 아니거나 detached 면 `TeamManager` 가 던지는 `InvalidRequestError`(400)를 그대로.
- `templateId` 가 있으면 `members` 가 비어 있을 때 템플릿 팀원으로 채운다. `members` 가 있으면 그것을 쓴다(템플릿은 무시). 템플릿 없음 → 404.
- `DELETE /teams/:id` / `DELETE …/members/:memberId` 의 `keepWorktrees`/`keepWorktree` 쿼리(`"true"` 만 참). 더러운 worktree → 409 `conflict`(TeamManager 의 예외 그대로).
- `POST /teams/:id/rooms/:roomId/messages` → 201 `{ message, dispatches }`.
- `POST /teams/:id/changes/:changeId/merge` → `MergeResult`; 409 는 `{ error: { code: "conflict", message } }` 봉투.
- 템플릿 CRUD 는 `TeamStore` 의 템플릿 함수 위에 얇게(`src/teams/templates.ts` 에 검증·id 발급).
- 팀원 승인 응답은 **기존** `POST /sessions/:id/approvals/:approvalId` 를 그대로 쓴다. 새 엔드포인트를 만들지 않는다.

### 3. `agent-host/ws-rooms.ts` — `GET /teams/:teamId/rooms/:roomId/ws?since=`

`ws.ts` 와 같은 구조(ping 인터벌·pong 처리·onClose 정리)로:

- 팀 또는 방이 없으면 close **4004**. `since` 가 잘못되면 1008.
- `teams.subscribeRoom(teamId, roomId, since, listener)` → 스냅샷 `room.snapshot`(seq 0, `room`, `messages`(since 보다 큰 것만이 아니라 세션 WS 와 같은 규칙: 상세 200개 + `replayFrom`/`truncated`), `pendingApprovals`(approval 메시지 중 resolution null 인 것의 `approval` 객체들), `dispatch`, `members`) → 큐 flush → 라이브.
- 클라이언트 메시지: `room.send` → `teams.postUserMessage`(실패는 `room.error{recoverable:true}`), `room.interrupt` → `teams.interrupt(teamId, memberId?)`, `ping` → `pong`. 파싱 실패는 `room.error`.
- 이벤트는 `RoomServerEventSchema` 를 통과한 JSON 그대로 보낸다.

### 4. 테스트

- `test/agent-host/rest-teams.test.ts`(Fake 어댑터 + tmp git 저장소 + `buildApp` inject):
  - `GET /team-roles` 5개, 스키마 통과.
  - `POST /teams` 201 + 응답 `TeamSchema`; 팀장 없음 400; 이름 중복 409; 홈 밖 cwd 403; git 아님 400; `templateId` 로 생성.
  - `GET /teams?cwd=`, `GET /teams/:id`(dispatch/changes 포함), `PATCH /teams/:id`, 팀원 추가·수정·삭제·reset, `POST /teams/:id/stop`.
  - `POST …/rooms/:roomId/messages` 201 → 잠시 후 `GET …/rooms/:roomId` 에 에이전트 답변이 있음.
  - `GET /teams/:id/changes`, 머지 409(`ready` 아님)·성공, dismiss.
  - 템플릿 CRUD 와 404.
  - 오류 봉투가 `ErrorResponseSchema` 를 통과.
  - `GET /sessions` 에 팀원 세션이 `team` 필드와 함께 나오고 `instructions` 는 없음.
- `test/agent-host/ws-rooms.test.ts`: 스냅샷 수신(seq 0, replayFrom, pendingApprovals), `since` 재생, `room.send` → `room.message`(user) → 잠시 후 `room.message`(agent, work 포함) → `room.status`, 잘못된 JSON → `room.error`, `ping`→`pong`, 없는 방 → 4004, 승인: Fake 가 승인을 요청하면 `room.message`(approval) 가 오고 기존 `POST /sessions/:id/approvals/:approvalId` 로 응답하면 `room.message.updated` 가 온다.

## Acceptance Criteria

```bash
npm ci
npm run typecheck
npm test
test -f packages/server/src/agent-host/routes/teams.ts
test -f packages/server/src/agent-host/ws-rooms.ts
bash scripts/dev-smoke.sh
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 라우트가 신원을 헤더에서 읽거나 검사하지 않는가(CRITICAL 1; agent-host 는 이미 사용자 고정)?
   - 모든 응답이 프로토콜 스키마 검증(`send`)을 통과하는가? 오류가 단일 봉투인가?
   - `cwd` 가 `resolveInsideHome` 을 거치는가(CRITICAL 3)?
   - 방 WS 가 세션 WS 와 같은 ping/close 규칙을 지키는가?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- gateway(`src/gateway/`)를 수정하지 마라. 이유: `/api/*` 프록시가 새 경로를 이미 통과시킨다(CRITICAL 2).
- 승인 응답용 방 전용 엔드포인트나 WS 메시지를 만들지 마라. 이유: 기존 세션 승인 경로 하나만 쓴다(응답 경로가 둘이면 상태가 어긋난다).
- 방 이벤트를 세션 WS 로 보내거나 그 반대로 하지 마라.
- `packages/protocol` 을 수정하지 마라. 필요하면 `needs_input`.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
