# ARCHITECTURE: mac-agent-machine

## 1. 전체 그림

```
 iPhone (MacAgent 앱) ──HTTPS/WSS──┐
 브라우저 (웹 대시보드) ─HTTPS/WSS─┼─ tailnet ─▶ [Mac] gateway  (root LaunchDaemon, 443, tailscale cert)
 노트북 (ssh alice@mac) ───SSH─────┘                 │  1) 접속 IP → tailscale whois → 로그인 이메일
                                                     │  2) 이메일 → macOS 계정 (config users[])
                                                     │  3) 계정별 agent-host 프로세스 확보 (없으면 sudo -u 로 생성)
                                                     │  4) HTTP/WS 를 unix socket 으로 프록시
                                                     ▼
                                   agent-host (macOS 사용자 권한, 사용자당 1개, /var/run/mam/<user>/agent.sock)
                                   ├─ sessions/  SessionManager: 세션 레지스트리, 이벤트 로그(JSONL), 팬아웃, 유휴 종료
                                   ├─ agents/claude  Claude Agent SDK → claude CLI (사용자 ~/.claude 자격증명)
                                   ├─ agents/codex   codex app-server (JSON-RPC over stdio, 사용자 ~/.codex)
                                   ├─ fs/   홈 디렉토리로 제한된 파일 목록/읽기
                                   └─ git/  status/diff (git CLI 래핑)
```

설계 원칙은 sshd와 같다. root로 도는 코드는 최소(수락, 신원, 프로세스 생성, 프록시)이고, 실제 작업은 전부 해당 사용자 권한의 프로세스에서 일어난다.

## 2. 프로세스

### 2.1 gateway (`mam gateway`)

- LaunchDaemon `dev.mam.gateway`로 root 실행. `KeepAlive`.
- 바인딩: `tailscale ip -4`로 얻은 tailnet IP의 443(설정 가능). loopback이나 LAN IP에는 바인딩하지 않는다.
- TLS: `tailscale cert <magicdns-host>`가 발급한 인증서(`/etc/mam/tls/`). 만료 30일 전 재발급은 setup 스크립트가 등록하는 launchd 주기 작업이 담당한다.
- 신원: 접속 소켓의 원격 주소로 `tailscale whois --json <ip>`를 실행해 `UserProfile.LoginName`을 얻는다. 결과는 60초 캐시. 태그 노드(사용자 없음)나 조회 실패는 403.
- 매핑: `config.users[]`에서 이메일 → `macUser`. 매핑 없으면 403.
- 감독(supervisor): 사용자별 agent-host 프로세스를 lazy하게 만든다. 생성 명령은 `/usr/bin/sudo -u <user> -H -n -- <node> <mam cli> agent-host --socket /var/run/mam/<user>/agent.sock`. 소켓 디렉토리는 gateway가 만들고 `chown user`, 모드 0700. 크래시 시 백오프 재시작. 마지막 요청 후 `agentHost.idleTimeoutMinutes`(기본 30) 동안 요청이 없고 라이브 세션이 없으면 종료.
- 프록시: `node:http`의 `request({ socketPath })`로 HTTP를, `upgrade` 이벤트에서 `net.connect(socketPath)`로 WebSocket을 바이트 단위로 양방향 파이프한다. 프록시 라이브러리를 쓰지 않는다. 업스트림 요청에 `X-MAM-User: <macUser>`, `X-MAM-Email`을 붙인다. 클라이언트가 보낸 같은 이름의 헤더는 제거한다.
- 정적 파일: Phase 2부터 `apps/web/dist`를 `/`에서 서빙한다. `/api/*`와 `/ws`만 프록시한다.
- 개발 모드 `mam gateway --dev`: `http://127.0.0.1:7777`, TLS 없음, 신원은 `MAM_DEV_USER`(기본 현재 사용자), agent-host를 현재 사용자로 직접 spawn, 소켓은 `$TMPDIR/mam-dev/agent.sock`. 하네스 AC와 시뮬레이터 테스트가 이 모드를 쓴다.

