# Step 0: projects-and-session-gc

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md` (CRITICAL 2, 3, 6)
- `/docs/PROTOCOL.md` 1절 `GET /projects`·`Project`, 2절 세션, 6절 팀
- `/docs/ARCHITECTURE.md` 2.2 agent-host 의 데이터 디렉토리(`~/.mam/`) 설명
- `/packages/server/src/agent-host/routes/projects.ts` (전체. 20줄쯤이다)
- `/packages/server/src/agent-host/server.ts` (`dataDir` 결정부, `AgentHostRuntime` 구성)
- `/packages/server/src/agent-host/http.ts` (`AgentHostRuntime` 타입)
- `/packages/server/src/sessions/manager.ts` — `static open`(레코드 로드), `list()`, `close()`, `sessionsDir`, `newRuntime`, 이벤트 로그 파일명 규칙
- `/packages/server/src/teams/team-manager.ts` — `static open`, `deleteTeam`, `closeSession`
- `/packages/server/test/` 의 기존 라우트·매니저 테스트 구조

이전 phase 에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 배경: 실제로 관측된 결함

사용자의 실제 서버에서 잰 값이다.

| 항목 | 값 |
|---|---|
| 프로젝트 목록 | 494개 |
| 그중 이름이 `agt_…` | 364개 |
| 세션 레코드 | 611개 |
| 그중 이미 지워진 팀의 팀원 세션 | 355개(전부 `closed`) |

원인 둘이다.

1. **`GET /projects` 가 팀원 세션까지 프로젝트로 센다.** 팀원 세션의 `cwd` 는 그 팀원의 worktree(`~/.mam/teams/<팀>/worktrees/<agt_…>`)이고, 라우트는 모든 세션의 `cwd` 마다 항목을 만들며 이름을 `basename` 으로 붙인다. 그래서 팀원 한 명이 `agt_…` 라는 프로젝트 한 개가 된다. 사용자가 실제로 쓰는 프로젝트 4개가 수백 개 사이에 묻혔다.
2. **팀을 지워도 팀원 세션 레코드가 남는다.** `deleteTeam` 은 `closeSession` 만 부르고 레코드 파일은 지우지 않는다. 세션을 지우는 API 도 `SessionManager` 의 삭제 메서드도 없다. 그래서 1번의 결과가 영원히 누적된다.

2026-09-16 에 사용자 데이터의 찌꺼기는 손으로 한 번 치웠다(프로젝트 494→13, 세션 611→61). 이 step 은 **다시 쌓이지 않게** 만드는 일이다.

## 확정된 결정 (사용자 승인, 바꾸지 마라)

1. 프로젝트 목록에서 **팀원 세션을 제외한다**(`session.team` 이 있으면 세지 않는다).
2. 프로젝트 목록에서 **데이터 디렉토리 안의 경로를 제외한다**. `~/.mam` 은 서버 내부 상태이지 사용자의 프로젝트가 아니다.
3. 팀을 지울 때 **그 팀원 세션 레코드도 지운다**.
4. 서버가 열릴 때 **없는 팀에 속한 세션 레코드를 지운다**(과거에 새는 경로로 생긴 것 수거).
5. 승인 카드 정리(phase 11)와 같은 원칙: 지우는 대상은 **확실히 죽은 것만**. 살아 있는 팀의 팀원 세션은 절대 건드리지 않는다.

## 작업

### 1. `src/agent-host/routes/projects.ts`

세션을 훑는 반복문에서 두 가지를 건너뛴다:

- `session.team !== undefined` → 건너뛴다(팀원 작업 공간은 프로젝트가 아니다).
- `session.cwd` 가 데이터 디렉토리(`host.dataDir`) 와 같거나 그 아래 → 건너뛴다. 경로 비교는 문자열 `startsWith` 가 아니라 **경로 경계까지 확인**하라(`/Users/x/.mamXYZ` 가 걸리면 안 된다). `node:path` 의 `relative` 를 쓰거나 구분자를 붙여 비교한다.

`workspaceRoot` 를 훑어 만드는 기본 항목(세션이 없는 디렉토리)은 그대로 둔다. `AgentHostRuntime` 에 `dataDir` 이 없으면 더한다(`server.ts` 가 이미 값을 안다).

### 2. `src/sessions/manager.ts` — 레코드 삭제

```ts
/** 세션 레코드와 이벤트 로그를 지운다. 살아 있는(닫히지 않은) 세션은 거부한다. */
async delete(id: string): Promise<void>;
```

- 대상 세션이 `closed` 가 아니면 `InvalidRequestError`. 어댑터 프로세스가 남아 있으면 안 된다.
- 메모리 레지스트리에서 제거하고, `sessions/<id>.json` 과 `sessions/<id>.events.jsonl` 을 지운다. 없으면 조용히 넘어간다.
- 구독자가 있으면 정리한다. 로그에 본문을 남기지 마라(CRITICAL 6).
- **HTTP 라우트는 만들지 마라.** 이 step 의 범위는 내부 API 다. 사용자가 세션을 지우는 UI 는 이 phase 밖이다.

### 3. `src/teams/team-manager.ts`

- `deleteTeam`: 각 팀원에 대해 `closeSession(m)` 뒤 `this.manager.delete(m.sessionId)` 를 부른다. 실패는 `logger.warn` 으로 남기고 팀 삭제 자체는 계속 진행한다(부분 실패로 팀이 남으면 더 나쁘다).
- `removeMember`: 같은 방식으로 그 팀원의 세션 레코드를 지운다.
- `static open()`: 팀을 전부 등록한 뒤, `manager.list()` 에서 `session.team` 이 있고 그 `teamId` 가 로드된 팀에 없는 세션을 찾아 `delete` 한다. 지운 개수를 `logger.info` 로 한 줄 남긴다(id 나 경로는 남기지 마라). 이 수거가 서버 기동을 막으면 안 된다 — `reconcileApprovals` 와 같은 수준으로 방어한다.

### 4. 문서

- `docs/PROTOCOL.md` 1절 `GET /projects` 설명에 (2026-09-16 추가) 한 줄: 팀원 세션과 데이터 디렉토리 안의 경로는 프로젝트로 세지 않는다. 팀원의 작업 공간은 팀 화면에서 본다.
- `docs/ARCHITECTURE.md` 2.5(TeamManager) 에 한 줄: 팀·팀원을 지우면 그 세션 레코드와 이벤트 로그도 지운다. 기동 시 없는 팀의 세션 레코드를 수거한다.

### 5. 테스트 (먼저 쓴다)

- `projects` 라우트: 팀원 세션(`team` 있음)만 있는 cwd 는 목록에 없다 / 일반 세션의 cwd 는 있다 / 데이터 디렉토리와 그 하위는 없다 / `~/.mamXYZ` 처럼 이름만 겹치는 경로는 **살아남는다**(경계 검사) / `workspaceRoot` 하위 디렉토리는 세션이 없어도 그대로 나온다.
- `SessionManager.delete`: 닫힌 세션은 파일 두 개가 사라지고 `list()` 에서 빠진다 / 열린 세션은 거부 / 이미 없는 파일이어도 던지지 않는다.
- `TeamManager`: `deleteTeam` 뒤 그 팀원 세션이 `manager.list()` 에 없다 / `removeMember` 도 같다 / **살아 있는 팀의 팀원 세션은 재기동 수거에서 살아남는다** / 팀 디렉토리를 지운 뒤 `TeamManager.open` 하면 그 팀 소속 세션 레코드가 사라진다.

## Acceptance Criteria

```bash
npm ci
npm run typecheck
npm test
grep -q "dataDir" packages/server/src/agent-host/routes/projects.ts
bash scripts/test.sh
```

`bash scripts/dev-smoke.sh` 는 이 step 에서 돌리지 마라 — 지금은 개발용 게이트웨이의 소켓과 실제 데이터 디렉토리를 건드린다. 그 격리가 step 2 의 일이고, 종단 검증은 step 3 이 한다.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 살아 있는 팀의 팀원 세션이 어떤 경로로도 지워지지 않는가?
   - 경로 비교가 경로 경계를 지키는가(접두어 일치가 아니라)?
   - 세션 삭제가 홈 밖을 건드릴 수 없는가(CRITICAL 3)?
   - 로그에 경로·본문·id 가 남지 않는가(CRITICAL 6)?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`
   - 실패 → `error` / 개입 필요 → `blocked` / 설계 분기 → `needs_input`

## 금지사항

- `DELETE /sessions/:id` 같은 HTTP 라우트를 만들지 마라. 이유: 사용자가 세션을 지우는 UI 는 이 phase 범위 밖이고, 프로토콜을 늘리면 iOS 까지 따라와야 한다.
- 닫히지 않은 세션을 지우지 마라. 이유: 어댑터 프로세스가 살아 있는데 레코드만 사라지면 고아 프로세스가 된다.
- 프로젝트 목록에서 `workspaceRoot` 기본 항목을 없애지 마라. 이유: 세션이 없는 새 프로젝트를 고를 수 있어야 한다.
- 기존 세션 목록(`GET /sessions`) 의 내용을 바꾸지 마라. 팀원 세션은 거기 그대로 있어야 한다(팀 화면이 쓴다).
- iOS 를 수정하지 마라(step 1).
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
