# Step 6: codex-adapter

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/ARCHITECTURE.md` (2.3 에이전트 어댑터)
- `/docs/PROTOCOL.md` (3절, 4절 모드 매핑, 5절 "Codex app-server → TimelineItem")
- `/docs/ADR.md` (ADR-007)
- `/packages/server/src/agents/types.ts`, `/packages/server/src/agents/fake/`, `/packages/server/src/ids.ts` (step 2)
- `/packages/server/src/agents/resolve-bin.ts` (step 5)
- `/packages/server/src/agents/claude/adapter.ts`, `mapping.ts` (step 5. 같은 구조로 만든다)

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

`codex app-server`(이 머신의 codex-cli 0.153.4)를 자식 프로세스로 띄우고 stdio 줄 단위 JSON-RPC로 구동하는 `AgentAdapter`를 만든다.

### 0. 프로토콜 바인딩 생성

```bash
codex app-server generate-ts --out packages/server/src/agents/codex/generated
```

- 약 700개 `.ts` 파일이 생긴다. **커밋 대상이다**(ADR-007: experimental API를 버전 고정). `generated/README.md`에 생성 명령과 codex 버전(`codex --version`)을 적어라.
- 생성물은 타입 전용이다. `tsc`가 이 디렉토리를 문제없이 통과해야 한다. 오류가 나면 `tsconfig`에서 이 디렉토리만 `skipLibCheck`성 완화를 하지 말고, 실제 원인(예: `bigint` 타깃)을 base 설정에서 해결하라.
- 사전 조사로 확인된 사실(그대로 믿지 말고 생성물에서 재확인): 요청/응답/알림/서버요청 유니온은 `generated/ClientRequest.ts`, `ServerNotification.ts`, `ServerRequest.ts`. v2 파라미터는 `generated/v2/` 아래(`ThreadStartParams`, `ThreadResumeParams`, `TurnStartParams`, `TurnInterruptParams`, `ItemStartedNotification`, `ItemCompletedNotification`, `AgentMessageDeltaNotification`, `TurnCompletedNotification`, `ThreadItem`, `UserInput`, `AskForApproval`(`untrusted | on-request | never | granular`), `SandboxMode`, `SandboxPolicy`, `CommandExecutionRequestApprovalParams/Response`(`decision: accept | acceptForSession | decline | cancel`), `FileChangeRequestApprovalParams/Response`, `PermissionsRequestApprovalParams/Response`(`{ permissions, scope }`), `ToolRequestUserInputParams/Response`(`{ answers }`), `LoginAccountParams/Response`).
- 스트림 형식: 한 줄에 JSON 하나. 요청 `{id, method, params}`, 응답 `{id, result}` 또는 `{id, error}`, 알림 `{method, params, emittedAtMs?}`, 서버→클라이언트 요청 `{id, method, params}`(같은 `id`로 `{id, result}` 응답). `initialize` 응답 뒤에 `initialized` 알림을 보내야 한다.

### 1. JSON-RPC 피어 `packages/server/src/agents/codex/jsonrpc.ts`

```ts
export class JsonRpcPeer {
  constructor(input: Readable, output: Writable, opts?: { logger?; requestTimeoutMs?: number });
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;   // 응답 error 는 JsonRpcError 로 reject
  notify(method: string, params?: unknown): void;
  onNotification(handler: (method: string, params: unknown) => void): () => void;
  onRequest(handler: (method: string, params: unknown) => Promise<unknown>): void;         // 반환값을 {id, result} 로, throw 는 {id, error:{code:-32000,message}} 로 회신
  close(): void;   // 대기 중 요청 전부 reject
}
```

줄 분리는 `\n` 기준, 부분 청크 버퍼링, 잘못된 JSON 줄은 경고 후 무시.

### 2. 프로세스 `packages/server/src/agents/codex/process.ts`

`spawnCodexAppServer({ binPath, cwd, env, logger })` → `{ peer, child, kill(graceful = true) }`. `spawn(binPath, ['app-server'], { cwd, env, stdio: ['pipe','pipe','pipe'] })`. stderr는 줄 단위 로그. `kill`은 stdin end → 2초 후 SIGTERM → 2초 후 SIGKILL.

### 3. 어댑터 `packages/server/src/agents/codex/adapter.ts`

```ts
export interface CodexAdapterOptions {
  spawnFn?: typeof spawnCodexAppServer;   // 테스트 주입
  binPath?: string;                        // 기본 MAM_CODEX_BIN → resolveBinary('codex')
  home?: string;
  logger?;
}
```

- `probe()`: `available` = binPath 존재. `version` = `<bin> --version`. `loggedIn` = `~/.codex/auth.json` 존재. `account`: auth.json의 `tokens.id_token`이 JWT면 payload의 `email`을 검증 없이 디코드(실패 시 null).
- `start(opts)`: spawn → `initialize({ clientInfo: { name:'mam', title:'mac-agent-machine', version: SERVER_VERSION }, capabilities: {} })` → `notify('initialized')` → `resumeNativeId`가 있으면 `thread/resume { threadId, cwd, approvalPolicy, sandbox }` 아니면 `thread/start { cwd, approvalPolicy, sandbox, model? }`. 응답에서 thread id를 읽어 `native_id` + `status idle`. 모드→(`approvalPolicy`, `sandbox`) 매핑은 PROTOCOL 4절.
- `sendTurn(input)`: `turn/start { threadId, input: [{ type:'text', text, text_elements: [] }, ...이미지는 UserInput의 image 형태], cwd, approvalPolicy, sandboxPolicy }`. `SandboxPolicy`는 `SandboxMode`와 다른 타입이다. 생성물에서 형태를 확인해 `workspace-write`면 `writable_roots`에 cwd를 넣는 식으로 정확히 만든다. `turn/started` 알림에서 `turn.id`를 현재 `turnId`로 삼는다(PROTOCOL의 `trn_` 접두어 대신 Codex turn id를 그대로 써도 된다. 이유: 재개 시 일관성).
- `interrupt()` → `turn/interrupt { threadId, turnId }`. `setMode()` → 저장 후 다음 `turn/start`에 반영(+ 가능하면 즉시 적용되는 요청이 생성물에 있는지 확인). `close()` → 대기 승인 전부 `cancel`로 회신, `kill()`.
- 프로세스가 예기치 않게 종료되면 `error{recoverable:false}` 후 events 종료.

### 4. 매핑 `packages/server/src/agents/codex/mapping.ts`

`CodexEventMapper`: 알림·서버요청 → `AgentEvent[]`. PROTOCOL 5절 표를 따르고 아래를 보강한다:

- `item/started`/`item/completed`의 `item.type`별: `agentMessage`→assistant_message(`phase` 매핑: `final_answer`→final, 그 외 commentary), `reasoning`→reasoning(`summary` 합침), `commandExecution`→tool_call(bash, title=command, output=aggregatedOutput, exitCode), `fileChange`→file_change(`changes[]`에서 path/kind/patch 추출), `mcpToolCall`→tool_call(mcp, name=`server/tool`), `webSearch`→tool_call(web), `plan`→plan(텍스트를 줄 단위 steps로), `userMessage`→user_message, 그 외→tool_call(other). `status`는 Codex 상태 → `running|completed|failed`.
- 델타: `item/agentMessage/delta`→text, `item/commandExecution/outputDelta`→output, `item/reasoning/textDelta`·`summaryTextDelta`→text, `item/fileChange/patchUpdated`→patch(전체 교체가 아니라 append인지 생성물 주석으로 확인), `item/plan/delta`→text.
- `turn/started`→status running. `turn/completed`→turn_summary + `turn.completed`(usage는 `thread/tokenUsage/updated`에서 누적한 값, `stopReason`은 turn status) + status idle. `error` 알림(있으면)→error item.
- 서버 요청 → Approval:
  - `item/commandExecution/requestApproval` → `kind: command`, title=command, detail=cwd + reason, options allow/allow_session/deny, 응답 `{ decision }`: allow→`accept`, allow_session→`acceptForSession`, deny→`decline`, abort→`cancel`.
  - `item/fileChange/requestApproval` → `kind: file_change`, `diff`는 같은 itemId의 fileChange 아이템에서 모은 패치, 응답 `{ decision }` 동일 매핑.
  - `item/permissions/requestApproval` → `kind: permission`, detail=요청 권한 JSON, 응답 allow/allow_session→`{ permissions: <요청된 프로필을 허용 형태로>, scope: 턴|세션 }`(정확한 타입은 생성물 확인), deny→거절을 표현하는 값이 있으면 그것, 없으면 빈 권한 + 턴 스코프.
  - `item/tool/requestUserInput` → `kind: user_input`, `inputFields`는 `questions[]`(id, 질문 텍스트, 선택지가 있으면 `choice`), options `submit`/`cancel`, 응답 `{ answers: { [questionId]: { answers: [값] } } }`(형태는 생성물 확인).
  - 구형 `execCommandApproval`/`applyPatchApproval`이 오면 `ReviewDecision`(`approved | approved_for_session | {denied:{rejection}} | abort`)으로 같은 매핑을 적용한다.
  - 승인 요청마다 `item.started approval` + `approval.requested`, 응답 후 `item.completed approval`. **자동 만료 없음.**
- 다른 threadId의 알림은 무시(로그).

### 5. 등록

`defaultAdapters()`(또는 `agent-host/server.ts`의 기본 어댑터 맵)에 `codex: new CodexAdapter()`를 추가한다.

### 6. 테스트 (`packages/server/test/agents/codex/`)

- `jsonrpc.test.ts`: `PassThrough` 쌍으로 요청/응답/알림/서버요청/타임아웃/부분 청크/잘못된 줄.
- 가짜 app-server: `spawnFn`을 주입해 `PassThrough` 위에서 스크립트대로 응답·알림·서버요청을 내는 헬퍼. 시나리오: (a) start→turn→agentMessage 델타→completed→turn/completed, (b) commandExecution 승인 요청 → `allow_session` → `acceptForSession` 회신 확인, (c) deny/abort, (d) fileChange 승인과 diff, (e) requestUserInput 왕복, (f) resume 시 `thread/resume` 호출, (g) interrupt → `turn/interrupt`, (h) 프로세스 종료 → error.
- 통합(`MAM_IT_CODEX=1`일 때만): 실제 `codex app-server`로 임시 디렉토리에서 `mode: 'plan'`(read-only, on-request) 세션을 열고 `"Reply with exactly the word pong and nothing else."`를 보내 120초 안에 `assistant_message`에 `pong`, `turn.completed`가 오는지.

### 7. 통합 테스트 1회 실제 실행

이 머신의 Codex 로그인(ChatGPT 계정)으로 `MAM_IT_CODEX=1`을 켜고 한 번 실행해 통과를 확인하고 소요 시간을 summary에 적어라. 인증 실패면 `blocked`.

## Acceptance Criteria

```bash
npm ci
npm run typecheck
npm test
MAM_IT_CODEX=1 npx vitest run --root packages/server test/agents/codex   # 실제 app-server 스모크 1회 (통과해야 함)
bash scripts/test.sh
test -f packages/server/src/agents/codex/generated/v2/TurnStartParams.ts
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - `docs/PROTOCOL.md` 5절 매핑표와 4절 모드 매핑을 지키는가?
   - 자식 프로세스는 인자 배열 spawn인가(CRITICAL 4)? seq를 만들지 않는가(CRITICAL 7)?
   - 생성 바인딩의 타입을 실제로 import해서 쓰는가(손으로 다시 정의하지 않았는가)?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- `codex exec --json`이나 `codex mcp-server`로 구현하지 마라. 이유: ADR-007. 승인 왕복과 재개가 안 된다.
- `--dangerously-bypass-approvals-and-sandbox`나 `danger-full-access`를 기본값이나 테스트에 쓰지 마라. 이유: `full-auto` 모드에서만 허용된다.
- `codex app-server daemon`(공유 데몬)이나 `remote-control`을 쓰지 마라. 이유: 사용자별 프로세스 격리가 깨진다.
- 생성 바인딩 파일을 손으로 수정하지 마라. 재생성으로 덮어써진다.
- `packages/protocol`을 수정하지 마라. 필요하면 `needs_input`.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
