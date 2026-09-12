# Step 1: adapter-instructions

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/PROTOCOL.md` (1절 `Session`, 6절 팀과 방 — step 0 이 추가)
- `/docs/ADR.md` (ADR-006, 007, 008, 010, 017)
- `/docs/ARCHITECTURE.md` (2.3 어댑터, 2.4 SessionManager)
- `/packages/protocol/src/session.ts` (`Session.team`), `teams.ts`
- `/packages/server/src/agents/types.ts` (`StartOptions`, `AgentAdapter`, `AgentSession`)
- `/packages/server/src/agents/claude/adapter.ts` (`ClaudeSession.openProcess()` 가 SDK `Options` 를 만드는 곳, `extraOptions`)
- `/packages/server/src/agents/codex/adapter.ts` (`start()` 의 `thread/start` / `thread/resume` 파라미터), `/packages/server/src/agents/codex/generated/v2/ThreadStartParams.ts`, `ThreadResumeParams.ts` (`developerInstructions`)
- `/packages/server/src/agents/fake/index.ts`, `session.ts`, `script.ts`
- `/packages/server/src/sessions/manager.ts` (`open`, `create`, `startAgent`, `startTurn`, `armIdleTimer`, 영속화 `schedulePersist`), `types.ts`
- `/packages/server/test/helpers/fake-claude-query.ts`, `fake-codex-app-server.ts`, `tmp-home.ts`
- `/packages/server/test/agents/claude/usage.test.ts`, `/packages/server/test/agents/codex/usage.test.ts`, `/packages/server/test/sessions/manager-usage.test.ts` (테스트 스타일)
- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` 에서 `systemPrompt` 옵션 설명

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

팀원 세션이 **역할 프롬프트** 를 가지고 시작·재개되도록 어댑터와 SessionManager 를 확장한다. 팀 로직 자체는 만들지 않는다(step 3~7).

### 1. `StartOptions.instructions?: string` (`src/agents/types.ts`)

역할 프롬프트 전문. 없으면 지금과 동일.

### 2. Claude 어댑터

`openProcess()` 에서 `start.instructions` 가 있으면 SDK `Options` 에 `systemPrompt: { type: "preset", preset: "claude_code", append: start.instructions }` 를 넣는다. 없으면 `systemPrompt` 를 넣지 않는다(기본 프롬프트 그대로). `snapshot` 옵션은 건드리지 않는다(SDK 기본값 유지).

**확정된 정책**: Claude SDK 는 시스템 프롬프트를 세션 첫 요청에 고정하므로, 프롬프트 수정은 **다음 세션(새 프로세스)부터** 적용된다. 이 사실을 `docs/PROTOCOL.md` 6.2 의 `PATCH /teams/:id/members/:memberId` 설명(`appliesAt: "next_session"`)과 일치하게 코드 주석에도 적는다.

### 3. Codex 어댑터

`start()` 에서 `thread/start` 와 `thread/resume` 파라미터 둘 다에 `developerInstructions: start.instructions` 를 넣는다(없으면 키 생략). `turn/start` 에는 넣지 않는다.

### 4. Fake 어댑터

- `FakeSession` 은 `options.instructions` 를 보관하고, 세션의 **첫 턴** 스크립트 실행 직전에 `system` 아이템(`kind: "system"`, `payload.text: "instructions: " + instructions`)을 `item.started/completed` 로 내보낸다(instructions 가 있을 때만). 종단 테스트가 주입을 확인하는 용도다.
- `ScriptContext` 에 `cwd: string` 을 추가한다(스크립트가 worktree 에 파일을 쓰는 테스트에 필요. step 5 가 쓴다).
- `startCalls` 는 그대로(`instructions` 가 자동으로 기록된다).

### 5. SessionManager

