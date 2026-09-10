# Step 4: ios-models-client

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/PROTOCOL.md` (2026-09-10 추가분)
- `/docs/IOS.md` (9절 2차 추가분)
- `/packages/protocol/fixtures/**` (step 0이 추가·갱신한 fixture: `rest/usage*.json`, `rest/models-*.json`, `rest/fs-mkdir.json`, `ws/session.usage.json`, 갱신된 session fixture)
- `/packages/protocol/src/session.ts`, `rest.ts`, `ws.ts`
- `/ios/MacAgent/Models/Protocol/*.swift`, `/ios/MacAgentTests/ProtocolFixturesTests.swift` (Phase 1 step 1)
- `/ios/MacAgent/Networking/APIClient.swift`, `/ios/MacAgentTests/Networking/APIClientTests.swift` (Phase 1 step 2)

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

Swift 모델과 API 클라이언트를 새 계약에 맞춘다. UI는 없다.

### 1. 모델 (`ios/MacAgent/Models/Protocol/`)

- `Session`에 `effort: String?`, `usage: SessionUsage?` 추가. `SessionUsage { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: Int; costUsd: Double?; turns: Int; context: ContextUsage?; updatedAt: Date }`, `ContextUsage { tokens: Int; window: Int; percent: Int }`.
- `PatchSessionRequest`에 `model: String?`, `effort: String?`.
- `Usage`(턴별)에 `cacheWriteTokens: Int?`.
- `ServerEvent`에 `.sessionUsage(SessionUsageEvent)` 케이스(`type == "session.usage"`).
- REST: `FsMkdirRequest { path }`, `FsMkdirResponse { entry: FsEntry }`, `UsageLimit { id, label, usedPercent: Int, windowMinutes: Int?, resetsAt: Date?, status: UsageLimitStatus(lenient: ok/warning/exceeded/unknown) }`, `AgentUsage { kind: AgentKind, plan: String?, live: Bool, observedAt: Date?, limits: [UsageLimit] }`, `UsageResponse { agents }`, `ModelOption { id, displayName, description: String?, isDefault: Bool, efforts: [String], defaultEffort: String? }`, `ModelsResponse { models }`.
- 기존 규칙 유지: 판별자 엄격, 나머지 lenient, nullable/optional은 `decodeIfPresent`.

### 2. 클라이언트 (`Networking/APIClient.swift`)

```swift
func makeDirectory(path: String) async throws -> FsEntry            // POST /fs/mkdir
func usage() async throws -> UsageResponse                          // GET /usage
func models(agent: AgentKind) async throws -> [ModelOption]         // GET /models?agent=
func patchSession(id:_:)                                            // 기존, model/effort 포함해 인코딩
```

`APIError.server(code: .conflict)`를 409에 매핑(이미 있으면 확인).

### 3. 테스트

- `ProtocolFixturesTests`의 매핑표에 새 fixture 추가(`rest/usage.json`, `rest/usage-empty.json`, `rest/models-claude.json`, `rest/models-codex.json`, `rest/fs-mkdir.json`, `ws/session.usage.json`). 폴더 전수 검사 규칙이 그대로 동작(누락 시 실패).
- 단언: 갱신된 `rest/session.json`의 `usage.context.percent == 21`, `rest/sessions.json`의 두 번째 세션 `usage == nil`, `ws/session.usage.json`이 `.sessionUsage`로 디코드, `UsageLimit.status` 미지 값 → `.unknown`.
- `APIClientTests`: `makeDirectory` 요청 본문과 201 디코드, 409 → `.server(code: .conflict)`, `usage()`·`models(agent:)` 쿼리와 디코드, `patchSession`의 `model/effort` 인코딩(빈 필드는 키 생략).

## Acceptance Criteria

```bash
cd ios && xcodegen generate --quiet && xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet test && cd ..
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 새 fixture 전부가 디코딩되고 TS 쪽 매핑표와 파일 집합이 같은가?
   - 판별자 엄격/나머지 lenient 규칙을 유지했는가?
   - `docs/PROTOCOL.md`의 nullable/optional 구분을 그대로 옮겼는가?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- UI 코드를 넣지 마라(step 5, 6).
- `packages/protocol`의 fixture나 스키마를 수정하지 마라. 어긋나면 `needs_input`.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
