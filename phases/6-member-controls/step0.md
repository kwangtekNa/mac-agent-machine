# Step 0: full-auto-adapters

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/PROTOCOL.md` 4절 모드 매핑, 5절 어댑터 매핑, 6.2(`PATCH /teams/:id/members/:memberId` 의 mode/effort/model 규칙)
- `/docs/ADR.md` ADR-015(모드 4종, full-auto 는 앱에서 확인), ADR-006, 007
- `/packages/server/src/agents/claude/adapter.ts` (`MODE_MAP`, `toPermissionMode`, `openProcess()` 의 SDK `Options`, `canUseTool()`, `setMode()`)
- `/packages/server/src/agents/codex/adapter.ts` (`MODE_MAP`, `toCodexPolicy`, `toSandboxPolicy`, `start()`, `sendTurn()` 의 `turn/start` 파라미터, `setMode()`, 서버 요청 `handleRequest` 의 승인 처리)
- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` 에서 `allowDangerouslySkipPermissions`, `PermissionMode`, `setPermissionMode` 설명
- `/packages/server/src/sessions/manager.ts` (`patch` 의 mode 처리, `setMode`), `/packages/server/src/teams/team-manager.ts` (`patchMember` 가 `manager.patch` 로 mode/model/effort 를 넘기는 부분)
- `/packages/server/test/agents/claude/integration.test.ts`, `codex/integration.test.ts` (`MAM_IT_*` 게이트, 실제 어댑터 한 턴 패턴), `test/helpers/fake-claude-query.ts`, `fake-codex-app-server.ts`, `test/agents/claude/usage.test.ts`

이전 phase 에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 배경

사용자가 세션이나 팀원을 `full-auto` 로 바꿔도 승인 요청이 계속 온다. 원인: Claude 어댑터는 `full-auto → permissionMode "bypassPermissions"` 로 매핑하지만, SDK 는 이 모드에 **`allowDangerouslySkipPermissions: true`** 를 요구한다(sdk.d.ts: "Must be set to true when using permissionMode: 'bypassPermissions'"). 플래그가 없어 bypass 가 적용되지 않고 `canUseTool` 이 계속 호출된다. 런타임 `setPermissionMode("bypassPermissions")` 도 프로세스가 그 플래그로 시작돼 있어야 한다.

## 확정된 결정

- **full-auto = 모든 도구 승인 없이 실행**(파일 편집·명령·웹 전부). 전환 확인은 앱이 한다(ADR-015 유지). 팀원은 자기 worktree 안에서만 일하므로 위험이 제한된다.
- Codex 매핑(`approvalPolicy: never`, `sandbox: danger-full-access`)은 유지한다.

## 작업

### 1. Claude 어댑터

- `openProcess()` 의 SDK `Options` 에 **항상** `allowDangerouslySkipPermissions: true` 를 넣는다(이 플래그는 모드를 켜는 것이 아니라 허용만 한다. 실제 bypass 는 `permissionMode` 가 결정하고, 그 전환은 사용자가 앱에서 확인한다). 주석으로 이유를 남긴다.
- `canUseTool()` 은 이중 안전장치로 `this.mode === "full-auto"` 이면 승인 아이템·`approval.requested` 를 만들지 않고 즉시 `{ behavior: "allow", updatedInput: input }` 을 돌려준다(SDK 가 bypass 중에도 호출하는 도구가 있을 때 대비). `plan`·`ask`·`auto-edit` 는 지금과 동일.
- `setMode()` 는 그대로(`q.setPermissionMode`). 프로세스가 없을 때(idle) 바뀐 mode 는 다음 `openProcess` 의 `permissionMode` 로 간다(이미 그렇게 동작하는지 확인하고 아니면 고친다).

### 2. Codex 어댑터

- `setMode()` 뒤의 다음 `turn/start` 가 새 `approvalPolicy`/`sandboxPolicy` 를 쓰는지 확인한다(`sendTurn` 이 `this.mode` 를 읽는다). 진행 중인 턴에는 적용되지 않음을 주석으로 남긴다.
- `full-auto` 에서 서버 요청(승인)이 오면 — 정책상 오지 않아야 하지만 — 자동 승인으로 응답하고 승인 아이템을 만들지 않는다(이중 안전장치, `handleRequest`).

