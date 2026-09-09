# Step 10: dev-smoke-e2e

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/ARCHITECTURE.md` (2.1 개발 모드, 8절 테스트 전략의 e2e)
- `/docs/PROTOCOL.md` (2절 WS 이벤트 순서)
- `/packages/server/src/cli.ts`, `/packages/server/src/gateway/server.ts`, `supervisor.ts` (step 7)
- `/packages/server/src/agent-host/server.ts`, `ws.ts` (step 4), `/packages/server/src/agents/fake/` (step 2)
- `/docs/RUNBOOK.md` (step 8)

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

개발 모드 gateway + Fake 어댑터로 REST → WS → 승인 응답 → 완료까지 자동 검증하는 스모크 스크립트와 루트 README를 만든다. Phase 1(iOS)과 Phase 2(웹)가 이 스크립트가 띄운 서버를 개발 백엔드로 쓴다.

### 1. `scripts/dev-smoke.sh`

```bash
bash scripts/dev-smoke.sh            # 빌드 → 서버 기동 → 검증 → 종료, exit 0/1
bash scripts/dev-smoke.sh --keep     # 검증 후 서버를 유지 (Ctrl-C 로 종료). iOS/웹 개발용
```

- `set -euo pipefail`, `trap` cleanup으로 gateway와 그 자식(agent-host)을 항상 정리한다(gateway에 SIGTERM → 3초 대기 → 남은 `agent-host --socket` 프로세스는 이 스크립트가 시작한 것만 pid 파일로 추적해 kill).
- 포트는 `MAM_DEV_PORT`(기본 7777). 사용 중이면 즉시 실패 메시지.
- `npm run build` → `MAM_FAKE_AGENT=1 node packages/server/dist/cli.js gateway --dev &` → `/healthz` 200까지 최대 15초 대기 → `node scripts/dev-smoke.mjs` 실행.

### 2. `scripts/dev-smoke.mjs`

Node 24 내장 `fetch`와 `ws`(workspace 의존성, `packages/server/node_modules` 또는 루트 hoist에서 import 가능해야 한다. 안 되면 `node --import` 없이 `createRequire`로 `@mam/server` 경로 기준 해석)를 써서 순서대로 검증한다. 실패 시 어떤 단계인지와 받은 이벤트 목록을 출력하고 exit 1.

1. `GET /api/v1/me` → `user === os.userInfo().username`, `agents.length === 2`.
2. 임시 cwd: `$HOME/.mam/smoke/<timestamp>` 생성(홈 아래여야 샌드박스를 통과한다).
3. `POST /api/v1/sessions { agent:'claude', cwd }` → 201, `status` in `starting|idle`.
4. `GET /api/v1/fs/list?path=<cwd>` → 200, `GET /api/v1/fs/list?path=/etc` → 403.
5. WS `ws://127.0.0.1:<port>/api/v1/sessions/<id>/ws` 접속 → 첫 메시지 `session.snapshot`.
6. `turn.start { text: 'hello' }` → 30초 안에 `item.delta`, `approval.requested`(kind command) 수신. seq가 단조 증가하는지 검사.
7. `approval.respond { approvalId, optionId: 'allow' }` → `approval.resolved`, `item.completed`(tool_call), `turn.completed`, `session.status idle`.
8. 두 번째 WS를 `?since=<중간 seq>`로 열어 스냅샷 + 재생 이벤트가 이어지는지.
9. `GET /api/v1/sessions/<id>` → items에 `approval` 아이템의 `resolution`이 있다.
10. `POST /api/v1/sessions/<id>/close` → `closed`. 임시 cwd 삭제(`fs.rm` 해당 경로만).

### 3. 루트 `README.md`

- 한 문단 소개, 아키텍처 그림(ARCHITECTURE 1절 재사용), 디렉토리 요약.
- 개발 빠른 시작: `npm ci`, `bash scripts/dev-smoke.sh --keep`, `curl` 예시 2개, 테스트 명령.
- 프로덕션 설치는 `docs/RUNBOOK.md`로 링크. 문서 목록 링크.
- 루트 `package.json`에 `"smoke": "bash scripts/dev-smoke.sh"` 스크립트 추가.

### 4. 발견한 버그

스모크가 이전 step의 버그를 드러내면 최소 수정으로 고치고 회귀 테스트를 해당 패키지 테스트에 추가한 뒤 summary에 파일과 원인을 적어라. 설계 변경이 필요해 보이면 고치지 말고 `needs_input`.

## Acceptance Criteria

```bash
npm ci
npm run typecheck
npm test
bash scripts/dev-smoke.sh
bash scripts/dev-smoke.sh                       # 두 번 연속 통과 (멱등)
pgrep -f "agent-host --socket" && exit 1 || true    # 잔여 프로세스 없음
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 스모크가 `docs/PROTOCOL.md` 2절의 이벤트 순서를 그대로 검증하는가?
   - 서버 코드 수정이 있었다면 CLAUDE.md CRITICAL 규칙을 지키는가?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- 스모크에서 실제 Claude/Codex 어댑터를 쓰지 마라. 이유: 비용과 로그인 의존. Fake 전용(`MAM_FAKE_AGENT=1`).
- `pkill -f node`처럼 광범위한 프로세스 종료를 하지 마라. 이유: 하네스 세션 자체와 다른 작업을 죽인다. 이 스크립트가 띄운 pid만 정리한다.
- `rm -rf`를 쓰지 마라. 임시 cwd는 `fs.rm(path, { recursive: true })`로 정확한 경로만 지운다.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
