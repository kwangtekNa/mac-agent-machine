# Step 0: orphan-approval-reconcile

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md` (CRITICAL 6, 7)
- `/docs/PROTOCOL.md` 6.1 `RoomMessage`·`RoomApproval`, 6.3 방 WS(`room.snapshot.pendingApprovals`, `room.message.updated`), 6.4 "승인 미러링"
- `/docs/ADR.md` ADR-015(모드 프리셋), ADR-017(팀 구조)
- `/packages/protocol/src/approval.ts` — `ApprovalResolutionSchema`, `ApprovalResolvedBySchema = ["client","timeout","system"]`
- `/packages/protocol/src/teams.ts` — `RoomApprovalSchema`, `RoomMessageSchema`
- `/packages/server/src/teams/team-manager.ts` — `static async open`(BUSY_STATES 리셋 + `RESTART_NOTICE` + `reconcileChanges`), `roomPendingApprovals`, `resetMember`, `removeMember`, 승인 미러링 리스너(`approval.requested` / `approval.resolved` 처리부), `reconcileChanges`
- `/packages/server/src/teams/room-manager.ts` — `post`, `update`(`RoomMessagePatch`), `messagesSince`, `detail`
- `/packages/server/src/sessions/manager.ts` — `static async open`(로드 시 `session.pendingApprovals = 0`), `get(id)`, `pendingApprovals(id)`(모르는 id 면 **throw**), `resolvePendingBySystem`(이미 `{ optionId: "abort", by: "system" }` 규약을 쓴다), `close`, `interrupt`
- `/packages/server/test/teams/team-manager.test.ts` — 특히 `"restart restores teams, rooms, messages and changes, resets member states and announces the restart"` 케이스

이전 phase 에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 배경: 실제로 관측된 결함

사용자의 실제 팀에서 재현·확인한 사실이다.

1. 팀원 세션이 승인을 요청하면 그 방에 `kind: "approval"` 카드가 미러링되고 `approval.resolution` 은 `null` 이다.
2. 서버(LaunchAgent `dev.mam.dev-gateway`)가 재시작하면 `SessionManager.open` 이 모든 세션의 `pendingApprovals` 를 0 으로 되돌리고, `TeamManager.open` 은 팀원 상태를 `idle` 로 내린 뒤 그룹방에 재시작 공지를 남긴다. **그런데 방의 승인 카드는 `resolution: null` 인 채로 영원히 남는다.**
3. 결과: 방에 노란 "승인 대기" 카드가 계속 떠 있고 `room.snapshot.pendingApprovals` 에도 계속 들어간다. 사용자가 그 카드를 눌러 응답하면 서버는 `HTTP 404 {"error":{"code":"not_found","message":"승인 요청을 찾을 수 없습니다"}}` 를 돌려준다. 실제 확인한 값: `POST /api/v1/sessions/ses_01M2CXVR7B1H2J75V9VZB2M3B3/approvals/apr_01M2G3WYK14BJ1M70479HVP20Z` → 404.
4. 사용자는 이것을 "full-auto 로 바꿨는데도 계속 승인을 물어본다" 로 겪었다. 실제로는 모드 변경 **이전**에 만들어진 유령 카드가 지워지지 않은 것이었다(세션은 `mode: full-auto`, `pendingApprovals: 0`).

같은 유령은 팀원 세션을 닫는 경로(`resetMember`, `removeMember`)에서도 생길 수 있다. 그 경로는 `interrupt` → `closeSession` 순인데, `SessionManager.interrupt`/`close` 의 `resolvePendingBySystem` 이 내보내는 `approval.resolved` 는 **그 순간 TeamManager 가 그 세션을 구독 중일 때만** 방에 반영된다(구독은 디스패치 턴 동안만 유지된다).

## 확정된 결정 (설계 인터뷰 결과, 바꾸지 마라)

1. **정리 주체는 시스템, 표시는 취소.** 유령 카드는 `resolution = { optionId: "abort", by: "system", at: <now> }` 로 채운다. `SessionManager.resolvePendingBySystem` 이 이미 쓰는 것과 **똑같은 규약**이다. 프로토콜은 이미 `by: "system"` 을 허용하므로 **스키마·fixture 변경은 없다.**
2. **승인에 시한은 두지 않는다.** 살아 있는 승인은 사람이 답할 때까지 무한히 기다린다. 타임아웃·만료 기능을 만들지 마라.
3. **진실은 세션이다.** 카드를 무조건 지우는 것이 아니라 `SessionManager` 에 그 `approvalId` 가 아직 대기 중인지 물어보고, **없을 때만** 정리한다. 재시작 직후에는 모든 세션의 대기 승인이 0 이므로 결과적으로 전부 정리된다.
4. **추가 안내 메시지는 남기지 않는다.** 재시작 공지(`RESTART_NOTICE`)가 이미 있고, 카드 자체가 "취소됨"으로 바뀐다. 카드 개수만큼 시스템 메시지를 쌓지 마라.
5. 사용자의 현재 유령 카드 2건은 이 고침이 배포되고 게이트웨이가 재시작되면 자동으로 정리된다. 마이그레이션 스크립트를 따로 만들지 마라.

## 작업

### 1. `src/teams/team-manager.ts` — 재조정 메서드

```ts
/**
 * 방에 미러링된 승인 카드 중 세션에 더 이상 대기 중이 아닌 것을 시스템 취소로 정리한다.
 * 서버 재시작·팀원 세션 종료 뒤 남는 유령 카드를 없앤다. 정리한 개수를 돌려준다.
 */