### 3. SessionManager / TeamManager

- `manager.patch(id, { mode: "full-auto" })` 와 팀원 `patchMember({ mode })` 가 세션 레코드와 라이브 어댑터 둘 다에 반영되는지 확인하고, 세션이 idle(프로세스 없음)이면 레코드만 바꿔 다음 시작에 쓰이게 한다. 이미 그렇게 돼 있으면 테스트만 추가한다.
- 팀원 `MemberInput.mode` 로 `full-auto` 를 받는 것을 허용한다(스키마는 이미 허용; 서버에서 막고 있으면 푼다).

### 4. 테스트 (먼저 쓴다)

- `test/agents/claude/permissions.test.ts`(`fake-claude-query.ts`): `Options.allowDangerouslySkipPermissions === true` 가 모든 모드에서 넘어가는지; `full-auto` 세션에서 `canUseTool` 을 흉내 내 호출하면 승인 이벤트 없이 allow 인지; `ask` 는 여전히 승인 요청을 내는지; `setMode("full-auto")` 가 `setPermissionMode("bypassPermissions")` 를 부르는지.
- `test/agents/codex/permissions.test.ts`(`fake-codex-app-server.ts`): `setMode("full-auto")` 후 `turn/start` params 의 `approvalPolicy: "never"`, `sandboxPolicy` full access; full-auto 중 서버 승인 요청이 오면 자동 승인 응답.
- `test/sessions/manager-mode.test.ts`: idle 세션 patch mode → 레코드 저장 → 다음 start 의 `StartOptions.mode`; 라이브 세션이면 어댑터 `setMode` 호출(Fake `startCalls`/기록으로 확인).
- **통합 테스트(게이트 밖, 반드시 실행하고 결과를 summary 에 적는다. 비용 수 센트)**: `MAM_IT_CLAUDE=1` — `full-auto` 세션에 `"Use the Bash tool to run: echo pong. Then reply with only its output."` → `tool_call` 아이템이 있고 `approval.requested` 가 **0건**, 답변에 pong. 같은 지시를 `ask` 모드로 보내면 승인 요청이 1건 이상(이 케이스는 기존 테스트가 있으면 재사용). `MAM_IT_CODEX=1` 도 같은 두 케이스. 임시 cwd 는 `~/.mam/smoke/<ts>/` 아래.

## Acceptance Criteria

```bash
npm ci
npm run typecheck
npm test
grep -q "allowDangerouslySkipPermissions" packages/server/src/agents/claude/adapter.ts
MAM_IT_CLAUDE=1 npx vitest run packages/server/test/agents/claude/integration.test.ts
MAM_IT_CODEX=1 npx vitest run packages/server/test/agents/codex/integration.test.ts
bash scripts/dev-smoke.sh
bash scripts/test.sh
```

통합 테스트가 로그인 문제로 실행 불가하면 `blocked`(원인 포함). 실행했는데 full-auto 에서 승인이 나오면 그 원인을 어댑터에서 찾아 고친다(모드 변경 없이 넘기지 마라).

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - `ask`/`auto-edit`/`plan` 의 승인 동작이 바뀌지 않았는가(기존 승인 테스트 전부 통과)?
   - full-auto 전환 자체는 여전히 사용자 액션(`PATCH mode`)으로만 일어나는가(서버가 기본값을 full-auto 로 만들지 않는가)?
   - 승인 요청 본문·명령을 로그에 남기지 않는가(CRITICAL 6)?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약, 통합 테스트 관측값 포함)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- 기본 모드를 `full-auto` 로 바꾸거나 서버가 스스로 full-auto 로 올리지 마라. 이유: ADR-015 — 전환은 사용자가 앱에서 확인한다.
- `ask`/`auto-edit`/`plan` 의 매핑을 바꾸지 마라.
- `packages/protocol` 을 수정하지 마라(모드 값은 이미 있다).
- iOS 를 수정하지 마라(step 1).
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
