# Step 1: api-models

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/PROTOCOL.md` (전체. 0절의 "알 수 없는 키"와 "`null`" 규칙, 3절 TimelineItem, 2절 이벤트)
- `/docs/IOS.md` (2절, 3절, 8절 계약 테스트)
- `/packages/protocol/src/*.ts` (zod 스키마. Swift 모델은 이것의 미러다. 특히 nullable/optional 구분)
- `/packages/protocol/fixtures/**/*.json` (40개 전부. 테스트가 전수 디코딩한다)
- `/packages/protocol/test/fixtures.test.ts` (파일명 → 스키마 매핑표. Swift 테스트도 같은 표를 가진다)
- `/ios/project.yml`, `/ios/MacAgentTests/SmokeTests.swift` (step 0)

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

`docs/PROTOCOL.md` 전체를 Swift `Codable` 모델로 옮기고, 40개 fixture를 전수 디코딩하는 계약 테스트를 만든다. UI나 네트워킹은 없다.

### 1. 파일 (`ios/MacAgent/Models/Protocol/`)

- `JSONCoding.swift`: `enum JSONCoding { static let decoder: JSONDecoder; static let encoder: JSONEncoder }`. 날짜는 `.custom`으로 ISO-8601을 소수점 초 있음/없음 둘 다 받는다(`ISO8601DateFormatter` 두 개). 인코더는 소수점 초 포함 ISO-8601, 키 정렬(`.sortedKeys`) 없이.
- `LenientEnum.swift`: `protocol LenientRawEnum: RawRepresentable, Codable, CaseIterable where RawValue == String { static var unknown: Self { get } }` + 기본 구현 `init(from:)`이 모르는 문자열을 `.unknown`으로 디코드. 인코딩은 rawValue 그대로.
- `Enums.swift`: 판별자가 **아닌** 열거형은 전부 lenient(`unknown` 케이스 포함): `AgentKind`, `SessionMode`, `SessionStatus`, `ItemStatus`, `ToolName`, `ApprovalKind`, `ApprovalOptionStyle`, `ApprovalResolvedBy`, `FileChangeKind`, `PlanStepStatus`, `InputFieldType`, `AssistantMessagePhase`, `FsEntryType`, `GitStatusCode`, `LoginFlowStatus`, `ErrorCode`, `ItemDeltaField`. 이유: 서버가 값을 추가해도 구 앱이 크래시하지 않아야 한다(PROTOCOL 0절).
- `Session.swift`: `Session`, `CreateSessionRequest`, `PatchSessionRequest`, `Usage`, `Attachment`, `TurnInput`.
- `TimelineItem.swift`: `struct TimelineItem: Codable, Identifiable, Hashable { id, seq, turnId: String?, kind: TimelineItemKind, status, createdAt: Date, completedAt: Date?, payload: TimelinePayload }`. `TimelineItemKind`는 **엄격**(모르는 값이면 `DecodingError`). `TimelinePayload`는 kind별 연관값 enum(`.userMessage(UserMessagePayload)`, `.assistantMessage(...)`, `.reasoning`, `.toolCall(ToolCallPayload)`, `.fileChange`, `.plan`, `.approval(ApprovalPayload)`, `.turnSummary`, `.error`, `.system`). `init(from:)`은 `kind`를 먼저 읽고 `payload`를 해당 타입으로 디코드한다. `ToolCallPayload.input`은 임의 JSON이므로 `JSONValue` enum(`object/array/string/number/bool/null`)을 `Shared`가 아니라 여기 `JSONValue.swift`에 둔다.
- `Approval.swift`: `Approval`, `ApprovalOption`, `InputField`, `ApprovalResolution`, `ApprovalPayload`(= Approval 필드 + `resolution: ApprovalResolution?`).
- `ServerEvent.swift`: `enum ServerEvent: Decodable` — `type` 판별자 **엄격**. 케이스: `.sessionSnapshot(SessionSnapshotEvent)`, `.itemStarted(ItemEvent)`, `.itemDelta(ItemDeltaEvent)`, `.itemCompleted(ItemEvent)`, `.approvalRequested(ApprovalRequestedEvent)`, `.approvalResolved(ApprovalResolvedEvent)`, `.sessionStatus(SessionStatusEvent)`, `.turnCompleted(TurnCompletedEvent)`, `.error(ErrorEvent)`, `.pong(PongEvent)`. 모든 이벤트 구조체는 `seq: Int, sessionId: String, ts: Date`를 가진다. 편의 프로퍼티 `var seq: Int`, `var sessionId: String`.
- `ClientMessage.swift`: `enum ClientMessage: Codable` — `.turnStart(text:attachments:)`, `.turnInterrupt`, `.approvalRespond(approvalId:optionId:inputs:message:)`, `.sessionSetMode(mode:)`, `.ping`. `encode(to:)`는 `type` 키를 넣고 나머지 필드를 평탄하게 쓴다(fixture와 같은 모양). `init(from:)`도 구현해 왕복 테스트를 가능하게 한다.
- `REST.swift`: `MeResponse`, `AgentInfo`, `ServerInfo`, `Project`, `ProjectsResponse`, `SessionsResponse`, `SessionDetailResponse`, `FsEntry`, `FsListResponse`, `FsReadResponse`, `GitStatusEntry`, `GitStatusResponse`, `GitDiffResponse`, `LoginStartResponse`, `LoginStatusResponse`, `LoginCodeRequest`, `ApprovalRespondRequest`, `OkResponse`, `ErrorResponse`(`error.code: ErrorCode`, `error.message`).

규칙:

- PROTOCOL 0절의 nullable 필드는 Swift에서 `Optional`로 두되 `null`이 오면 nil, 키가 없어도 nil이 되게 `decodeIfPresent`를 쓴다. `?`가 붙은 optional 필드도 동일.
- 알 수 없는 키는 무시(기본 `Codable` 동작).
- 모델은 전부 `Sendable`, `Hashable`(`JSONValue` 포함).
- 이름은 wire와 같은 camelCase를 쓰므로 `keyDecodingStrategy` 변환은 쓰지 않는다.

### 2. 테스트 (`ios/MacAgentTests/`)

- `FixtureLoader.swift`: 번들의 `fixtures/` 폴더에서 상대 경로로 `Data`를 읽고, 폴더를 재귀 열거한다.
- `ProtocolFixturesTests.swift`:
  - 매핑표 `[String: (Data) throws -> Any]`: `rest/*.json` 13개는 각 응답 타입(`rest/session.json` → `Session`, `rest/error.json` → `ErrorResponse` 등), `ws/*.json` 22개는 전부 `ServerEvent`, `client/*.json` 5개는 `ClientMessage`.
  - 폴더의 모든 `.json`이 표에 있어야 한다(없으면 실패). 표의 모든 키가 폴더에 있어야 한다.
  - `client/*.json`은 디코드 → 인코드 → `JSONSerialization`으로 딕셔너리 비교해 fixture와 같아야 한다.
  - 핵심 값 단언: `ws/item.started.tool_call.json`의 `payload`가 `.toolCall`이고 `tool == .bash`; `ws/approval.requested.command.json`의 옵션 3개와 `style`; `ws/session.snapshot.json`의 `items`가 비어 있지 않음; `rest/fs-list.json`의 `gitStatus`에 nil과 값이 섞여 있음; 날짜가 `Date`로 파싱됨.
- `LenientEnumTests.swift`: 모르는 `tool` 값 → `.unknown`, 모르는 `kind` → throw, 모르는 `type` → throw, `null` 필드와 키 누락 모두 nil.

## Acceptance Criteria

```bash
cd ios && xcodegen generate --quiet && xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet test && cd ..
ls ios/MacAgent/Models/Protocol/*.swift | wc -l       # 8개 이상
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - `docs/PROTOCOL.md`의 모든 응답·이벤트·메시지에 대응 타입이 있고 fixture 40개가 전부 디코딩되는가?
   - 판별자(`kind`, `type`)는 엄격하고 나머지 열거형은 lenient한가?
   - `CLAUDE.md` CRITICAL 5(프로토콜 변경은 fixture부터)를 지켰는가? 이 step은 fixture와 스키마를 바꾸지 않는다.
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`. fixture가 문서와 어긋나 Swift 쪽에서 표현할 수 없으면 고치지 말고 `needs_input`으로 보고하라.

## 금지사항

- `packages/protocol`의 fixture나 스키마, `docs/PROTOCOL.md`를 수정하지 마라. 이유: 계약 변경은 TS → 서버 → iOS 순서의 별도 절차다.
- 코드 생성 도구(quicktype 등)나 새 패키지를 쓰지 마라. 모델은 손으로 쓴다(ADR-009).
- UI·네트워킹 코드를 넣지 마라. 이유: step 2, 3의 범위다.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
