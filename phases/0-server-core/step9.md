# Step 9: auth-login-flow

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/PRD.md` (F8)
- `/docs/PROTOCOL.md` (1절 "로그인 플로우")
- `/docs/ADR.md` (ADR-008)
- `/packages/server/src/agent-host/routes/auth.ts` (step 4의 501 스텁), `app.ts`
- `/packages/server/src/agents/claude/credentials.ts`, `adapter.ts` (step 5), `/packages/server/src/agents/resolve-bin.ts`
- `/packages/server/src/agents/codex/process.ts`, `jsonrpc.ts` (step 6), `generated/v2/LoginAccountParams.ts`, `LoginAccountResponse.ts`, `AccountLoginCompletedNotification.ts`

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

폰에서 Claude/Codex 로그인을 끝낼 수 있게 `POST /api/v1/auth/:agent/login` 3개 엔드포인트를 구현한다. 두 에이전트의 방식이 다르다.

### 0. 사전 관찰 (구현 전에 반드시)

`claude setup-token`의 실제 화면을 모른 채 파서를 쓰지 마라. `node-pty`로 짧은 관찰 스크립트를 만들어 10초 동안 출력을 캡처한 뒤 프로세스를 kill하라(OAuth 시작을 중단하는 것은 무해하다). 확인할 것: (1) URL이 출력되는지와 그 형태, (2) 코드 입력 프롬프트 문구, (3) 성공 시 토큰이 stdout에 찍히는지와 접두어(예상 `sk-ant-oat01-`), (4) 이미 로그인된 상태에서도 동작하는지. 관찰 결과를 `packages/server/src/agent-host/auth/README.md`에 적어라. `claude` 바이너리는 `resolveBinary('claude')`로 찾고, 없으면 SDK가 번들한 실행파일 경로(`@anthropic-ai/claude-agent-sdk` 패키지 안에서 찾을 수 있는지 확인)를 시도한다.

### 1. 플로우 레지스트리 `packages/server/src/agent-host/auth/flows.ts`

```ts
export type FlowStatus = 'pending' | 'done' | 'error';
export interface LoginFlow { id: string; agent: AgentKind; url: string; instructions: string; needsCode: boolean; status: FlowStatus; message?: string; submitCode?(code: string): Promise<void>; cancel(): void; createdAt: number }
export class FlowRegistry { start(agent, factory): Promise<LoginFlow>; get(id): LoginFlow | undefined; ttlMs = 15분; 에이전트당 동시 1개(기존 pending 이 있으면 cancel 후 교체) }
```

### 2. Claude `packages/server/src/agent-host/auth/claude-login.ts`

- `node-pty`로 `claude setup-token`을 띄운다(`cols: 200, rows: 50, env`에서 `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` 제거). pty 팩토리는 주입 가능(`ptySpawn?: typeof pty.spawn`).
- 출력에서 ANSI 시퀀스를 제거하고 첫 `https://` URL을 찾으면 flow를 `pending`/`needsCode: true`로 만든다. `instructions`: "링크를 열어 로그인한 뒤 표시되는 코드를 붙여넣으세요".
- `submitCode(code)`: `pty.write(code.trim() + '\r')`. 이후 출력에서 토큰(관찰한 접두어)을 찾으면 `~/.mam/secrets/claude-oauth-token`에 0600으로 저장(디렉토리 0700), `status: done`. 오류 문구(invalid/expired/error)가 보이면 `status: error` + 메시지. 10분 타임아웃.
- 토큰을 로그에 남기지 않는다. 출력 버퍼는 flow 종료 시 폐기한다.
- 저장 뒤 `ClaudeAdapter.probe()`가 `loggedIn: true, source: 'mam-token'`을 돌려주는지 확인(step 5의 `detectLogin`).

### 3. Codex `packages/server/src/agent-host/auth/codex-login.ts`

