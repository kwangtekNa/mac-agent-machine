# Step 2: test-data-isolation

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md` (CRITICAL 3, 4)
- `/docs/ARCHITECTURE.md` 2.1 gateway 의 **개발 모드** 문단(`$TMPDIR/mam-dev/agent.sock`, `MAM_DEV_PORT`, `MAM_DEV_BIND`), 2.2 agent-host 의 `~/.mam/`
- `/packages/server/src/gateway/supervisor.ts` — `DEV_SOCKET_ROOT`, `socketPathFor`, `ensure`, `start`, `tryConnect`, `stop`, `SupervisorOptions.socketRoot`
- `/packages/server/src/agent-host/server.ts` — `dataDir` 결정부(`opts.dataDir ?? join(home, ".mam")`)
- `/packages/server/src/cli.ts` — `gateway --dev` 와 `agent-host` 가 옵션을 읽는 곳
- `/packages/server/src/config.ts` (있다면) 개발 모드 설정
- `/scripts/dev-smoke.sh`, `/scripts/dev-smoke.mjs` — 특히 `path.join(homedir(), ".mam", "smoke", …)` 와 worktree 를 확인하는 부분
- `/packages/server/test/gateway/*.test.ts`

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 배경: 두 번 사고를 낸 결함

2026-09-15 와 09-16 에 실제로 벌어진 일이다.

1. **개발 소켓 경로가 고정이다.** `DEV_SOCKET_ROOT = join(tmpdir(), "mam-dev")` 에는 포트도 인스턴스 구분도 없다. agent-host 는 바인드 전에 그 경로의 소켓을 지우고(`server.ts` 의 `unlinkIfExists`) 종료할 때 또 지운다. 그래서 `dev-smoke.sh` 를 돌리면 **살아 있던 개발용 게이트웨이(LaunchAgent `dev.mam.dev-gateway`)의 소켓을 빼앗고, 끝나면서 지운다.**
2. **게이트웨이가 스스로 못 고친다.** `Supervisor.ensure()` 는 항목이 `ready` 이고 자식 프로세스가 살아 있으면 바로 반환할 뿐, 소켓 파일이 아직 있는지 보지 않는다. 그래서 그 뒤 모든 요청이 `502 {"code":"agent_unavailable","message":"agent-host unreachable (ENOENT)"}` 로 끝나고 사람이 LaunchAgent 를 다시 올릴 때까지 복구되지 않는다. 사용자의 폰이 20분 넘게 끊겼다.
3. **스모크가 실제 데이터 디렉토리를 쓴다.** `dev-smoke.mjs` 가 `~/.mam/smoke/<타임스탬프>` 에 저장소를 만들고, 스모크가 띄운 게이트웨이의 agent-host 도 `~/.mam` 을 그대로 쓴다. 그 결과 사용자의 실제 세션 저장소에 테스트 세션 192개와 고아 worktree 가 쌓였다(2026-09-16 에 손으로 치웠다).

## 확정된 결정 (사용자 승인, 바꾸지 마라)

1. 개발 게이트웨이의 **소켓 경로에 포트를 넣어** 인스턴스를 가른다. 환경변수로 덮어쓸 수도 있게 한다.
2. **끊긴 소켓은 자동 복구한다.** 소켓이 사라졌으면 agent-host 를 다시 띄운다.
3. **dev-smoke 는 자기만의 데이터 디렉토리와 소켓 경로를 쓴다.** 끝나면 그 디렉토리를 지운다. `~/.mam` 을 건드리지 않는다.
4. 프로덕션 경로(`PROD_SOCKET_ROOT`, LaunchDaemon)는 **바꾸지 마라**. 개발 모드만 다룬다.

## 작업

### 1. 소켓 경로 분리 (`src/gateway/supervisor.ts`)

- 개발 모드 소켓 루트를 포트로 가른다: 기본값을 `join(tmpdir(), "mam-dev", String(devPort))` 로. 포트를 모르는 자리면 `SupervisorOptions.socketRoot` 로 받아 넘긴다(이미 있는 옵션이다). 호출부(`cli.ts` / gateway 기동부)가 개발 포트를 알고 있으니 거기서 넘긴다.
- 환경변수 `MAM_DEV_SOCKET_ROOT` 가 있으면 그것을 우선한다. 값 검증: 절대 경로여야 하고, 사용자 홈 또는 `tmpdir()` 아래여야 한다(아니면 기동 시 명확한 오류). 셸을 거치지 마라(CRITICAL 4).
- `DEV_SOCKET_ROOT` 를 그대로 export 하는 기존 소비자가 있으면 함수(`devSocketRoot(port, env)`)로 바꾸고 호출부를 고친다.

### 2. 끊긴 소켓 복구 (`src/gateway/supervisor.ts`)

`ensure()` 의 빠른 반환 경로에 확인을 더한다:

- 항목이 `ready` 이고 자식이 살아 있어도 **소켓 파일이 없으면** 죽은 것으로 보고 정리한 뒤 다시 띄운다(기존 `start` 경로 재사용).
- 확인은 싸게 한다. `stat` 한 번이면 된다. 매 요청마다 소켓에 연결해 보지 마라(지연이 늘고 의미도 없다).
- 되살릴 때 기존 자식 프로세스가 남아 있으면 먼저 정리한다(고아 프로세스 금지).
- 재시작 폭주를 막는 기존 백오프·`crashStreak` 규칙을 그대로 따른다.

### 3. dev-smoke 격리 (`scripts/dev-smoke.sh`, `scripts/dev-smoke.mjs`)

- 스크립트가 시작할 때 임시 루트를 하나 만든다(`mktemp -d`). 그 아래 `data/`(agent-host 데이터 디렉토리)와 `sock/`(소켓 루트), 그리고 스모크가 만드는 저장소를 둔다.
- 게이트웨이를 띄울 때 그 경로들을 환경변수로 넘긴다. agent-host 가 데이터 디렉토리를 환경변수로 받을 수 있어야 하면 `MAM_DATA_DIR` 를 더한다(`server.ts` 의 `opts.dataDir ?? join(home, ".mam")` 앞에 환경변수를 끼운다). 홈 밖 경로는 거부한다(CRITICAL 3) — `mktemp -d` 가 주는 `$TMPDIR` 아래는 허용 목록에 넣는다.
- `dev-smoke.mjs` 의 `path.join(homedir(), ".mam", …)` 를 전부 그 임시 루트 기준으로 바꾼다. worktree 를 확인하는 단언도 같이 바꾼다.
- 성공하든 실패하든 `cleanup` 에서 임시 루트를 지운다. 단 `--keep` 이면 남기고 경로를 출력한다(UI 테스트가 쓴다).
- **`--keep` 으로 띄운 서버도 `~/.mam` 을 쓰면 안 된다.** UI 테스트가 실제 데이터에 팀을 만들던 문제가 여기서 끝나야 한다.

### 4. 문서

- `docs/ARCHITECTURE.md` 2.1 개발 모드 문단 갱신(2026-09-16): 개발 소켓 경로는 포트별로 갈리고 `MAM_DEV_SOCKET_ROOT` 로 덮어쓸 수 있다. 소켓이 사라지면 게이트웨이가 agent-host 를 다시 띄운다.
- `docs/RUNBOOK.md` 에 한 단락: `bash scripts/dev-smoke.sh` 는 임시 디렉토리에서 돌며 실제 `~/.mam` 을 건드리지 않는다. 개발용 게이트웨이를 내리지 않고 돌려도 된다.
- `docs/ADR.md` 에 `## ADR-020 개발 모드는 인스턴스마다 격리한다` — 위 배경의 관측 사실(502 20분, 실데이터 오염 192건)과 결정을 적는다.

### 5. 테스트 (먼저 쓴다)

- `supervisor`: 포트가 다르면 소켓 경로가 다르다 / `MAM_DEV_SOCKET_ROOT` 가 우선한다 / 홈·tmp 밖 값은 거부한다 / **`ready` 상태에서 소켓 파일을 지우면 `ensure()` 가 자식을 다시 띄운다** / 소켓이 멀쩡하면 다시 띄우지 않는다(불필요한 재시작 없음) / 백오프 중에는 여전히 거부한다.
- `agent-host` 데이터 디렉토리: 환경변수가 있으면 그 경로를 쓰고, 홈 밖이면 거부한다.
- 기존 게이트웨이·프록시 테스트는 무변경 통과.

## Acceptance Criteria

```bash
npm ci
npm run typecheck
npm test
grep -q "MAM_DEV_SOCKET_ROOT" packages/server/src/gateway/supervisor.ts
grep -q "mktemp" scripts/dev-smoke.sh
! grep -n 'homedir(), "\.mam"' scripts/dev-smoke.mjs
bash scripts/test.sh
```

그리고 **살아 있는 개발 게이트웨이를 내리지 않은 채로** 다음이 성립해야 한다:

```bash
launchctl list | grep -q dev.mam.dev-gateway
MAM_DEV_PORT=7799 bash scripts/dev-smoke.sh
curl -sf -m 5 "http://$(/usr/local/bin/tailscale ip -4 | head -1):7777/healthz" >/dev/null
```

마지막 줄이 이 step 의 핵심이다. 스모크를 돌린 뒤에도 실제 게이트웨이가 살아 있어야 한다. 스모크가 끝난 뒤 `~/.mam/sessions` 의 파일 수가 스모크 전과 같아야 한다(세어서 summary 에 적어라).

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 프로덕션 소켓 경로와 LaunchDaemon 설정이 그대로인가?
   - 스모크가 `~/.mam` 에 파일을 하나도 만들지 않는가(전후 개수 비교)?
   - 스모크 뒤 `agent-host` 잔여 프로세스가 없는가?
   - 셸 문자열로 명령을 만들지 않았는가(CRITICAL 4)?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(스모크 전후 `~/.mam/sessions` 파일 수 포함)
   - 실패 → `error` / 개입 필요 → `blocked` / 설계 분기 → `needs_input`

## 금지사항

- `launchctl bootout` 으로 사용자의 개발 게이트웨이를 내리지 마라. 이유: 이 step 의 목적이 "내리지 않아도 안전하다" 를 만드는 것이다. 내리고 통과시키면 아무것도 증명하지 못한다.
- `pkill -f node` 같은 광범위한 종료를 하지 마라. 띄운 pid 만 정리한다.
- 프로덕션 경로(`PROD_SOCKET_ROOT`, `/var/run/mam`, LaunchDaemon plist)를 바꾸지 마라.
- 매 요청마다 소켓에 연결해 보는 확인을 넣지 마라. 이유: 프록시 지연이 늘고 `stat` 로 충분하다.
- `~/.mam` 의 파일을 지우는 코드를 쓰지 마라. 이 step 은 앞으로 안 쌓이게 하는 일이고, 과거 찌꺼기는 이미 손으로 치웠다.
- iOS 를 수정하지 마라.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