### 2.2 agent-host (`mam agent-host --socket <path>`)

- 해당 macOS 사용자 권한으로 실행. Fastify 5가 unix socket에서 listen. `@fastify/websocket`으로 WS.
- 모든 요청의 `X-MAM-User`가 자기 프로세스의 사용자(`os.userInfo().username`)와 같아야 한다. 다르면 403. gateway 외에는 소켓에 접근할 수 없지만 방어를 겹친다.
- 시작 시 사용자의 로그인 셸로 도구 경로를 확인한다: `$SHELL -lc 'command -v claude; command -v codex'`. 환경변수 `MAM_CLAUDE_BIN`, `MAM_CODEX_BIN`이 있으면 우선한다. 결과는 `GET /me`의 `agents[]`에 반영한다.
- 데이터 디렉토리 `~/.mam/`: `sessions/<id>.json`(메타), `sessions/<id>.events.jsonl`(정규화 이벤트, seq 순), `agent-host.log`, `prefs.json`.

### 2.3 에이전트 어댑터

공통 인터페이스(`packages/server/src/agents/types.ts`):

```ts
interface AgentAdapter {
  readonly kind: 'claude' | 'codex';
  probe(): Promise<AgentProbe>;                       // available, version, loggedIn, account
  start(opts: StartOptions): Promise<AgentSession>;   // cwd, mode, model?, resumeNativeId?
}
interface AgentSession {
  readonly nativeId: string | undefined;              // claude session id / codex thread id
  readonly events: AsyncIterable<AgentEvent>;         // 정규화 이벤트 (PROTOCOL.md 의 item/approval/status)
  sendTurn(input: TurnInput): Promise<void>;
  interrupt(): Promise<void>;
  respondApproval(approvalId: string, optionId: string, inputs?: Record<string, string>): Promise<void>;
  setMode(mode: SessionMode): Promise<void>;
  close(): Promise<void>;
}
```

- Claude: `@anthropic-ai/claude-agent-sdk`의 `query({ prompt: AsyncIterable<SDKUserMessage>, options })`. 스트리밍 입력 모드로 프로세스 하나를 세션 수명 동안 유지한다. `canUseTool` 콜백이 승인 요청을 만들고, 앱 응답이 올 때까지 Promise를 보류한다. `includePartialMessages: true`로 텍스트 델타를 받는다. `resume`으로 재개, `interrupt()`, `setPermissionMode()`.
- Codex: `codex app-server`를 자식 프로세스로 띄우고 stdin/stdout으로 줄 단위 JSON-RPC를 주고받는다. `initialize` → `initialized` → `thread/start` 또는 `thread/resume` → `turn/start`. 서버 요청(`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput`)이 승인 요청이 되고, 응답은 같은 `id`로 돌려준다. 알림(`item/started`, `item/agentMessage/delta`, `item/completed`, `turn/completed` 등)이 타임라인 이벤트가 된다.
- Fake: 테스트용. 스크립트된 이벤트를 재생하고 승인 요청을 만든다. SessionManager, HTTP, WS, iOS 계약 테스트가 이것을 쓴다.

### 2.4 SessionManager

- 세션 = `{ id, agent, cwd, title, mode, status, nativeId, createdAt, updatedAt, lastSeq }`.
- 어댑터 이벤트에 단조 증가 `seq`를 붙여 (1) 메모리 링버퍼(최근 500개), (2) `events.jsonl`에 append, (3) 접속 중인 모든 WS 클라이언트에 팬아웃한다.
- WS 접속 시 `since` 이후 이벤트를 링버퍼 또는 파일에서 재생한 뒤 라이브로 전환한다.
- 승인 요청은 `pendingApprovals` 맵에 보관한다. 클라이언트가 응답하면 어댑터로 전달하고 `approval.resolved`를 브로드캐스트한다. 여러 클라이언트가 동시에 응답하면 첫 응답만 유효하다.
- 상태 기계: `starting → idle ⇄ running → waiting_approval → running → idle`, 어디서든 `error`, `closed`.
- 유휴 종료: 마지막 이벤트 후 `idleTimeoutMinutes`가 지나고 WS 클라이언트가 없으면 어댑터 세션을 닫고 상태를 `idle`(재개 가능)로 둔다. 다음 turn.start가 오면 `resumeNativeId`로 다시 연다.

