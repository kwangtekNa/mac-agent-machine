# Step 5: claude-adapter

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/ARCHITECTURE.md` (2.3 에이전트 어댑터, 7절 권한 요청 데이터 흐름)
- `/docs/PROTOCOL.md` (3절 TimelineItem, 4절 모드 매핑, 5절 "Claude Agent SDK → TimelineItem")
- `/docs/ADR.md` (ADR-006, ADR-008, ADR-011)
- `/packages/server/src/agents/types.ts`, `/packages/server/src/agents/fake/`, `/packages/server/src/ids.ts` (step 2)
- `/packages/server/src/sessions/manager.ts` (어댑터를 어떻게 소비하는지)
- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` — **반드시 읽어라.** 특히 `Options`(`canUseTool`, `resume`, `forkSession`, `includePartialMessages`, `settingSources`, `env`, `pathToClaudeCodeExecutable`, `permissionMode`, `abortController`, `stderr`), `CanUseTool`, `PermissionResult`, `PermissionUpdate`, `SDKUserMessage`(필수 필드 확인), `SDKMessage` 유니온 각 타입, `Query` 인터페이스(`interrupt`, `setPermissionMode`, `close`, `accountInfo`).
- `node_modules/@anthropic-ai/claude-agent-sdk/README.md`

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

`@anthropic-ai/claude-agent-sdk`(0.3.266, step 0에서 설치됨)로 `AgentAdapter`를 구현한다. SDK 메시지를 `docs/PROTOCOL.md`의 TimelineItem으로 정규화하고, `canUseTool`을 승인 요청으로 노출한다.

### 0. 바이너리 해석 유틸 `packages/server/src/agents/resolve-bin.ts` (이 step이 만든다, step 6도 쓴다)

```ts
/** name 은 'claude' | 'codex' 만 허용. 우선순위: envOverride → 사용자 로그인 셸의 `command -v` → 후보 경로. 없으면 null. */
export async function resolveBinary(name: 'claude' | 'codex', envOverride?: string): Promise<string | null>;
```

로그인 셸 호출은 `spawn(process.env.SHELL ?? '/bin/zsh', ['-lc', `command -v ${name}`])`로 고정 문자열만 쓴다(name은 리터럴 유니온이라 사용자 입력이 섞이지 않는다). 타임아웃 5초. 후보 경로: `~/.local/bin/<name>`, `/opt/homebrew/bin/<name>`, `/usr/local/bin/<name>`. 결과는 프로세스 수명 동안 캐시.

### 1. 자격증명 `packages/server/src/agents/claude/credentials.ts`

- `tokenPath(home)` = `${home}/.mam/secrets/claude-oauth-token`.
- `readOauthToken(home): Promise<string | null>` (파일 0600, 내용 trim).
- `detectLogin(home): Promise<{ loggedIn: boolean; account: string | null; source: 'mam-token' | 'credentials-file' | 'claude-json' | null; warning?: string }>`: 순서대로 (1) 토큰 파일 존재(파일 mtime이 330일 이상이면 `warning: '토큰 만료 임박'`), (2) `~/.claude/.credentials.json`에 `claudeAiOauth` 키, (3) `~/.claude.json`의 `oauthAccount.emailAddress`. (3)이 있으면 account로 쓴다. (2)는 공식 문서상 Keychain이 잠긴 headless 환경(SSH, `sudo -u`)에서 Claude Code가 자동으로 쓰는 폴백 파일이므로, SSH에서 `claude login`한 사용자는 여기에 잡힌다. macOS Keychain은 조회하지 않는다(ADR-008). `CLAUDE_CONFIG_DIR`가 설정돼 있으면 `~/.claude` 대신 그 디렉토리를 본다.

### 2. 어댑터 `packages/server/src/agents/claude/adapter.ts`

