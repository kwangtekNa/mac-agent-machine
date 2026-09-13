# Step 2: dev-gateway-launchagent

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md` (CRITICAL 1, 2, 4)
- `/docs/ARCHITECTURE.md` 1·2.1·4·6, `/docs/ADR.md` ADR-001(Tailscale 전용), ADR-004(개발 모드), `/docs/RUNBOOK.md` 1절 설치, 4절 운영, 5절 문제 해결
- `/README.md` (개발 빠른 시작의 `MAM_DEV_BIND` 설명)
- `/packages/server/src/cli/program.ts` (`devBindOverride`: `MAM_DEV_BIND=tailscale`), `/packages/server/src/gateway/server.ts`, `tls.ts` (`tailscaleIPv4`, `findTailscaleBin`)
- `/packages/server/src/agents/claude/adapter.ts`·`codex/adapter.ts` 의 `resolveBinary`(로그인 셸로 `command -v`; LaunchAgent 환경에서는 nvm 이 안 잡히므로 `MAM_CODEX_BIN`/`MAM_CLAUDE_BIN` 을 명시해야 한다)
- `/scripts/setup-server.sh`(있으면), `/scripts/dev-smoke.sh` (bash 스타일)

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 배경

지금은 개발 gateway 를 손으로 띄우고, 네트워크가 바뀔 때마다 IP 를 맞춘다. **Tailscale IP 에 바인딩한 개발 gateway 를 로그인 시 자동 시작(LaunchAgent)** 하면 어느 네트워크에서든 같은 주소(`http://100.x.y.z:7777`)로 붙는다. Tailscale 로그인 자체는 사람이 한다(RUNBOOK 에 절차만).

## 확정된 결정

- 바인딩은 `MAM_DEV_BIND=tailscale`(tailnet IPv4 에만). `0.0.0.0` 은 쓰지 않는다.
- LaunchAgent(사용자 세션, `~/Library/LaunchAgents/dev.mam.dev-gateway.plist`)로 `node <repo>/packages/server/dist/cli.js gateway --dev` 를 `KeepAlive` 로 돌린다. 정식 LaunchDaemon 설치(RUNBOOK 1절)는 그대로 두고 건드리지 않는다.
- 이 step 은 **스크립트와 문서만** 만든다. 하네스 세션 안에서 `launchctl bootstrap` 을 실행하지 않는다(7777 을 점유해 이후 step 의 dev-smoke 가 깨진다). 실제 설치는 사용자가 phase 뒤에 한다.

## 작업

### 1. `scripts/install-dev-gateway.sh`

```
사용법: bash scripts/install-dev-gateway.sh [--dry-run | --uninstall | --status] [--port 7777]
```

- 전제 확인: `packages/server/dist/cli.js` 존재(없으면 `npm run build --workspaces --if-present` 안내 후 exit 1), Tailscale 앱/CLI 존재(`/Applications/Tailscale.app/Contents/MacOS/Tailscale` 또는 `tailscale`), `tailscale status` 가 로그인 상태가 아니면 경고만 하고 계속(gateway 는 KeepAlive 로 재시도한다).
- 바이너리 해석: `node` 는 `command -v node` 의 절대 경로(nvm 이면 `~/.nvm/versions/node/<v>/bin/node`), `MAM_CODEX_BIN`/`MAM_CLAUDE_BIN` 은 `zsh -ic 'command -v codex'`/`'command -v claude'` 결과(없으면 해당 키 생략). 인자 없이 실행되는 고정 명령이므로 CRITICAL 4 예외 범위다.
- plist 생성(`--dry-run` 이면 stdout 으로만): `Label dev.mam.dev-gateway`, `ProgramArguments [node, <abs>/packages/server/dist/cli.js, gateway, --dev]`, `WorkingDirectory <repo>`, `EnvironmentVariables { MAM_DEV_BIND=tailscale, MAM_DEV_PORT=<port>, MAM_CODEX_BIN, MAM_CLAUDE_BIN, HOME, PATH=<node dir>:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin }`, `RunAtLoad true`, `KeepAlive { SuccessfulExit false }`, `ThrottleInterval 10`, `StandardOutPath`/`StandardErrorPath ~/.mam/dev-gateway.log`.
- 설치: 기존 것이 있으면 `launchctl bootout gui/$UID/dev.mam.dev-gateway` 후 파일 교체, `plutil -lint`, `launchctl bootstrap gui/$UID <plist>`, `launchctl kickstart -k gui/$UID/dev.mam.dev-gateway`, 5초 안에 `curl http://<tailnet ip>:<port>/healthz` 확인, 앱에 넣을 주소를 출력.
- `--uninstall`: bootout + plist 삭제. `--status`: `launchctl print` 요약 + healthz + 주소.
- 이미 손으로 띄운 gateway 가 같은 포트를 잡고 있으면 설치 전에 안내하고 중단(`lsof -nP -iTCP:<port> -sTCP:LISTEN`).