private async reconcileApprovals(rt: TeamRuntime): Promise<number>;
```

규칙:

- `rt.record.rooms` 전부(그룹방·DM·곁방)를 훑는다. 방마다 `await rt.rooms.messagesSince(room.id, 0)`.
- 대상은 `m.kind === "approval" && m.approval !== null && m.approval.resolution === null` 인 메시지뿐이다.
- **살아 있는지 판정**: `this.manager.get(m.approval.sessionId)` 가 `undefined` 면 유령. 세션이 있으면 `this.manager.pendingApprovals(m.approval.sessionId)` 에 같은 `approvalId` 가 있는지 보고, 있으면 **건드리지 않는다**. `pendingApprovals` 는 모르는 id 에 throw 하므로 반드시 `get()` 으로 먼저 확인하거나 try/catch 로 감싼다.
- 유령이면 `await rt.rooms.update(room.id, m.id, { approval: { ...m.approval, resolution: { optionId: "abort", by: "system", at: this.now().toISOString() } } })`.
- 방 하나가 실패해도 나머지를 계속한다. 실패는 `this.logger.warn` 으로만 남기고 **메시지 본문·승인 제목은 로그에 넣지 마라**(CRITICAL 6). 방 id·팀 id·오류 메시지까지만.
- 메서드는 팀원 상태(`member.state`)를 바꾸지 않는다. 상태는 호출부가 이미 정한다.

### 2. 호출 지점 세 곳

- `static async open()`: 각 팀의 `register(record)` 뒤, `reconcileChanges(rt)` 옆에서 `await tm.reconcileApprovals(rt)` 를 부른다. `interrupted` 여부와 무관하게 **항상** 부른다(상태가 이미 idle 이어도 카드는 남아 있을 수 있다). 여기서 던진 예외가 서버 기동을 막으면 안 된다 — `reconcileChanges` 와 같은 수준으로 방어한다.
- `resetMember()`: `await this.closeSession(member)` 뒤에.
- `removeMember()`: `await this.closeSession(member)` 뒤에.

### 3. 문서

- `docs/PROTOCOL.md` 6.4 "승인 미러링" 항목에 (2026-09-15 추가) 표기로 두 문장: 서버가 다시 열릴 때와 팀원 세션이 닫힐 때(초기화·제거) 서버는 방의 미해결 승인 카드를 세션의 실제 대기 목록과 맞춰 보고, 세션에 없는 카드는 `{ optionId: "abort", by: "system" }` 으로 정리해 `room.message.updated` 로 내보낸다. 승인 자체에는 시한이 없어 살아 있는 요청은 사람이 답할 때까지 남는다.
- `docs/ADR.md` 에 `## ADR-019 방 승인 카드의 진실은 세션이다 (시한 없음, 재시작 때 재조정)` 를 추가한다. 맥락으로 위 "배경" 의 관측 사실(404 응답, full-auto 오해)을 한두 줄 적고, 결정(재조정 + `by: "system"` 규약 재사용 + 타임아웃 없음)과 결과(스키마 변경 없음, 유령 카드는 다음 기동에 자동 정리)를 적는다.