```ts
export interface ClaudeAdapterOptions {
  queryFn?: typeof query;              // 테스트 주입. 기본 SDK query
  home?: string;                       // 기본 os.homedir()
  binPath?: string;                    // 기본 process.env.MAM_CLAUDE_BIN → resolveBinary('claude'). null이면 SDK 번들 실행파일 사용(pathToClaudeCodeExecutable 미지정)
  settingSources?: SettingSource[];    // 기본 ['user', 'project', 'local'] — 사용자의 ~/.claude 설정, 프로젝트 CLAUDE.md, 훅, MCP 를 그대로 적용한다
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}
export class ClaudeAdapter implements AgentAdapter { readonly kind = 'claude'; ... }
```

`probe()`: `available`은 binPath가 있거나 SDK가 import 가능하면 true. `version`은 binPath가 있으면 `<bin> --version` 첫 줄, 없으면 SDK 패키지 버전. `loggedIn/account`는 `detectLogin`.

`start(opts)`:

- 사용자 메시지 큐를 `AsyncIterable<SDKUserMessage>`로 만들어 `queryFn({ prompt: queue, options })`를 호출한다. 세션 수명 동안 프로세스 하나.
- `options`: `cwd`, `permissionMode: toPermissionMode(opts.mode)`(PROTOCOL 4절), `resume: opts.resumeNativeId`, `includePartialMessages: true`, `settingSources`, `model: opts.model`, `canUseTool`, `abortController`, `stderr: line => logger.warn(...)`, `pathToClaudeCodeExecutable: binPath ?? undefined`, `env`: `process.env` 복사본에서 **`CLAUDECODE`와 `CLAUDE_CODE_ENTRYPOINT`를 삭제**하고(중첩 세션 감지 회피. 하네스 자체가 Claude Code 안에서 돌기 때문), 토큰 파일이 있으면 `CLAUDE_CODE_OAUTH_TOKEN`을 넣는다.
- `sendTurn(input)`: `trn_` ID를 새로 만들고 큐에 `SDKUserMessage`를 push한다. `message.content`는 `[{type:'text', text}]` + 첨부 이미지는 `image` 블록(base64). `SDKUserMessage`의 필수 필드(`parent_tool_use_id: null`, `session_id` 등)는 d.ts를 보고 정확히 채운다. 이미 턴이 진행 중이면 매니저가 막지만 어댑터도 `AgentBusyError`를 던진다.
- 백그라운드 루프 `for await (const msg of q)`가 SDK 메시지를 `mapping.ts`로 넘겨 `AgentEvent`를 만든다. 이터레이터가 예외로 끝나면 `error{recoverable:false}`를 내고 events를 종료한다.
- `interrupt()` → `q.interrupt()`. 공식 문서에 `interrupt()`의 정확한 중단 의미가 없으므로 통합 테스트에서 실측하라: 호출 후 5초 안에 `result`(또는 status idle)가 오지 않으면 `abortController.abort()`로 프로세스를 끝내고 `error{recoverable:true, message:'턴을 강제 중단했습니다'}` + status idle을 낸 뒤, 다음 `sendTurn`에서 `resume: nativeId`로 새 프로세스를 연다(매니저의 유휴 재시작 경로와 같은 방식). 관찰 결과를 summary에 적어라. `setMode(mode)` → `q.setPermissionMode(toPermissionMode(mode))`. `close()` → 대기 중 승인은 전부 `deny{interrupt:true}`로 정리, `abortController.abort()`, `q.close()`(있으면), 루프 종료 대기.
- `continue: true`는 쓰지 않는다(같은 cwd의 다른 세션을 집어올 수 있다). 재개는 항상 `resume: <id>`다.
- `canUseTool`은 권한 평가가 프롬프트로 떨어질 때만 호출된다. `acceptEdits`나 사용자 allow 규칙으로 자동 허용된 도구는 콜백 없이 실행되므로, 승인 이벤트가 없다고 해서 버그가 아니다. 테스트 시나리오는 `default` 모드 기준으로 작성하라.

