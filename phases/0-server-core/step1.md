# Step 1: protocol-schemas

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/PROTOCOL.md` (전체. 이 step의 명세다)
- `/docs/ARCHITECTURE.md` (8절 테스트 전략의 "계약" 항목)
- `/docs/ADR.md` (ADR-009 정규화 이벤트 모델과 fixture 계약)
- `/packages/protocol/` (step 0이 만든 뼈대), `/package.json`, `/tsconfig.base.json`

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

`@mam/protocol`에 `docs/PROTOCOL.md`의 모든 모델을 zod 4 스키마로 정의하고, 예시 JSON fixture를 만들고, fixture가 스키마를 통과하는지 테스트한다. 이 패키지는 서버와 웹이 import하고, iOS는 fixture 파일을 디코딩 테스트에 쓴다. **문서·fixture·스키마 셋이 어긋나면 안 된다.** 문서와 다르게 만들고 싶은 부분이 생기면 임의로 바꾸지 말고 문서를 따르되, 문서의 명백한 오류라면 문서도 같이 고치고 summary에 적어라.

### 파일 구성 (`packages/protocol/src/`)

- `common.ts`: `AgentKindSchema`(`'claude' | 'codex'`), `SessionModeSchema`, `SessionStatusSchema`, `ItemStatusSchema`, `IsoDateSchema`(문자열, ISO-8601 검증), ID 접두어 유틸 `idSchema(prefix)`(예: `ses_` + 26자 ULID), `ErrorResponseSchema` (`{ error: { code, message } }`, code enum은 PROTOCOL 0절), `PROTOCOL_VERSION`.
- `timeline.ts`: 10개 kind 각각의 payload 스키마와 `TimelineItemSchema`(kind로 구분되는 discriminated union, 공통 필드 `id, seq, turnId, kind, status, createdAt, completedAt, payload`). `ToolNameSchema`(`bash|read|write|edit|glob|grep|web|mcp|task|other`).
- `approval.ts`: `ApprovalOptionSchema`, `InputFieldSchema`, `ApprovalSchema`, `ApprovalResolutionSchema`, `ApprovalKindSchema`.
- `session.ts`: `SessionSchema`, `CreateSessionRequestSchema`, `PatchSessionRequestSchema`, `TurnInputSchema`(text + attachments), `UsageSchema`.
- `rest.ts`: `MeResponseSchema`, `ProjectsResponseSchema`, `SessionsResponseSchema`, `SessionDetailResponseSchema`, `FsListResponseSchema`, `FsEntrySchema`, `FsReadResponseSchema`, `GitStatusResponseSchema`, `GitDiffResponseSchema`, `LoginStartResponseSchema`, `LoginStatusResponseSchema`, `LoginCodeRequestSchema`, `ApprovalRespondRequestSchema`.
- `ws.ts`: `ServerEventSchema`(type으로 구분되는 union: `session.snapshot, item.started, item.delta, item.completed, approval.requested, approval.resolved, session.status, turn.completed, error, pong`), `ClientMessageSchema`(`turn.start, turn.interrupt, approval.respond, session.setMode, ping`), 공통 필드(`seq, sessionId, ts`) 포함.
- `index.ts`: 전부 re-export + 타입(`z.infer`)을 같은 이름의 `type`으로 export (`Session`, `TimelineItem`, `ServerEvent`, `ClientMessage`, `Approval` 등) + `parseServerEvent(input: unknown): ServerEvent`, `parseClientMessage(input: unknown): ClientMessage`, `safeParseClientMessage`.

규칙:

- 알 수 없는 키는 **거부하지 않는다**(`.passthrough()` 대신 기본 strip 동작). 이유: 서버가 필드를 추가해도 구 클라이언트가 깨지지 않아야 한다. 단 discriminator(`kind`, `type`)가 모르는 값이면 실패한다.
- `seq`는 0 이상의 정수. `session.snapshot`과 `pong`은 `seq: 0`.
- 날짜는 문자열 그대로 두고 Date로 변환하지 않는다(클라이언트 언어별 처리).

### fixtures (`packages/protocol/fixtures/`)

파일명 규칙 `rest/<name>.json`, `ws/<type>[.<variant>].json`, `client/<type>.json`. 최소 목록:

- rest: `me`, `projects`, `sessions`, `session`, `session-detail`(items 5개 이상, kind 다양하게), `fs-list`(dir/file/symlink, gitStatus 값 섞어서), `fs-read-text`, `fs-read-image`(base64 짧게), `git-status`, `git-diff`, `error`, `login-start`, `login-status`
- ws: `session.snapshot`, `item.started.user_message`, `item.started.assistant_message`, `item.started.reasoning`, `item.started.tool_call`, `item.started.file_change`, `item.started.plan`, `item.started.approval`, `item.started.turn_summary`, `item.started.error`, `item.started.system`, `item.delta`, `item.completed.tool_call`, `approval.requested.command`, `approval.requested.file_change`, `approval.requested.permission`, `approval.requested.user_input`, `approval.resolved`, `session.status`, `turn.completed`, `error`, `pong`
- client: `turn.start`, `turn.interrupt`, `approval.respond`, `session.setMode`, `ping`

fixture 값은 `docs/PROTOCOL.md`의 예시와 일관되게, 한국어 라벨(`허용`, `거절`, `이 세션에서 항상 허용`)을 그대로 쓴다. 경로는 `/Users/alice/work/app` 기준.

### 테스트 (`packages/protocol/test/`)

- `fixtures.test.ts`: fixture 디렉토리를 순회해 파일명 → 스키마 매핑 테이블로 전부 `parse`한다. 매핑에 없는 fixture 파일이 있으면 테스트 실패(누락 방지).
- `schemas.test.ts`: 대표 음성 케이스(모르는 `kind`, 음수 `seq`, 잘못된 `mode`, `error.code` 오타)가 실패하는지. `parseClientMessage`가 `turn.start`의 빈 text를 거부하는지(최소 1자).
- `index.test.ts`: export 목록이 존재하는지(타입 레벨은 tsc가 검증).

## Acceptance Criteria

```bash
npm ci
npm run typecheck
npm test                                  # fixture 전수 검증 포함
ls packages/protocol/fixtures/rest packages/protocol/fixtures/ws packages/protocol/fixtures/client | wc -l   # 40 이상
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - `docs/PROTOCOL.md`의 모든 엔드포인트 응답과 이벤트 타입에 스키마와 fixture가 있는가?
   - `docs/ADR.md` ADR-009를 따르는가(`payload.raw` 같은 원본 이벤트 필드가 없는가)?
   - `CLAUDE.md` CRITICAL 규칙 5(프로토콜 변경은 fixture부터)를 지켰는가?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- `packages/server`를 수정하지 마라. 이유: 이 step은 protocol 패키지만 다룬다. 서버 쪽 사용은 step 2 이후다.
- 스키마에 서버 전용 필드(내부 PID, 소켓 경로 등)를 넣지 마라. 이유: 이 패키지는 클라이언트에 노출되는 계약이다.
- 새 런타임 의존성을 추가하지 마라(zod만). 이유: 웹 번들과 병렬 워크트리 충돌 방지.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
