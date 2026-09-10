# Step 1: server-usage-core

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/PROTOCOL.md` (2026-09-10 추가분 전부)
- `/docs/ADR.md` (ADR-016)
- `/docs/ARCHITECTURE.md` (2.4 SessionManager)
- `/packages/protocol/src/session.ts`, `rest.ts`, `ws.ts` (step 0의 새 스키마)
- `/packages/server/src/agents/types.ts`, `/packages/server/src/agents/fake/` (AgentEvent, FakeAdapter)
- `/packages/server/src/sessions/manager.ts`, `event-log.ts`, `types.ts`
- `/packages/server/src/agent-host/routes/sessions.ts`, `fs.ts`, `me.ts`, `http.ts`, `app.ts`
- `/packages/server/src/fs/sandbox.ts`, `list.ts`

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

에이전트 종류와 무관한 서버 코어를 확장한다: 어댑터 인터페이스(사용량 이벤트, 모델/effort 변경, 모델 목록, 한도 조회), SessionManager의 누적·영속·이벤트, 새 라우트(`/fs/mkdir`, `/usage`, `/models`, PATCH model/effort), Fake 어댑터 지원. 실제 Claude/Codex 구현은 step 2, 3.

### 1. 어댑터 인터페이스 (`src/agents/types.ts`)

```ts
export interface TokenDelta { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd?: number }
export interface ContextSnapshot { tokens: number; window: number }
export type AgentEvent = /* 기존 */ | {
  type: 'usage';
  delta?: TokenDelta;                 // 이번 관측에서 늘어난 양(턴별). 없으면 컨텍스트만 갱신
  context?: ContextSnapshot | null;   // 마지막 턴 기준. null 이면 "모름"으로 덮어씀, undefined 면 유지
  model?: string;                     // 어댑터가 확정한 현재 모델(있을 때만)
  effort?: string;
};
export interface RateLimitObservation { id: string; usedPercent: number; windowMinutes: number | null; resetsAt: Date | null; rejected?: boolean }
export interface AgentUsageSnapshot { plan: string | null; live: boolean; observedAt: Date | null; limits: RateLimitObservation[] }
export interface AgentModel { id: string; displayName: string; description: string | null; isDefault: boolean; efforts: string[]; defaultEffort: string | null }

