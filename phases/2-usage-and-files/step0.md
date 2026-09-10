# Step 0: protocol-additions

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md` (CRITICAL 5: 프로토콜 변경은 fixture부터)
- `/docs/PROTOCOL.md` (2026-09-10 추가분: `Session.usage/effort`, `PATCH /sessions/:id`의 `model/effort`, `POST /fs/mkdir`, `GET /usage`, `GET /models`, WS `session.usage`, 5절 어댑터 사용량 산출식)
- `/docs/ADR.md` (ADR-016)
- `/packages/protocol/src/*.ts`, `/packages/protocol/fixtures/**`, `/packages/protocol/test/fixtures.test.ts` (Phase 0 step 1의 산출물. 같은 규칙으로 확장한다)

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

`docs/PROTOCOL.md`에 이미 적힌 2026-09-10 추가분을 `@mam/protocol`의 zod 스키마와 fixture로 옮긴다. **전부 추가(additive)이고 기존 필드의 의미는 바꾸지 않는다.** 서버·iOS는 이 step의 산출물을 기준으로 뒤따른다.

### 1. 스키마 (`packages/protocol/src/`)

- `session.ts`
  - `SessionUsageSchema`: `inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens`(정수 ≥0), `costUsd`(number ≥0, nullable), `turns`(정수 ≥0), `context`(`{ tokens: int≥0, window: int>0, percent: int 0~100 }` nullable), `updatedAt`(IsoDate).
  - `SessionSchema`에 `effort: z.string().nullable()`, `usage: SessionUsageSchema.nullable()` 추가. `model`은 그대로.
  - `PatchSessionRequestSchema`에 `model?: string(min 1)`, `effort?: string(min 1)` 추가.
  - 기존 `UsageSchema`(턴별, `turn.completed`용)는 그대로 두되 `cacheWriteTokens?` optional 필드를 추가한다.
- `rest.ts`
  - `FsMkdirRequestSchema { path }`, `FsMkdirResponseSchema { entry: FsEntry }`.
  - `UsageLimitSchema { id: string, label: string, usedPercent: int 0~(상한 없음, 100 초과 허용), windowMinutes: int nullable, resetsAt: IsoDate nullable, status: 'ok'|'warning'|'exceeded' }`, `AgentUsageSchema { kind: AgentKind, plan: string nullable, live: boolean, observedAt: IsoDate nullable, limits: UsageLimit[] }`, `UsageResponseSchema { agents: AgentUsage[] }`.
  - `ModelOptionSchema { id, displayName, description: nullable, isDefault: boolean, efforts: string[], defaultEffort: string nullable }`, `ModelsResponseSchema { models: ModelOption[] }`, `ModelsQuerySchema { agent: AgentKind }`.
- `ws.ts`: `SessionUsageEventSchema` (`type: 'session.usage'`, 공통 필드 `seq/sessionId/ts`, `usage: SessionUsageSchema`)를 `ServerEventSchema` 유니온과 `ServerEventType`에 추가.
- `index.ts`: 새 스키마와 타입(`SessionUsage`, `UsageLimit`, `AgentUsage`, `UsageResponse`, `ModelOption`, `ModelsResponse`, `FsMkdirRequest`, `FsMkdirResponse`, `SessionUsageEvent`) export.

### 2. fixtures (`packages/protocol/fixtures/`)

- 갱신: `rest/session.json`, `rest/sessions.json`, `rest/session-detail.json`, `ws/session.snapshot.json`의 Session에 `effort`와 `usage`를 채운다(문서 예시 값). 최소 하나의 Session은 `usage: null, effort: null`(첫 턴 전)로 둔다(`rest/sessions.json`의 두 번째 항목).
- 추가: `rest/usage.json`(문서 예시 그대로, claude `live:false` + codex `live:true`, status ok/warning 섞기), `rest/usage-empty.json`(`limits: []`, `observedAt: null`), `rest/models-claude.json`, `rest/models-codex.json`, `rest/fs-mkdir.json`(`{ entry }`), `ws/session.usage.json`, `client/`에는 추가 없음(PATCH는 REST).
- `test/fixtures.test.ts`의 매핑표에 새 파일을 추가한다. 매핑에 없는 파일이 있으면 실패하는 규칙이 그대로 동작해야 한다.

### 3. 테스트

- 기존 `schemas.test.ts`에 음성 케이스 추가: `usage.context.percent` 101 거부, `usedPercent` 음수 거부, `status` 오타 거부, `session.usage` 이벤트에 `usage` 누락 시 거부, `PATCH`에 빈 문자열 `model` 거부.
- 라운드트립: 새 fixture 전부 parse → JSON → parse 무손실.

### 4. 문서

`docs/PROTOCOL.md`는 이미 갱신되어 있다. 스키마를 만들다 문서와 어긋나는 점을 발견하면 **문서를 고치지 말고** `needs_input`으로 보고하라(문서가 계약의 원본이다). 단, 오타 수준은 문서를 고치고 summary에 적어라.

## Acceptance Criteria

```bash
npm ci
npm run typecheck
npm test
ls packages/protocol/fixtures/rest packages/protocol/fixtures/ws packages/protocol/fixtures/client | grep -c json   # 46 이상
grep -q "session.usage" packages/protocol/src/ws.ts && grep -q "SessionUsageSchema" packages/protocol/src/session.ts
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - `docs/PROTOCOL.md`의 추가분 전부에 스키마와 fixture가 있는가? 기존 fixture의 기존 필드는 그대로인가?
   - 추가만 있고 필수 필드 삭제·의미 변경이 없는가(구 클라이언트 호환)?
   - `CLAUDE.md` CRITICAL 5를 지켰는가?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- `packages/server`, `ios/`를 수정하지 마라. 이유: 이 step은 계약만 바꾼다. 서버 테스트가 새 필수 필드 때문에 깨지는지 확인은 하되(`npm test`), 깨지면 스키마를 optional/nullable로 조정하는 쪽으로 해결하라. `Session.usage`와 `effort`는 nullable이므로 서버가 아직 안 채워도 통과해야 한다.
- 기존 이벤트나 필드를 제거·개명하지 마라.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