### 3. 매핑 `packages/server/src/agents/claude/mapping.ts`

상태를 가진 `ClaudeEventMapper`. 입력은 SDKMessage, 출력은 `AgentEvent[]`. 규칙은 PROTOCOL 5절을 따르고 아래를 보강한다:

- `system/init` → `native_id(session_id)` + `status idle`. init의 `model`, `permissionMode`는 로그.
- `stream_event`(partial): `content_block_start`(text) → `item.started assistant_message(status running, text '')`; `content_block_delta`(text_delta) → `item.delta(field text)`; thinking 블록도 같은 방식으로 `reasoning`; `tool_use` 블록 시작 → `item.started tool_call(status running, input {} )`, `input_json_delta`는 버퍼링만.
- `assistant`(완성 메시지): 같은 블록들의 최종본으로 `item.completed`를 낸다(assistant_message는 completed, tool_call은 input을 채우고 **running 유지** — 결과는 tool_result가 온 뒤). Edit/Write/MultiEdit/NotebookEdit는 추가로 `file_change` 아이템(running)을 만든다. 패치는 `input.old_string/new_string`(Edit) 또는 전체 내용(Write)으로 unified diff 형식 문자열을 직접 만든다(의존성 추가 금지, 줄 단위 단순 diff면 충분).
- `user`(tool_result 포함): `tool_use_id`로 tool_call을 찾아 `output`(문자열화, 64 KiB 초과는 절단 + `truncated`), `status completed|failed(is_error)`로 `item.completed`. 대응 file_change도 completed.
- 도구명 → `tool` 매핑: Bash→bash, Read→read, Write→write, Edit/MultiEdit/NotebookEdit→edit, Glob→glob, Grep→grep, WebFetch/WebSearch→web, `mcp__*`→mcp, Task/Agent→task, 그 외 other. `title`: Bash는 `input.command` 앞 120자, 파일 도구는 `input.file_path`, 그 외 도구명.
- `result` → `turn_summary` 아이템 + `turn.completed{durationMs: duration_ms, usage: {inputTokens, outputTokens, cacheReadTokens}, costUsd: total_cost_usd, stopReason}` + `status idle`. `is_error`면 `error{recoverable:true}`도 낸다. 메시지에 로그인/인증 관련 문구가 있으면 `error.message`에 "Claude 로그인이 필요합니다"를 앞에 붙인다.
- `compact_boundary` → `system` 아이템. `SDKPermissionDeniedMessage`, `SDKAPIRetryMessage`, `SDKAuthStatusMessage`는 `system` 아이템(짧은 한국어 문구). `tool_progress`, `status`, `task_*`, `hook_*`는 무시(로그만).
- 모든 아이템의 `turnId`는 현재 턴. 턴 밖에서 온 이벤트는 `turnId: null`.

### 4. 승인 (`canUseTool`)

- 콜백이 호출되면 `apr_` ID로 Approval을 만든다: `kind`는 Bash→`command`, Edit/Write/MultiEdit/NotebookEdit→`file_change`(`diff`에 위 패치), 그 외→`permission`. `title`은 위 규칙, `prompt`는 SDK가 옵션으로 넘겨주는 렌더링된 문장이 있으면 그것(d.ts의 `CanUseTool` options 확인), `detail`은 `cwd`와 입력 JSON(2-space, 4 KiB 절단). `options`: `allow`, `allow_session`(`suggestions`가 비어 있지 않을 때만), `deny`. `abort`는 항상 허용되는 숨은 옵션으로 처리한다(옵션 목록에는 넣지 않되 응답으로 오면 받아들인다).
- `item.started approval` + `approval.requested`를 내고 Promise를 보류한다. **자동 만료 없음.**
- `respondApproval` 매핑: `allow` → `{ behavior:'allow', updatedInput: input }`, `allow_session` → `{ behavior:'allow', updatedInput: input, updatedPermissions: suggestions }`, `deny` → `{ behavior:'deny', message: message ?? '사용자가 거절했습니다' }`, `abort` → `{ behavior:'deny', message, interrupt: true }`. 이후 `item.completed approval(resolution 포함)`.
- `options.signal`이 abort되면(SDK가 취소) Promise를 정리하고 `approval.resolved{by:'system'}`에 해당하는 아이템 완료를 낸다.