### 4. 테스트 (먼저 쓴다)

`packages/server/test/teams/team-manager.test.ts` 의 재시작 케이스 근처에 추가한다(새 파일을 만들어도 된다).

- **재시작 정리**: FakeAdapter 로 승인을 요청하게 만들어 방에 `resolution: null` 카드를 만든 뒤, `TeamManager`/`SessionManager` 를 닫고 같은 `dataDir` 로 다시 `open` 한다 → 그 카드의 `approval.resolution` 이 `{ optionId: "abort", by: "system" }` 이고, `roomPendingApprovals(teamId, roomId)` 가 빈 배열이다.
- **살아 있는 승인은 지키기**: 팀원 A 가 승인 대기 중인 같은 프로세스에서 **다른 팀원 B** 에게 `resetMember` 를 호출한다 → A 의 카드는 `resolution: null` 그대로다(재조정이 살아 있는 승인을 죽이지 않는다). 이 단언이 이 step 의 핵심 안전장치다.
- **`resetMember` 정리**: 승인 대기 중인 팀원 자신을 `resetMember` 하면 그 카드가 system abort 로 정리된다. `removeMember` 도 같은 방식으로 한 케이스.
- **이미 해결된 카드 불변**: 사용자가 실제로 응답해 `by: "client"` 로 해결된 카드는 재시작 후에도 `optionId`·`by` 가 그대로이고 재조정이 다시 쓰지 않는다(`room.message.updated` 이벤트가 추가로 발생하지 않는지 구독으로 확인).
- **이벤트 전파**: 정리 결과가 `room.message.updated` 로 구독자에게 나간다(같은 `message.id`, `message.seq` 는 원래 값 유지).

## Acceptance Criteria

```bash
npm ci
npm run typecheck
npm test
grep -q "reconcileApprovals" packages/server/src/teams/team-manager.ts
grep -q "ADR-019" docs/ADR.md
bash scripts/dev-smoke.sh
bash scripts/test.sh
```

`bash scripts/dev-smoke.sh` 가 7777 포트 충돌로 실패하면 `MAM_DEV_PORT=7799 bash scripts/dev-smoke.sh` 로 돌린다(개발용 LaunchAgent `dev.mam.dev-gateway` 가 7777 을 쓰고 있다). **LaunchAgent 를 끄지 마라** — step 2 가 설치·재시작을 맡는다.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 프로토콜 스키마와 fixture 가 하나도 바뀌지 않았는가(`by: "system"` 은 이미 있는 값이다)?
   - 방 seq 를 직접 만들지 않고 `RoomManager.update` 만 썼는가(CRITICAL 7)?
   - 살아 있는 승인을 죽이지 않는가(세션에 대기 중이면 건드리지 않는다)?
   - 로그에 승인 제목·메시지 본문이 들어가지 않는가(CRITICAL 6)?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`
   - 실패 → `error` / 개입 필요 → `blocked` / 설계 분기 → `needs_input`

## 금지사항

- 승인 타임아웃·만료를 만들지 마라. 이유: 사용자가 "시한 없음"으로 확정했다. 살아 있는 요청은 사람이 답할 때까지 기다린다.
- 미해결 카드를 조건 없이 전부 정리하지 마라. 이유: 같은 프로세스에서 실제로 사람을 기다리는 승인이 사라지면 에이전트가 영원히 멈춘다. 반드시 `SessionManager` 에 물어본 뒤 정리한다.
- 카드를 삭제하거나 `kind` 를 바꾸지 마라. 이유: 방 로그는 기록이다. `resolution` 만 채운다.
- 정리한 카드마다 시스템 메시지를 남기지 마라. 이유: 재시작 공지가 이미 있고 방이 더 시끄러워진다.
- `SessionManager` 를 고치지 마라. 이 결함은 팀 계층(방 카드)에만 있다.
- iOS 를 수정하지 마라(step 1).
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