## 3. 저장소 구조

```
mac-agent-machine/
├── CLAUDE.md
├── package.json                 # npm workspaces: packages/*, apps/*
├── tsconfig.base.json
├── docs/                        # PRD, ARCHITECTURE, PROTOCOL, ADR, RUNBOOK(step 산출)
├── packages/
│   ├── protocol/                # @mam/protocol — zod 스키마 + 타입 + fixtures/*.json
│   │   ├── src/index.ts
│   │   ├── fixtures/            # REST 응답·WS 이벤트 예시. TS 와 Swift 양쪽 계약 테스트가 읽는다
│   │   └── test/
│   └── server/                  # @mam/server — bin: mam
│       ├── src/cli.ts           # mam gateway | agent-host | user add|list|remove | doctor
│       ├── src/config.ts        # /etc/mam/config.json 로드·zod 검증
│       ├── src/gateway/         # server.ts identity.ts users.ts supervisor.ts proxy.ts tls.ts
│       ├── src/agent-host/      # app.ts routes/{me,sessions,fs,git,auth}.ts ws.ts
│       ├── src/sessions/        # manager.ts event-log.ts types.ts
│       ├── src/agents/          # types.ts fake/ claude/ codex/
│       ├── src/fs/              # sandbox.ts list.ts read.ts language.ts
│       ├── src/git/             # status.ts diff.ts
│       └── test/                # vitest. 통합 테스트는 MAM_IT_CLAUDE=1 / MAM_IT_CODEX=1 일 때만
├── apps/
│   └── web/                     # Phase 2. Vite + React + TS. @mam/protocol 재사용
├── ios/
│   ├── project.yml              # XcodeGen. 커밋 대상. *.xcodeproj 는 생성물이라 gitignore
│   ├── MacAgent/                # App/ Models/ Networking/ Features/{Connect,Sessions,Timeline,Approvals,Files,Settings}/ Shared/
│   └── MacAgentTests/           # 모델 디코딩(fixtures), 클라이언트 로직
├── scripts/
│   ├── execute.py               # 하네스 실행기
│   ├── test.sh                  # 전체 테스트 (Stop 훅 게이트)
│   ├── setup-server.sh          # 관리자: 서버 1회 설치 (멱등)
│   ├── add-user.sh              # 관리자: 사용자 추가 (mam user add 가 내부 호출)
│   ├── dev-smoke.sh             # 개발 모드 gateway + fake 어댑터 end-to-end
│   └── launchd/dev.mam.gateway.plist
└── phases/                      # 하네스 phase/step
```

## 4. 런타임 경로

| 경로 | 소유 | 용도 |
|---|---|---|
| `/opt/mam/` | root | 설치된 저장소 사본 (`npm ci && npm run build` 완료 상태) |
| `/etc/mam/config.json` | root, 0644 | 서버 설정 |
| `/etc/mam/tls/cert.pem`, `key.pem` | root, 0600 | `tailscale cert` 산출물 |
| `/var/run/mam/<user>/agent.sock` | user, dir 0700 | gateway ↔ agent-host |
| `/var/log/mam/gateway.log` | root | gateway 로그 (launchd StandardOut/ErrorPath) |
| `~/.mam/` | user | 세션 메타, 이벤트 로그, agent-host 로그 |
| `~/work/` | user | 기본 워크스페이스 루트 (설정 가능) |

## 5. 설정 (`/etc/mam/config.json`)

```json
{
  "port": 443,
  "bind": "tailscale",
  "hostname": "macmini.tail1234.ts.net",
  "tls": { "cert": "/etc/mam/tls/cert.pem", "key": "/etc/mam/tls/key.pem" },
  "users": [
    { "macUser": "alice", "email": "alice@example.com", "workspaceRoot": "~/work" }
  ],
  "agentHost": { "idleTimeoutMinutes": 30 },
  "paths": { "node": "/opt/homebrew/bin/node", "mamCli": "/opt/mam/packages/server/dist/cli.js" }
}
```

