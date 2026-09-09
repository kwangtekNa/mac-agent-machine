# Step 7: gateway

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md` (CRITICAL 1, 2, 4)
- `/docs/ARCHITECTURE.md` (1절, 2.1 gateway, 4절 런타임 경로, 5절 설정, 6절 보안 모델)
- `/docs/ADR.md` (ADR-001, 002, 003, 004, 011)
- `/packages/server/src/agent-host/server.ts`, `app.ts` (step 4. gateway가 프록시할 대상)
- `/packages/server/src/cli.ts`, `/packages/server/src/errors.ts`

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

root로 도는 gateway를 만든다. 역할은 넷뿐이다: 접속 수락(HTTPS), 신원 확정(tailscale whois), 사용자별 agent-host 프로세스 확보, unix socket으로 프록시. 이 디렉토리(`src/gateway/`) 밖의 코드는 root를 가정하지 않는다.

### 1. 설정 `packages/server/src/config.ts`

`docs/ARCHITECTURE.md` 5절의 JSON을 zod 스키마 `ConfigSchema`로 정의한다. 기본값: `port 443`, `bind 'tailscale'`, `agentHost.idleTimeoutMinutes 30`, `paths.node`는 `process.execPath`, `paths.mamCli`는 현재 실행 중인 cli.js 경로. `loadConfig(path = process.env.MAM_CONFIG ?? '/etc/mam/config.json')`, `devConfig(overrides?)`(port 7777, bind `127.0.0.1`, users에 현재 사용자 1명 `email: <user>@dev.local`, tls 없음). `users[].email`은 소문자로 정규화. `workspaceRoot`의 `~`는 agent-host가 치환하므로 여기선 그대로 둔다.

### 2. 신원 `packages/server/src/gateway/identity.ts`

```ts
export interface Identity { email: string; displayName?: string; node?: string }
export interface IdentityResolver { resolve(remoteAddress: string): Promise<Identity | null> }
export class TailscaleIdentityResolver implements IdentityResolver {
  constructor(opts?: { exec?: (bin: string, args: string[]) => Promise<{ stdout: string; code: number }>; tailscaleBin?: string; ttlMs?: number; now?: () => number });
}
export class StaticIdentityResolver implements IdentityResolver { constructor(identity: Identity) }   // 개발 모드
export function findTailscaleBin(): string | null;   // /opt/homebrew/bin, /usr/local/bin, /Applications/Tailscale.app/Contents/MacOS/Tailscale, PATH
```

- `tailscale whois --json <ip>`를 실행해 `UserProfile.LoginName`을 email로. IPv4-mapped IPv6(`::ffff:100.x.y.z`)와 IPv6 zone(`%utun3`)을 정규화한다. `Node.Tags`가 있고 `UserProfile`이 없으면(태그 노드) null. 종료 코드 0이 아니면 null. 결과(null 포함)를 `ttlMs`(기본 60초) 캐시.

### 3. 사용자 디렉토리 `packages/server/src/gateway/users.ts`

`UserDirectory(config.users)`: `byEmail(email): UserEntry | null`(대소문자 무시), `list()`. `UserEntry = { macUser, email, workspaceRoot }`.

### 4. 감독 `packages/server/src/gateway/supervisor.ts`

```ts
export interface SupervisorOptions {
  config: Config; dev: boolean;
  spawnFn?: typeof spawn;                       // 테스트 주입
  socketRoot?: string;                          // 기본 prod '/var/run/mam', dev `${os.tmpdir()}/mam-dev`
  readyTimeoutMs?: number; now?; setTimeoutFn?;  // 테스트 주입
  logger?;
}
export class AgentHostSupervisor {
  ensure(user: UserEntry): Promise<{ socketPath: string }>;   // 없으면 spawn 후 소켓 준비까지 대기
  noteActivity(macUser: string): void;                        // 마지막 요청 시각 갱신
  trackConnection(macUser: string): () => void;               // 활성 WS 수 증감 (해제 함수 반환)
  status(): Array<{ macUser: string; pid?: number; state: 'starting'|'ready'|'backoff'|'stopped'; restarts: number }>;
  shutdown(): Promise<void>;                                   // 전부 SIGTERM, 5초 후 SIGKILL
}
```

- prod 생성 명령: `/usr/bin/sudo -u <macUser> -H -n -- <config.paths.node> <config.paths.mamCli> agent-host --socket <socketRoot>/<macUser>/agent.sock --workspace <workspaceRoot> --email <email>`. 소켓 디렉토리는 먼저 `mkdir -p` 후 `chown <uid>:<gid>`(uid/gid는 `spawn('id', ['-u', macUser])`/`['-g', ...]`) + `chmod 0700`. 환경변수는 최소만 넘긴다(`PATH`는 `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`, `MAM_*` 접두어 변수는 통과).
- dev 생성 명령: 같은 인자로 `<node> <mamCli>`를 직접 spawn(현재 사용자). `MAM_FAKE_AGENT` 등 `MAM_*` 환경변수 통과.
- 준비 대기: `net.connect(socketPath)` 성공까지 100ms 간격 재시도, `readyTimeoutMs`(기본 15초) 초과 시 실패(프로세스 kill).
- 크래시 시 백오프 1s, 2s, 4s … 최대 30s. 다음 `ensure`가 재시작을 트리거한다(백오프 중이면 503 `agent_unavailable`을 gateway가 돌려줄 수 있도록 `SupervisorBackoffError`).
- 유휴 종료: 마지막 활동 후 `idleTimeoutMinutes` 경과 && 활성 연결 0 → SIGTERM. 1분 간격 스윕.
- 자식의 stdout/stderr는 gateway 로그로 프리픽스(`[agent-host:<user>]`)를 붙여 흘린다.

### 5. 프록시 `packages/server/src/gateway/proxy.ts`

라이브러리 없이 `node:http`/`node:net`으로 구현한다.

```ts
export interface ProxyTarget { socketPath: string; user: UserEntry; identity: Identity }
export function proxyHttp(req: IncomingMessage, res: ServerResponse, target: ProxyTarget): void;
export function proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, target: ProxyTarget, onClose: () => void): void;
```

- 요청 헤더에서 `x-mam-*` 전부 제거 후 `x-mam-user: <macUser>`, `x-mam-email: <email>`, `x-forwarded-for: <remoteAddress>`, `x-forwarded-proto`를 설정한다. hop-by-hop 헤더(`connection`, `keep-alive`, `transfer-encoding` 등)는 HTTP 프록시에서 제거하되, upgrade 경로에서는 `connection: Upgrade`, `upgrade: websocket`, `sec-websocket-*`를 그대로 넘긴다.
- HTTP: `http.request({ socketPath, method, path, headers })`, 요청 본문 pipe, 응답 상태·헤더·본문 pipe. 업스트림 오류 → 502 `{error:{code:'agent_unavailable', message}}`.
- Upgrade: `net.connect(socketPath)` → 요청 라인과 정제된 헤더를 직접 써서 보낸 뒤 `head`를 쓰고 양방향 `pipe`. 업스트림 101이 아닌 응답은 그대로 클라이언트에 전달하고 닫는다. 연결 오류 시 `HTTP/1.1 502 Bad Gateway\r\n\r\n` 후 destroy. 양쪽 어느 쪽이 닫혀도 반대쪽을 정리하고 `onClose`를 정확히 한 번 호출한다.

### 6. TLS·주소 `packages/server/src/gateway/tls.ts`

`loadTls(config.tls)` → `{ cert, key }` 버퍼. `tailscaleIPv4(exec)` → `tailscale ip -4` 첫 줄. `bind: 'tailscale'`인데 IP를 못 얻으면 시작 실패(명확한 메시지: "tailscale이 실행 중인지 확인").

### 7. 서버 `packages/server/src/gateway/server.ts`

```ts
export interface GatewayDeps { config: Config; identity: IdentityResolver; users: UserDirectory; supervisor: AgentHostSupervisor; dev: boolean; logger? }
export async function startGateway(deps: GatewayDeps): Promise<{ address: { host: string; port: number }; close(): Promise<void> }>;
```

- prod: `https.createServer(tls)`, host = tailnet IPv4. dev: `http.createServer`, host `127.0.0.1`.
- `request` 핸들러: `GET /healthz` → `{ ok: true, version }`(신원 불필요). 그 외 경로가 `/api/`로 시작하지 않으면 지금은 200 `text/plain` `mac-agent-machine gateway`(Phase 2가 정적 서빙으로 교체). `/api/*`: `identity.resolve(req.socket.remoteAddress)` → null이면 403 `{error:{code:'forbidden', message:'unknown tailnet identity'}}` → `users.byEmail` → null이면 403 `'no account mapped for <email>'` → `supervisor.ensure(user)` → `proxyHttp`. 오류 응답은 PROTOCOL 0절 형태.
- `upgrade` 핸들러: 같은 파이프라인 후 `proxyUpgrade`. `supervisor.trackConnection`으로 활성 연결 집계.
- 모든 요청에 `supervisor.noteActivity`. 요청 로그 한 줄(method, path, user, status, ms). 본문·헤더 값은 로그 금지.
- SIGTERM/SIGINT → `close()`(서버 close + `supervisor.shutdown()`).

### 8. CLI

`cli.ts`에 `gateway [--dev] [--config <path>]` 추가. `--dev`면 `devConfig()` + `StaticIdentityResolver({ email: 'dev@dev.local' 대신 devConfig users[0].email })`. prod면 root가 아닐 때 즉시 종료(메시지). 시작 시 바인딩 주소를 한 줄 출력.

### 9. 테스트 (`packages/server/test/gateway/`)

- identity: whois JSON 샘플(사용자 노드/태그 노드/실패)과 캐시 TTL, 주소 정규화.
- users: 대소문자 무시 매핑.
- supervisor: 주입한 `spawnFn`으로 prod 인자(`sudo -u ... -H -n -- ...`)와 dev 인자 검증, 준비 대기 성공/타임아웃, 크래시 백오프(fake timers), 유휴 종료, shutdown.
- proxy + server(dev 모드 통합): 임시 unix socket에 step 4의 실제 agent-host(`MAM_FAKE_AGENT=1`, `startAgentHost`)를 띄우고, 가짜 supervisor가 그 소켓을 돌려주게 해서 `startGateway`로 HTTP(`/api/v1/me` → user 일치, `x-mam-*` 위조 헤더가 덮어써짐)와 WS(`/api/v1/sessions/:id/ws` 스냅샷 수신)를 확인. 신원 null → 403, 매핑 없음 → 403, 소켓 없음 → 502, `/healthz` 무인증.

## Acceptance Criteria

```bash
npm ci
npm run typecheck
npm test
bash scripts/test.sh
# 개발 모드 end-to-end (실제 agent-host 자식 프로세스 생성)
MAM_FAKE_AGENT=1 node packages/server/dist/cli.js gateway --dev &
sleep 2
curl -sf http://127.0.0.1:7777/healthz
curl -sf -H "X-MAM-Protocol: 1" -H "X-MAM-User: someone-else" http://127.0.0.1:7777/api/v1/me | grep "\"user\":\"$(whoami)\""   # 위조 헤더 무시
kill %1; sleep 1; pgrep -f "agent-host --socket" && exit 1 || true    # 자식이 정리됨
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - gateway가 사용자 파일을 읽거나 에이전트를 직접 실행하지 않는가(CRITICAL 2)?
   - 클라이언트 헤더를 신원으로 쓰지 않고 `x-mam-*`를 덮어쓰는가(CRITICAL 1)?
   - 프록시 라이브러리 없이 `node:http`/`node:net`만 썼는가(ADR-004)? 셸 문자열 실행이 없는가(CRITICAL 4)?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- `0.0.0.0`이나 LAN IP에 바인딩하지 마라. 이유: ADR-001/004. tailnet IP 또는 loopback(dev)만.
- `tailscale serve`/`funnel`을 쓰지 마라. 이유: ADR-003의 로컬 헤더 위조 문제.
- 실제 `sudo`나 `/var/run/mam`을 테스트에서 건드리지 마라. 이유: 하네스 세션은 root가 아니다. 테스트는 주입한 `spawnFn`과 임시 디렉토리만 쓴다.
- `http-proxy`, `@fastify/http-proxy` 같은 의존성을 추가하지 마라.
- agent-host 코드(`src/agent-host/`)를 수정하지 마라. 필요하면 최소 수정 후 summary에 적어라.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
