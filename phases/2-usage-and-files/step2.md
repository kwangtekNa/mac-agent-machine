# Step 2: claude-usage-models

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/PROTOCOL.md` (5절 "Claude Agent SDK → TimelineItem"의 사용량 항목, `GET /usage`, `GET /models`)
- `/docs/ADR.md` (ADR-016, ADR-006)
- `/packages/server/src/agents/types.ts` (step 1의 `usage` 이벤트, `setModel/setEffort`, `listModels`, `usage()`), `/packages/server/src/usage/rate-limit-store.ts`
- `/packages/server/src/agents/claude/adapter.ts`, `mapping.ts`, `credentials.ts` (Phase 0 step 5)
- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` — `SDKResultSuccess`(`usage`, `modelUsage`, `total_cost_usd`), `ModelUsage`(`contextWindow`, `costUSD`), `SDKRateLimitEvent`/`SDKRateLimitInfo`(`status`, `rateLimitType`, `utilization`, `resetsAt`), `Query.supportedModels()`/`ModelInfo`(`value`, `displayName`, `description`, `supportedEffortLevels`), `Query.setModel()`, `Options.effort`, `Query.accountInfo()`(`subscriptionType`), `SDKSystemMessage(init).model`

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

Claude 어댑터에 사용량·컨텍스트·구독 한도·모델 목록·모델/effort 변경을 붙인다.

### 1. 사용량 이벤트 (`mapping.ts`)

- `system/init` → 기존 이벤트에 더해 `usage { model: init.model }`(effort는 세션 시작 옵션값이 있으면 함께).
- `result`(success/error 모두) → `usage` 이벤트:
  - `delta.inputTokens = usage.input_tokens`, `outputTokens = usage.output_tokens`, `cacheReadTokens = usage.cache_read_input_tokens`, `cacheWriteTokens = usage.cache_creation_input_tokens` (`result.usage`는 **이번 턴의 메인 루프** 값이다).
  - `delta.costUsd = total_cost_usd - 직전 result의 total_cost_usd`(프로세스 누적이므로 차분. 음수면 0). 프로세스가 `resume`으로 재시작되면 기준을 0으로 리셋.
  - `context = { tokens: input_tokens + cache_read_input_tokens + cache_creation_input_tokens, window: max(modelUsage[*].contextWindow) }`. `modelUsage`가 비어 있으면 `context: undefined`(유지).
  - `SDKResultError`에는 `usage`가 없을 수 있다. 없으면 delta 없이 `context` 유지.
- `rate_limit_event` → `RateLimitStore.save('claude', ...)`: `rateLimitType`별로 하나씩 보관(`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet` 등 그대로 id). `usedPercent`: `utilization`이 1 이하이면 ×100(비율), 아니면 그대로(백분율) — **실제 이벤트를 관측해 어느 쪽인지 확인하고 summary에 적어라.** `resetsAt`: epoch 초 → Date. `rejected = status === 'rejected'`. `windowMinutes`: `five_hour`→300, `seven_day*`→10080, 그 외 null. `observedAt = now`. `plan`은 `accountInfo().subscriptionType`을 세션 시작 직후 1회 조회해 저장(실패 시 null).
- `usage()`: 저장소에서 읽어 `{ plan, live: false, observedAt, limits }`. 관측 없음 → `limits: []`.

### 2. 모델 목록과 변경 (`adapter.ts`)

- `listModels()`: 캐시 파일 `~/.mam/models/claude.json`(24시간). 캐시가 없거나 오래됐고 라이브 세션이 있으면 `q.supportedModels()`로 갱신. 라이브 세션이 없고 캐시도 없으면 **정적 기본 목록**: `sonnet`("Sonnet", 기본), `opus`("Opus"), `haiku`("Haiku"), efforts 전부 `['low','medium','high','xhigh','max']`, `defaultEffort: 'high'`. `ModelInfo.supportedEffortLevels`가 있으면 그것을 efforts로, 없고 `supportsEffort === false`면 `[]`.
- 세션 시작 직후(`system/init` 이후) 백그라운드로 `supportedModels()`를 한 번 호출해 캐시를 채운다(실패 무시).
- `setModel(model)`: `q.setModel(model)` 호출 후 `usage { model }` 이벤트. `setEffort(effort)`: 값을 보관하고 **다음 `sendTurn` 전에** 현재 프로세스를 닫고 `resume: nativeId`, `effort`로 다시 `start`한다(매니저의 유휴 재시작 경로와 같은 코드 경로를 재사용). 재시작 후 `usage { effort }` 이벤트.
- `StartOptions.model/effort`를 `Options.model`, `Options.effort`에 전달.

### 3. 테스트 (`test/agents/claude/`)

- 가짜 Query로 `result` 두 개를 순서대로 주고 delta·cost 차분·context 계산, `SDKResultError`(usage 없음) 처리, `rate_limit_event` → 저장소 내용(임시 dataDir), `usage()`의 `live:false`, `supportedModels` 캐시 갱신과 정적 폴백, `setModel` 호출과 이벤트, `setEffort` → 다음 턴에 `resume` + `effort` 옵션으로 재시작.
- 통합(`MAM_IT_CLAUDE=1`): 실제 세션에서 pong 턴 후 `usage` 이벤트가 오고 `context.window > 0`, `delta.inputTokens > 0`인지, `rate_limit_event`가 관측되면 저장소에 기록되는지(관측 안 되면 skip 로그).

### 4. 통합 테스트 1회 실제 실행

`MAM_IT_CLAUDE=1 npx vitest run --root packages/server test/agents/claude`를 실행해 결과와 관측한 `rate_limit_info` 원본(값 형태만, 토큰 없음)을 summary에 적어라.

## Acceptance Criteria

```bash
npm ci
npm run typecheck
npm test
MAM_IT_CLAUDE=1 npx vitest run --root packages/server test/agents/claude
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - `docs/PROTOCOL.md` 5절의 산출식(델타, 비용 차분, 컨텍스트)과 일치하는가?
   - 한도 저장 파일에 토큰·이메일 외의 비밀이 없는가(CRITICAL 6)? 이메일은 `plan`과 함께 저장하지 않는다.
   - SDK API를 d.ts에서 확인했는가(추측 금지)?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- Anthropic API를 직접 호출해 사용량을 조회하지 마라(비공개 엔드포인트 사용 금지). SDK 이벤트 관측만.
- `bypassPermissions`를 테스트 편의로 쓰지 마라. IT는 `allowedTools: []`, `maxTurns: 1`.
- `packages/protocol`, `ios/`를 수정하지 마라.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
