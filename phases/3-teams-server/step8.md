# Step 8: teams-smoke-and-docs

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/PROTOCOL.md` 6절, `/docs/ARCHITECTURE.md`, `/docs/RUNBOOK.md`, `/README.md`, `/docs/PRD.md` (4절 기능 표, 6절 범위 밖)
- `/scripts/dev-smoke.sh`, `/scripts/dev-smoke.mjs` (1~14단계 구조, `api()`, `connect()`, `assertMonotonicSeq`, `~/.mam/smoke/<ts>` 작업 디렉토리)
- `/packages/server/src/agents/fake/script.ts` (`defaultScript`, `ScriptContext.cwd`)
- `/packages/server/src/teams/*.ts`, `/packages/server/src/agent-host/routes/teams.ts`, `ws-rooms.ts` (step 3~7)
- `/packages/server/test/agents/claude/integration.test.ts`, `codex/integration.test.ts` (`MAM_IT_*` 게이트 방식)

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

이 phase 를 **종단(e2e) 스모크** 로 검증하고 문서를 맞춘다. iOS 는 건드리지 않는다(phase `4-teams-ios`).

### 1. Fake 기본 스크립트 확장 (`agents/fake/script.ts`)

`defaultScript` 에 두 가지 지시를 추가한다(다른 동작은 그대로):

- 입력 텍스트에 `write file <이름>` 이 있으면 `ctx.cwd/<이름>` 에 텍스트 한 줄을 쓰고 `file_change` 아이템(kind add/modify, patch 는 간단히)을 낸다. 파일 이름은 `[A-Za-z0-9._-]+` 만 허용(경로 구분자 금지).
- 입력 텍스트에 `ask @<핸들>` 이 있으면 답변(`assistant_message`)에 `@<핸들> 확인 부탁해요.` 를 넣는다(연쇄 검증용).

### 2. dev-smoke 15~20단계 (`scripts/dev-smoke.mjs`)

기존 14단계 뒤에, `~/.mam/smoke/<ts>/repo` 에 `git init` + 첫 커밋(`spawn("git", …)`, 셸 문자열 금지)을 만든 뒤:

15. `GET /team-roles` → 5개. `POST /teams { cwd: repo, name: "smoke", members: [팀장 민수(claude), 개발자 지연(codex)] }` → 201, `members[*].sessionId` 있음, worktree 디렉토리 존재, `git branch --list "mam/smoke/*"` 2개.
16. 방 WS 접속(그룹방) → `room.snapshot`(seq 0). `POST …/rooms/<group>/messages { text: "hello" }` → 201 → WS 로 `room.message`(user) 다음 `room.message`(agent = 팀장, `work` 있음)와 `room.status`. seq 단조 검증(`assertMonotonicSeq` 재사용).
17. `"@jiyeon write file smoke.txt"` → 지연의 답변 + `room.message`(kind `changes`, `status: ready`, files 에 `smoke.txt`). `GET /teams/:id/changes` 에 1개.
18. DM 방 WS 접속 → `room.send { text: "ask @minsu" }` → 지연 답변(`@minsu …`)이 DM 에 오고, **그룹방에는 연쇄가 생기지 않는다**(DM 멘션 무시 확인: 그룹방 메시지 수 불변).
19. `POST …/changes/<id>/merge` → `merged`, `git -C repo log --merges --oneline` 에 1개, `git -C repo show --stat HEAD` 에 `smoke.txt`. 이어서 `POST …/stop` → 200.
20. `DELETE /teams/:id` → 200, worktree 디렉토리 없음, `GET /teams` 에 없음. 팀원 세션은 `GET /sessions?status=closed` 에 `team` 필드와 함께.

실패 시 어느 단계인지 출력하고 종료 코드 1. `--keep` 이면 서버를 남긴다(iOS UI 테스트가 이 흐름을 재사용한다).

### 3. 통합 테스트(선택, 게이트 밖)

`test/teams/integration.test.ts`: `MAM_IT_CLAUDE=1` 일 때만. 임시 git 저장소에 Claude 팀장 1명 팀을 만들고 `"Reply with exactly the word pong."` → 방에 답변이 오고 `work.toolCalls` 가 숫자인지. 비용 수 센트. `MAM_IT_CODEX=1` 도 같은 형태. 실행하지 않았으면 summary 에 적는다.

### 4. 문서

- `README.md`: 개발 빠른 시작에 팀 생성·메시지 curl 예시 2개(`POST /teams`, `POST …/messages`)와 "에이전트 worktree 는 `~/.mam/teams/<teamId>/worktrees/` 에 생기고 `node_modules` 는 없다" 한 줄.
- `docs/ARCHITECTURE.md`: 2.5 `TeamManager`(팀·방·디스패처·worktree·머지 요약, 세션 구독은 턴 동안만), 3 저장소 구조 표에 `teams/`, `team-templates/`, 4 런타임 경로에 worktree 경로, 6 보안 모델에 "worktree 도 홈 안, git 은 spawn".
- `docs/RUNBOOK.md`: "팀 운영" 절 — 팀 만들기, 머지 승인, 충돌 시 흐름, 더러운 worktree 삭제(`keepWorktrees`), 한도 걸림 시 재개, 프롬프트 수정은 다음 세션부터(기억 초기화 버튼), worktree 에 의존성 설치가 필요하면 사용자가 직접(후속 과제).
- `docs/PRD.md`: 4절 기능 표에 `F16 에이전트 팀(Phase 3)`, 6절 범위 밖에 "worktree 의존성 자동 설치, 자동 머지, 실시간 답변 스트리밍(v1)" 추가. phase 번호 표를 `3 에이전트 팀(서버), 4 에이전트 팀(iOS), 5 웹 대시보드, 6 운영` 으로 갱신.
- `docs/IOS.md` 는 손대지 않는다.

## Acceptance Criteria

```bash
npm ci
npm run typecheck
npm test
bash scripts/dev-smoke.sh
grep -q "TeamManager" docs/ARCHITECTURE.md
grep -q "팀 운영" docs/RUNBOOK.md
grep -q "F16" docs/PRD.md
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - dev-smoke 가 PROTOCOL.md 6절의 엔드포인트·이벤트를 실제로 통과하는가? seq 단조가 방마다 지켜지는가?
   - 스모크가 만든 저장소·worktree 가 `~/.mam/smoke/` 와 `~/.mam/teams/` 밖으로 나가지 않는가?
   - 서버 코드를 고쳤다면 회귀 테스트를 추가했는가?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약. 통합 테스트 실행 여부·관측값 포함)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- iOS(`ios/`)를 수정하지 마라. 이유: phase `4-teams-ios` 의 범위다(fixture 테이블은 step 0 이 이미 맞췄다).
- 통합 테스트에서 `full-auto` 나 파일을 바꾸는 지시를 보내지 마라. pong 한 턴이면 충분하다.
- `pkill -f node` 같은 광범위한 종료를 하지 마라. 이 step 이 띄운 pid 만 정리한다.
- 설계 변경이 필요한 버그는 고치지 말고 `needs_input`.
- `packages/protocol` 을 수정하지 마라.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