### 2. `scripts/test-install-dev-gateway.sh`(bash 단위 검사, `scripts/test.sh` 의 TS 단계 뒤에 한 줄 추가)

`--dry-run` 출력이 `plutil -lint -` 를 통과하고, `MAM_DEV_BIND=tailscale`·`gateway`·`--dev` 를 포함하며, `launchctl` 을 부르지 않는지(`--dry-run` 경로에서 `launchctl` 문자열이 실행되지 않음을 `bash -x` 로그로 확인). 실제 설치 경로는 테스트하지 않는다.

### 3. 문서

- `docs/RUNBOOK.md` 새 절 `## 8. 원격 접속 (Tailscale + 개발 gateway)`: (1) Mac: Tailscale 앱 로그인(메뉴 막대) 또는 `tailscale up`, `tailscale ip -4` 로 주소 확인; (2) `npm run build --workspaces --if-present && bash scripts/install-dev-gateway.sh`; (3) 폰: App Store 의 Tailscale 앱으로 같은 계정 로그인, 연결 켜기; (4) 앱 서버 주소 `http://<tailnet ip>:7777`; (5) 문제 해결: `--status`, 로그 `~/.mam/dev-gateway.log`, Tailscale 이 꺼져 있으면 gateway 가 시작 실패 후 10초마다 재시도, 회사 VPN 과 동시 사용 시 `100.64.0.0/10` 라우팅 확인. 보안 노트: 개발 모드는 접속자를 전부 본인으로 취급하므로 tailnet 에 다른 사람이 있으면 정식 설치(1절)를 쓴다.
- `README.md` 개발 빠른 시작에 "로그인 시 자동 시작: `bash scripts/install-dev-gateway.sh`" 한 줄.
- `docs/ARCHITECTURE.md` 4 런타임 경로 표에 LaunchAgent plist 경로.

## Acceptance Criteria

```bash
npm ci && npm run typecheck && npm test
bash scripts/install-dev-gateway.sh --dry-run | plutil -lint -
bash scripts/install-dev-gateway.sh --dry-run | grep -q "MAM_DEV_BIND"
bash scripts/test-install-dev-gateway.sh
grep -q "## 8. 원격 접속" docs/RUNBOOK.md
! lsof -nP -iTCP:7777 -sTCP:LISTEN
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 이 step 이 끝난 뒤 7777 을 듣는 프로세스가 없는가(설치를 실행하지 않았는가)?
   - plist 가 절대 경로만 쓰고 셸 문자열(`sh -c`)을 쓰지 않는가(CRITICAL 4)?
   - 정식 LaunchDaemon 설치 절차(RUNBOOK 1절)를 바꾸지 않았는가?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- `launchctl bootstrap/kickstart` 를 이 세션에서 실행하지 마라. 이유: 7777 점유로 이후 dev-smoke 가 깨지고, 설치는 사용자가 한다.
- `MAM_DEV_BIND=0.0.0.0` 을 기본으로 넣지 마라. 이유: 개발 모드가 모든 네트워크에 노출된다(확정: tailscale).
- 서버 코드(`packages/`)를 수정하지 마라. 필요하면 `needs_input`.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