- 내부 영속 레코드 스키마 `SessionRecordSchema = SessionSchema.extend({ instructions: z.string().optional() })` 를 `sessions/types.ts` 또는 `manager.ts` 에 둔다. `sessions/<id>.json` 에는 `instructions` 를 저장하고, `list/get/detail/patch` 등 **응답으로 나가는 `Session` 에는 넣지 않는다**(프로토콜 스키마에 없는 키를 내보내면 개발 모드 응답 검증이 실패한다). `team` 은 프로토콜 필드이므로 그대로 내보낸다.
- `create(req: CreateSessionRequest & { instructions?: string; team?: { teamId: string; memberId: string }; deferStart?: boolean })`:
  - `deferStart: true` 면 어댑터를 띄우지 않고 `status: "idle"`, `nativeId: null` 로 등록·영속화만 한다. 첫 `startTurn` 이 `startAgent(rt, undefined)` 로 프로세스를 연다(이미 `rt.live` 가 없을 때 재개하는 경로를 재사용).
  - `instructions` 와 `team` 을 레코드에 저장한다.
- `startAgent()` 가 `StartOptions.instructions` 에 레코드의 값을 넘긴다(최초 시작과 `resumeNativeId` 재개 모두).
- `open()` 복구 시 `instructions`/`team` 을 그대로 읽는다. 기존 레코드(키 없음)도 통과해야 한다.
- 기존 `POST /sessions` 라우트는 바꾸지 않는다(일반 세션은 `instructions` 없음).

### 6. 테스트

- `test/agents/claude/instructions.test.ts`: `fake-claude-query.ts` 로 `query()` 가 받은 `options.systemPrompt` 가 `{ type: "preset", preset: "claude_code", append: "<지시문>" }` 인지; instructions 없으면 `systemPrompt` 키가 없는지; `resume` 재개에서도 넘기는지.
- `test/agents/codex/instructions.test.ts`: `fake-codex-app-server.ts` 로 `thread/start` 와 `thread/resume` 요청 params 에 `developerInstructions` 가 있는지, 없을 때 키가 없는지.
- `test/sessions/manager-instructions.test.ts`: `deferStart` 세션이 `start()` 호출 없이 `idle` 로 등록되고 첫 `startTurn` 에 `startCalls[0].instructions` 가 채워지는지; 유휴 종료 후 재개(`resumeNativeId`)에도 다시 넘기는지; 재시작(`SessionManager.open` 재호출) 뒤에도 유지되는지; `list()`/`get()` 결과에 `team` 은 있고 `instructions` 는 없는지; Fake 첫 턴에 `system` 아이템이 나오는지.
- 기존 테스트 전부 통과.

## Acceptance Criteria

```bash
npm ci
npm run typecheck
npm test
bash scripts/dev-smoke.sh
bash scripts/test.sh
```

선택(로그인돼 있고 사용자가 허용한 경우에만, 비용 수 센트): `MAM_IT_CLAUDE=1` / `MAM_IT_CODEX=1` 통합 테스트에 "instructions 로 'Always start your reply with the word PONG.' 를 주고 한 턴" 케이스를 추가해 답변이 PONG 으로 시작하는지 확인. 실행 여부와 결과를 summary 에 적는다.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 응답 `Session` 에 `instructions` 가 새지 않는가(로그에도 남기지 않는가, CRITICAL 6)?
   - `deferStart` 세션이 idle 타이머·shutdown 경로에서 예외를 내지 않는가(live 없음)?
   - Claude/Codex 어댑터의 다른 옵션(permissionMode, cwd, model, effort, resume)이 그대로인가?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- Claude `systemPrompt` 를 문자열(커스텀 전체 프롬프트)로 넘기지 마라. 이유: Claude Code 기본 프롬프트(도구 사용 규칙)가 사라진다. 반드시 preset + append.
- `snapshot: false` 를 넣지 마라. 이유: 프롬프트 캐시가 깨지고 비용이 늘며, 정책상 프롬프트 수정은 다음 세션부터다.
- `packages/protocol` 을 수정하지 마라(step 0 의 계약을 쓴다). 필요하면 `needs_input`.
- 팀·방·디스패처 코드를 만들지 마라. 이유: step 3~7 의 범위다.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
