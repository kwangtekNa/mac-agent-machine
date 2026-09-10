# Step 3: codex-usage-models

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/PROTOCOL.md` (5절 "Codex app-server → TimelineItem"의 사용량 항목, `GET /usage`, `GET /models`)
- `/docs/ADR.md` (ADR-016, ADR-007)
- `/packages/server/src/agents/types.ts` (step 1), `/packages/server/src/usage/rate-limit-store.ts`
- `/packages/server/src/agents/codex/adapter.ts`, `mapping.ts`, `process.ts`, `jsonrpc.ts` (Phase 0 step 6)
- 생성 바인딩 `packages/server/src/agents/codex/generated/v2/`: `ThreadTokenUsageUpdatedNotification`, `ThreadTokenUsage`, `TokenUsageBreakdown`, `GetAccountRateLimitsResponse`, `RateLimitSnapshot`, `RateLimitWindow`, `AccountRateLimitsUpdatedNotification`, `GetAccountResponse`/`Account`/`PlanType`, `ModelListParams`, `ModelListResponse`, `Model`, `ReasoningEffortOption`, `TurnStartParams`(`model`, `effort`), `ThreadStartParams`(`model`)

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

Codex 어댑터에 사용량·컨텍스트·구독 한도·모델 목록·모델/effort 변경을 붙인다.

### 1. 사용량 이벤트 (`mapping.ts`)

- `thread/tokenUsage/updated` → `usage` 이벤트: `delta` = `tokenUsage.total`의 직전 관측치 대비 증가분(`inputTokens`, `outputTokens`, `cachedInputTokens → cacheReadTokens`, `cacheWriteInputTokens → cacheWriteTokens`; 첫 관측은 total 전체가 델타. `thread/resume` 직후 첫 관측은 기준선으로만 삼고 델타 0 — 이전 프로세스에서 이미 누적했기 때문), `context = { tokens: last.totalTokens, window: modelContextWindow }`(`modelContextWindow`가 null이면 `context: undefined`), `costUsd`는 넣지 않는다(구독 계정, 매니저가 null 유지).
- `thread/start`/`thread/resume` 응답의 모델(응답 타입에서 확인; 없으면 `turn/started`나 `model/list`의 `isDefault`)을 `usage { model }`로. `turn/start`에 `effort`를 보냈으면 `usage { effort }`.
- `account/rateLimits/updated` 알림 → `RateLimitStore.save('codex', ...)` (캐시 갱신).

### 2. 한도·모델·변경 (`adapter.ts`)

- `usage()`: 라이브 세션이 있으면 그 피어로, 없으면 임시 `codex app-server` 프로세스를 띄워(`initialize`/`initialized` 후) `account/rateLimits/read`와 `account/read`를 호출하고 종료. `primary` → `{ id: 'primary', label은 windowDurationMins 기준(300→"5시간", 10080→"주간", 그 외 "N시간"/"N일"), usedPercent, windowMinutes, resetsAt(epoch 초→Date) }`, `secondary` 동일. `rateLimitReachedType`가 있거나 `usedPercent ≥ 100`이면 `rejected`. `plan = account.planType`(chatgpt 계정일 때). `live: true`, `observedAt: now`. 60초 캐시(저장소). 실패 시 저장소의 마지막 값(`live: false`) 또는 `limits: []`.
- `listModels()`: `model/list { includeHidden: false }` 페이지 전부(`nextCursor`) → `AgentModel { id: model.id, displayName, description, isDefault, efforts: supportedReasoningEfforts.map(e => e.reasoningEffort), defaultEffort: defaultReasoningEffort }`. 라이브 세션이 없으면 임시 프로세스. 24시간 캐시 `~/.mam/models/codex.json`.
- `setModel(model)`, `setEffort(effort)`: 저장 후 다음 `turn/start`에 `model`, `effort`로 전달. 즉시 `usage { model }`/`usage { effort }` 이벤트(다음 턴부터 적용됨을 알리는 용도로 충분).
- `StartOptions.model/effort` → `thread/start.model`, 첫 `turn/start.effort`.
- 임시 프로세스는 `process.ts`의 공용 헬퍼 `withEphemeralAppServer(fn)`로(step 9의 Codex 로그인 플로우가 이미 비슷한 코드를 갖고 있으면 그것을 공용화).

### 3. 테스트 (`test/agents/codex/`)

- 가짜 app-server로 `thread/tokenUsage/updated` 두 번 → 델타·컨텍스트, resume 직후 기준선 처리, `account/rateLimits/read` 응답 → limits 매핑(라벨, rejected, epoch 변환), `account/rateLimits/updated` → 저장소, `model/list` 페이지네이션과 hidden 제외, `setModel/setEffort`가 다음 `turn/start` 파라미터에 반영, `usage()` 캐시와 실패 폴백.
- 통합(`MAM_IT_CODEX=1`): 실제 `account/rateLimits/read`가 응답하고 `limits.length ≥ 1`, `model/list`에 `isDefault` 모델이 있고 efforts가 비어 있지 않은지, pong 턴 후 `usage` 이벤트에 `context.window > 0`.

### 4. 통합 테스트 1회 실제 실행

`MAM_IT_CODEX=1 npx vitest run --root packages/server test/agents/codex`를 실행하고 관측한 창 라벨·요금제를 summary에 적어라.

## Acceptance Criteria

```bash
npm ci
npm run typecheck
npm test
MAM_IT_CODEX=1 npx vitest run --root packages/server test/agents/codex
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - `docs/PROTOCOL.md` 5절의 Codex 산출식과 일치하는가?
   - 생성 바인딩의 타입을 import해 쓰고 손으로 다시 정의하지 않았는가?
   - 임시 프로세스가 항상 종료되는가(테스트에서 spawn/kill 횟수 검증)?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- `codex app-server daemon`/`remote-control`을 쓰지 마라(사용자별 격리).
- 생성 바인딩을 손으로 수정하지 마라.
- `packages/protocol`, `ios/`를 수정하지 마라.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