### 5. 등록

`packages/server/src/agent-host/server.ts`의 어댑터 기본값에 `claude: new ClaudeAdapter()`를 추가한다(`MAM_FAKE_AGENT=1`이면 여전히 Fake). step 4가 아직 없는 워크트리라면 `packages/server/src/agents/index.ts`에 `defaultAdapters()` 팩토리만 만들고 summary에 적어라.

### 6. 테스트 (`packages/server/test/agents/claude/`)

- `queryFn`에 가짜 Query(비동기 이터레이터 + `interrupt/setPermissionMode/close` 스파이)를 주입해 스크립트된 SDKMessage 시퀀스를 재생한다. 시나리오: (a) init→텍스트 스트리밍→result, (b) Bash tool_use→canUseTool 호출→`allow_session` 응답→`updatedPermissions`가 suggestions와 같음→tool_result→result, (c) deny 경로와 abort 경로, (d) Edit → file_change 아이템과 diff, (e) `resume`/`permissionMode`/`env.CLAUDE_CODE_OAUTH_TOKEN`(임시 홈에 토큰 파일)이 options에 전달됨, (f) 이터레이터 예외 → `error` 후 종료, (g) `interrupt()`가 `q.interrupt()`를 호출.
- `credentials.test.ts`: 세 가지 감지 경로.
- 통합(`MAM_IT_CLAUDE=1`일 때만, 기본 skip): 실제 SDK로 임시 디렉토리에서 세션 시작, `"Reply with exactly the word pong and nothing else."` 전송, 120초 안에 `assistant_message`에 `pong`이 포함되고 `turn.completed`가 오는지. options에 `maxTurns: 1`, `allowedTools: []`을 추가로 넣어 비용을 최소화한다.

### 7. 통합 테스트 1회 실제 실행

이 머신의 사용자(현재 로그인된 Claude 계정)로 `MAM_IT_CLAUDE=1 npm test -w @mam/server -- claude` 를 **한 번 실행**해 통과를 확인하고 결과(소요 시간, 비용)를 summary에 적어라. 실패 원인이 인증이면 `blocked`로 보고하라. 비용은 몇 센트 수준이다.

## Acceptance Criteria

```bash
npm ci
npm run typecheck
npm test
MAM_IT_CLAUDE=1 npx vitest run --root packages/server test/agents/claude   # 실제 SDK 스모크 1회 (통과해야 함)
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - `docs/PROTOCOL.md` 5절의 매핑표와 3절의 payload 형태를 지키는가? fixture와 같은 모양인가?
   - seq를 만들지 않는가(CRITICAL 7)? 토큰이 로그에 찍히지 않는가(CRITICAL 6)?
   - SDK API를 추측하지 않고 d.ts에서 확인했는가?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- `claude --print --output-format stream-json`을 직접 spawn해 파싱하지 마라. 이유: ADR-006이 SDK를 선택했다. control 프로토콜을 재구현하면 승인 흐름이 깨진다.
- `permissionMode: 'bypassPermissions'`를 기본값이나 테스트 편의로 쓰지 마라. 이유: 기본 모드는 `ask`(=`default`)다. IT 테스트는 `allowedTools: []`로 도구를 막아 승인 없이 끝난다.
- macOS Keychain(`security` 명령)을 호출하지 마라. 이유: ADR-008. headless 프로세스에서 동작하지 않는다.
- `packages/protocol`을 수정하지 마라. 매핑에 필요한 필드가 없으면 `needs_input`.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
