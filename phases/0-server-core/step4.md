# Step 4: agent-host-http

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/ARCHITECTURE.md` (2.2 agent-host, 6절 보안 모델)
- `/docs/PROTOCOL.md` (전체. REST 1절과 WS 2절이 이 step의 명세다)
- `/packages/protocol/src/` (스키마와 `parseClientMessage`)
- `/packages/server/src/sessions/manager.ts`, `/packages/server/src/agents/types.ts`, `/packages/server/src/agents/fake/` (step 2)
- `/packages/server/src/fs/`, `/packages/server/src/git/` (step 3)
- `/packages/server/src/errors.ts`

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

agent-host의 HTTP/WS 계층을 Fastify 5로 만든다. unix socket에서 listen하고, gateway가 붙인 신원 헤더를 검증하고, PROTOCOL의 REST 전부와 WS를 구현한다. 어댑터는 step 2의 Fake만 연결한다(실제 어댑터는 step 5, 6이 `adapters` 맵에 추가한다).

### 1. 앱 팩토리 `packages/server/src/agent-host/app.ts`

```ts
export interface AgentHostContext {
  user: string;              // os.userInfo().username 과 같아야 함
  email: string | null;
  home: string;              // realpath 된 홈
  workspaceRoot: string;     // 기본 `${home}/work`, 없으면 생성하지 않고 응답에만 표시
  manager: SessionManager;
  adapters: Partial<Record<AgentKind, AgentAdapter>>;   // probe 용
  serverVersion: string;
  logger?: FastifyBaseLogger;
}
export function buildApp(ctx: AgentHostContext): FastifyInstance;
```

- `onRequest` 훅: (a) `X-MAM-Protocol`이 있고 `1`이 아니면 426 `{error:{code:'invalid_request', message:'unsupported protocol version'}}`, (b) `X-MAM-User`가 없거나 `ctx.user`와 다르면 403. `/healthz`만 예외.
- 오류 핸들러: `MamError`는 `status`와 `code`로, zod 검증 실패는 400 `invalid_request`, 그 외 500 `internal`(메시지는 일반화, 상세는 로그). 응답은 항상 `{ error: { code, message } }`.
- 요청 본문/쿼리는 `@mam/protocol` zod 스키마로 파싱한다(Fastify JSON schema 대신 preHandler에서 `safeParse`). 응답도 개발 시 `NODE_ENV !== 'production'`이면 스키마로 검증해 어긋나면 500을 내라(계약 위반 조기 발견).

### 2. REST 라우트 `packages/server/src/agent-host/routes/`

PROTOCOL 1절 그대로. 특히:

- `me.ts`: `GET /api/v1/me`. `agents[]`는 각 어댑터의 `probe()` 결과. probe는 5초 캐시.
- `projects.ts`: `GET /api/v1/projects`. `workspaceRoot` 바로 아래 디렉토리(숨김 제외) + 매니저 세션들의 `cwd`를 합쳐 중복 제거. `isGitRepo`는 `findRepoRoot`.
- `sessions.ts`: list/create/get/patch/close + `POST /api/v1/sessions/:id/approvals/:approvalId`. `create`의 `cwd`는 `resolveInsideHome`을 거친 뒤 디렉토리인지 확인(403/400). `mode`가 `full-auto`면 그대로 허용하되 서버 기본값은 `ask`.
- `fs.ts`: `GET /api/v1/fs/list?path=`, `GET /api/v1/fs/read?path=`. `list`는 리포 안이면 `gitStatusMap`을 합친다. `unsupported_media` → 415.
- `git.ts`: `GET /api/v1/git/status?cwd=`, `GET /api/v1/git/diff?cwd=&path=&staged=`.
- `auth.ts`: `POST /api/v1/auth/:agent/login` 등 3개는 지금 501 `{error:{code:'internal', message:'login flow not available; use ssh'}}` 스텁. step 9가 교체한다.
- `GET /healthz` → `{ ok: true, user }`.

### 3. WebSocket `packages/server/src/agent-host/ws.ts`

`@fastify/websocket` 등록. `GET /api/v1/sessions/:id/ws?since=<seq>`:

1. 세션 없음 → 소켓을 close code 4004로 닫는다.
2. `manager.subscribe(id, since, listener)`로 구독. **`session.snapshot`을 먼저 보낸다**: `session`, `items`(since 이후 아이템 또는 최근 200개 + `truncated`), `pendingApprovals`, `replayFrom`. 그다음 재생 이벤트 → 라이브 이벤트 순. 스냅샷과 재생 사이에 새 이벤트가 끼어들어도 순서가 seq 순으로 유지되어야 한다(구독 → 스냅샷 생성 → 큐 flush 순서로 구현).
3. 클라이언트 메시지는 `parseClientMessage`로 파싱. 실패하면 `error{recoverable:true}` 이벤트(seq 0)로 응답하고 연결은 유지.
   - `turn.start` → `manager.startTurn`. `SessionBusyError`는 `error{message:'session is busy', recoverable:true}`.
   - `turn.interrupt`, `approval.respond`, `session.setMode` → 대응 매니저 메서드. 오류는 같은 방식.
   - `ping` → `pong`.
4. 소켓 종료 시 unsubscribe. 서버 측 30초 간격 ws ping으로 죽은 연결을 정리.
5. 한 세션에 여러 소켓이 동시에 붙을 수 있다. 각 소켓은 독립 구독자다.

### 4. 서버 시작 `packages/server/src/agent-host/server.ts`

```ts
export interface StartAgentHostOptions { socketPath: string; dataDir?: string; adapters?: ...; workspaceRoot?: string; email?: string | null; dev?: boolean }
export async function startAgentHost(opts): Promise<{ app: FastifyInstance; close(): Promise<void> }>;
```

- stale 소켓 파일은 unlink 후 listen. listen 후 `chmod 0600`.
- `dataDir` 기본 `~/.mam`. 디렉토리 없으면 0700으로 생성.
- 어댑터 기본값: 환경변수 `MAM_FAKE_AGENT=1`이면 `{ claude: new FakeAdapter(), codex: new FakeAdapter() }`, 아니면 빈 맵(step 5, 6이 실제 어댑터 등록 로직을 추가한다). 지금 단계에선 실제 어댑터가 없으므로 `create`는 `agent_unavailable`을 돌려준다.
- SIGTERM/SIGINT에 `manager.shutdown()` 후 종료.
- `cli.ts`에 `agent-host --socket <path> [--data-dir <dir>] [--workspace <dir>]` 서브커맨드를 commander로 추가한다(step 0의 임시 출력을 대체). 다른 서브커맨드는 step 7, 8이 추가한다.

### 5. 테스트 (`packages/server/test/agent-host/`)

- `app.inject`로 REST 전체: 신원 헤더 누락/불일치 403, 프로토콜 버전 426, `/me`의 agents 배열, 세션 생성→목록→상세→patch→close, `fs/list`·`fs/read`·`git/*`의 정상/403/404/415, 오류 응답 형태.
- WS: 임시 unix socket에 실제 listen하고 `ws` 클라이언트(`ws+unix:///tmp/x.sock:/api/v1/sessions/<id>/ws`)로 접속. 스냅샷 → `turn.start` → 델타/승인 요청 → `approval.respond` → `turn.completed` 순서와 seq 단조성. 두 클라이언트 동시 접속 시 양쪽 모두 수신. `since` 재접속 시 놓친 이벤트 재생. 잘못된 JSON → `error` 이벤트 후 연결 유지.
- 응답 스키마 검증(개발 모드)이 켜져 있어 계약 위반이 테스트에서 500으로 드러나는지 1개.

## Acceptance Criteria

```bash
npm ci
npm run typecheck
npm test
bash scripts/test.sh
# 수동 스모크: 임시 소켓으로 띄우고 curl
node packages/server/dist/cli.js agent-host --socket /tmp/mam-test.sock --data-dir /tmp/mam-test-data &
sleep 1; curl -s --unix-socket /tmp/mam-test.sock -H "X-MAM-User: $(whoami)" -H "X-MAM-Protocol: 1" http://localhost/api/v1/me | grep '"user"'
kill %1; rm -rf /tmp/mam-test.sock /tmp/mam-test-data
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 신원을 헤더 검증(`X-MAM-User === 프로세스 사용자`)으로만 받아들이고 요청 본문의 사용자 값을 쓰지 않는가(CRITICAL 1)?
   - 파일 경로가 전부 `resolveInsideHome`을 거치는가(CRITICAL 3)?
   - 모든 응답이 `docs/PROTOCOL.md`와 fixture 형태와 같은가?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- TCP 포트에 listen하는 코드를 넣지 마라(테스트 포함). 이유: agent-host는 unix socket 전용이며, TCP면 같은 Mac의 다른 사용자가 접근할 수 있다.
- 인증 우회 플래그(예: `--no-auth`)를 만들지 마라. 이유: 개발 모드에서도 gateway가 `X-MAM-User`를 붙인다.
- `SessionManager`나 `@mam/protocol` 내부 로직을 고치지 마라. 버그를 찾으면 summary에 적고 최소 수정만 하되 테스트를 추가하라.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