`bind`는 `"tailscale"` 또는 `"127.0.0.1"`(개발). 스키마는 `packages/server/src/config.ts`의 zod가 단일 진실이다.

## 6. 보안 모델

- 네트워크 경계는 Tailscale이다. gateway는 tailnet IP에만 바인딩하고, whois가 실패하는 피어는 거부한다.
- 신원은 전송 계층(WireGuard 피어)에서 나온다. 클라이언트가 보내는 어떤 헤더도 신원으로 신뢰하지 않는다. `X-MAM-*` 헤더는 gateway가 덮어쓴다.
- 권한 분리: gateway(root)는 사용자 데이터를 읽지 않는다. 파일·git·에이전트는 전부 agent-host(사용자 권한)가 처리한다.
- 파일 샌드박스: 요청 경로를 `realpath`로 해석한 뒤 사용자 홈 아래인지 확인한다. 심볼릭 링크로 홈 밖을 가리키면 거부한다. `..`는 해석 후 검사하므로 별도 처리하지 않는다.
- 셸 실행 금지: 서버 코드는 사용자 입력 문자열을 셸에 넘기지 않는다. 자식 프로세스는 항상 인자 배열로 spawn한다. git도 `spawn('git', [...])`.
- 로그에 토큰, 승인 요청 본문의 비밀값, 파일 내용을 남기지 않는다.
- SSH: setup 스크립트가 `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `PermitRootLogin no`를 `/etc/ssh/sshd_config.d/mam.conf`에 쓴다. macOS 방화벽에서 sshd는 tailnet 인터페이스만 허용하도록 안내한다.

## 7. 데이터 흐름 예시: 권한 요청

1. Claude가 `Bash(npm test)`를 실행하려 한다. SDK가 `canUseTool('Bash', {command:'npm test'}, {suggestions, ...})`를 호출한다.
2. Claude 어댑터가 `approval` 아이템과 `approval.requested` 이벤트를 만든다. 콜백은 Promise를 반환하고 보류된다.
3. SessionManager가 seq를 붙여 로그에 쓰고 모든 WS 클라이언트에 보낸다. 세션 상태는 `waiting_approval`.
4. iPhone 앱이 승인 시트를 띄운다. 사용자가 "이 세션에서 항상 허용"을 누른다. 앱은 `approval.respond { approvalId, optionId: 'allow_session' }`을 보낸다.
5. SessionManager가 첫 응답을 채택해 어댑터에 전달한다. 어댑터는 `{ behavior: 'allow', updatedPermissions: suggestions }`로 Promise를 resolve한다.
6. `approval.resolved`가 브로드캐스트되고, 웹 대시보드에서도 시트가 닫힌다. 상태는 `running`.

## 8. 테스트 전략

- 단위: vitest. 어댑터는 SDK/프로세스를 주입 가능하게 만들어 가짜로 대체한다.
- 계약: `packages/protocol/fixtures/*.json`을 TS zod 스키마와 Swift Codable 양쪽이 디코딩한다. 프로토콜을 바꾸면 fixture를 먼저 바꾼다.
- 통합: `MAM_IT_CLAUDE=1`, `MAM_IT_CODEX=1`일 때만 실제 CLI를 띄우는 테스트를 돌린다. 하네스 게이트에서는 꺼져 있다.
- e2e: `scripts/dev-smoke.sh`가 개발 모드 gateway를 띄우고 fake 어댑터 세션에 대해 REST → WS → 승인 응답까지 확인한다.
- iOS: `xcodebuild test -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro'`. UI 테스트는 최소화하고 모델·클라이언트 로직을 XCTest로 검증한다.
- 게이트: `scripts/test.sh`가 TS 워크스페이스 테스트를 항상 돌리고, `ios/project.yml`이 있으면 iOS 빌드+테스트도 돌린다. `MAM_TEST_SKIP_IOS=1`로 건너뛸 수 있다.