export interface AgentSession {
  /* 기존 */
  setModel(model: string): Promise<void>;
  setEffort(effort: string): Promise<void>;
}
export interface AgentAdapter {
  /* 기존 */
  listModels(): Promise<AgentModel[]>;
  usage(): Promise<AgentUsageSnapshot>;    // 구독 한도. 관측값 없으면 limits []
}
```

### 2. 한도 저장소 `src/usage/rate-limit-store.ts`

`RateLimitStore(dataDir)`: `save(kind, snapshot)` → `~/.mam/usage/<kind>.json`(원자적), `load(kind)`. Claude 어댑터(step 2)가 관측할 때마다 저장하고, `usage()`가 읽는다. Codex는 즉시 조회하므로 캐시 용도(60초).

### 3. SessionManager

- `Session.usage`(nullable) 누적 규칙: `usage` 이벤트의 `delta`를 더한다(`costUsd`는 delta가 있을 때만 더하고, 어댑터가 한 번도 cost를 주지 않았으면 `null` 유지). `context`는 마지막 값으로 교체(`{tokens, window}` → `percent = round(tokens/window*100)`, 100 초과는 100으로 클램프). `turns`는 `turn.completed`마다 +1. `updatedAt` 갱신. `model`/`effort`가 오면 Session에 반영.
- 누적 후 `session.usage` 이벤트(seq 부여, 로그, 팬아웃). 같은 턴 안에서 Codex가 여러 번 보내도 매번 발행하되 300ms 안에 연속 오면 마지막 것만 발행(디바운스).
- 영속화: `sessions/<id>.json`에 `usage`, `effort` 포함. `open()` 시 복구.
- `patch(id, { model, effort })`: 값을 Session에 저장하고 라이브 어댑터 세션이 있으면 `setModel/setEffort` 호출. 없으면(유휴 종료 상태) 다음 `start`의 `StartOptions.model/effort`로 전달한다(`StartOptions`에 `effort?: string` 추가).
- 유효성: `model`/`effort`가 `adapter.listModels()` 결과에 없으면 `MamError('invalid_request', ...)`(400). 목록 조회 실패 시 검증을 건너뛰고 경고 로그.

### 4. 라우트

- `PATCH /api/v1/sessions/:id`: 기존 title/mode에 `model`, `effort` 추가.
- `POST /api/v1/fs/mkdir` (`routes/fs.ts`): `resolveInsideHome` → 존재하면 409 `conflict` → 세그먼트 검증(빈 값, 제어 문자 → 400) → `fs.mkdir(recursive: true, mode 0o755)` → `listDirectory`와 같은 방식으로 `FsEntry`를 만들어 201 `{ entry }`. 구현은 `src/fs/mkdir.ts`에 순수 함수 `makeDirectory(home, path)`.
- `GET /api/v1/usage` (`routes/usage.ts`): 각 어댑터 `usage()`를 병렬 호출(개별 실패는 `limits: []`로), `status` 계산(ok/warning/exceeded, `rejected`면 exceeded), `resetsAt`은 ISO 문자열로. 응답은 `UsageResponseSchema`.
- `GET /api/v1/models?agent=` (`routes/models.ts`): `adapter.listModels()` → `ModelsResponseSchema`. 5분 캐시.
- `GET /me`는 그대로.

### 5. Fake 어댑터

- 스크립트 턴이 끝날 때 `usage` 이벤트: `delta { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 800, cacheWriteTokens: 100, costUsd: 0.012 }`, `context { tokens: 4200 + 턴수*900, window: 200000 }`, `model: 'fake-1'`.
- `listModels()`: `fake-1`(기본, efforts low/medium/high), `fake-mini`(efforts []). `setModel/setEffort`는 기록만 하고 다음 usage 이벤트의 `model/effort`에 반영.
- `usage()`: `plan: 'fake'`, `live: true`, 한도 2개(`five_hour` 42%, `seven_day` 81% → warning).

### 6. 테스트

- `test/sessions/manager-usage.test.ts`: 누적·컨텍스트 교체·percent 클램프·turns 증가·cost null 유지·이벤트 발행·디바운스·재시작 복구·patch model/effort의 라이브/유휴 두 경로·잘못된 모델 400.
- `test/fs/mkdir.test.ts`: 홈 밖 403, 존재 409, 부모 생성, 잘못된 이름 400, 반환 FsEntry.
- `test/agent-host/rest.test.ts` 확장: `POST /fs/mkdir`, `GET /usage`(status 계산), `GET /models`, `PATCH model/effort`, `/sessions` 응답에 `usage`/`effort`가 스키마 검증을 통과.
- `test/agent-host/ws.test.ts` 확장: 턴 완료 후 `session.usage` 수신과 `since` 재생.

## Acceptance Criteria

```bash
npm ci
npm run typecheck
npm test
bash scripts/dev-smoke.sh          # 기존 e2e 가 그대로 통과 (Fake 가 usage 를 내도 순서 검증이 깨지지 않아야 함. 깨지면 dev-smoke.mjs 를 최소 수정)
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - seq 발급이 여전히 SessionManager에만 있는가(CRITICAL 7)? 파일 생성이 `resolveInsideHome`을 거치는가(CRITICAL 3)?
   - 응답이 `@mam/protocol` 스키마를 통과하는가(개발 모드 응답 검증)?
   - 어댑터 인터페이스 변경이 Claude/Codex 어댑터의 컴파일을 깨뜨리지 않는가? (깨지면 최소한의 스텁 구현을 넣고 step 2, 3이 채운다고 summary에 적어라: `listModels() → []`, `usage() → { plan: null, live: false, observedAt: null, limits: [] }`, `setModel/setEffort → 저장만`)
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- 파일 삭제·이름 변경·쓰기 API를 추가하지 마라. 이유: 이번 요구는 디렉토리 생성뿐이다.
- Claude/Codex 어댑터의 실제 사용량 로직을 구현하지 마라(step 2, 3). 컴파일용 스텁까지만.
- `packages/protocol`을 수정하지 마라. 필요하면 `needs_input`.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