- step 6의 `spawnCodexAppServer`로 임시 프로세스를 띄워 `initialize`/`initialized` 후 `account/login/start { type: 'chatgptDeviceCode' }`를 요청한다. 응답 `{ loginId, verificationUrl, userCode }` → flow `{ url: verificationUrl, instructions: "링크를 열고 코드 <userCode> 를 입력하세요", needsCode: false }`.
- `account/login/completed` 알림(`loginId` 일치, `success`)을 기다려 `done`/`error`. 완료 후 프로세스 종료. 10분 타임아웃 시 `account/login/cancel { loginId }` 후 종료.
- 요청/응답 타입은 생성 바인딩(`LoginAccountParams`, `LoginAccountResponse`, `AccountLoginCompletedNotification`)을 import해 쓴다.

### 4. 라우트 교체 `routes/auth.ts`

- `POST /api/v1/auth/:agent/login` → 201 `LoginStartResponse`. 지원하지 않는 agent → 400. 플로우 시작 실패(바이너리 없음) → 501 `{error:{code:'agent_unavailable', message:'ssh 로 접속해 직접 로그인하세요: claude setup-token / codex login'}}`.
- `POST /api/v1/auth/:agent/login/:flowId/code` `{ code }` → `needsCode: false`인 플로우면 400. 없는/만료 플로우 404.
- `GET /api/v1/auth/:agent/login/:flowId` → `LoginStatusResponse`.
- 응답은 `@mam/protocol` 스키마로 검증(step 4의 개발 모드 검증이 적용됨).

### 5. 테스트 (`packages/server/test/agent-host/auth/`)

- Claude: 가짜 pty(EventEmitter + `write/kill` 스파이)로 관찰한 출력 시나리오 재생: URL 검출 → 코드 제출 → 토큰 저장(임시 홈) → done; 오류 문구 → error; 타임아웃(fake timers) → error + kill; 토큰이 로그 스파이에 나타나지 않음.
- Codex: 가짜 `spawnFn`/peer로 device code 응답과 completed 알림 → done; 실패 알림 → error; 타임아웃 → cancel 요청.
- 라우트: `app.inject`로 3개 엔드포인트, 400/404/501 경로, 동일 에이전트 재시작 시 이전 플로우 교체.

### 6. 실제 확인은 사람이 한다

실제 OAuth 완료는 사람의 브라우저가 필요하다. 이 step에서는 (0)의 관찰과 자동 테스트까지만 하고, 수동 확인 절차를 `docs/RUNBOOK.md`의 사용자 온보딩 절에 추가한다(개발 모드에서 `curl -X POST http://127.0.0.1:7777/api/v1/auth/claude/login` → URL 열기 → 코드 제출 → 상태 확인).

## Acceptance Criteria

```bash
npm ci
npm run typecheck
npm test
test -f packages/server/src/agent-host/auth/README.md      # setup-token 관찰 기록
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 토큰이 `~/.mam/secrets/`에 0600으로만 저장되고 로그에 없는가(CRITICAL 6)?
   - 자식 프로세스가 인자 배열 spawn/pty.spawn인가(CRITICAL 4)?
   - 응답이 `docs/PROTOCOL.md` 로그인 플로우 절과 fixture 형태인가?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`. 특히 `claude setup-token`이 pty에서 URL을 출력하지 않거나 코드 입력을 받지 않으면, Codex 쪽은 완성한 뒤 Claude 쪽을 501로 두고 관찰 결과를 `questions`에 담아 `needs_input`으로 보고하라.

## 금지사항

- 실제 로그인을 끝까지 자동으로 진행하려 하지 마라(브라우저 자동화 금지). 이유: 사용자 계정 인증은 사람이 한다.
- 이 머신의 기존 자격증명(`~/.claude`, `~/.codex/auth.json`)을 수정하거나 삭제하지 마라. 테스트는 임시 홈 디렉토리를 쓴다.
- API 키 입력 경로(`--with-api-key`, `type: 'apiKey'`)를 추가하지 마라. 이유: PRD 6절, ADR-008의 사용자별 구독 원칙.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
