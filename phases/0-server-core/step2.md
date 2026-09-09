# Step 2: session-manager

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/ARCHITECTURE.md` (2.3 에이전트 어댑터, 2.4 SessionManager, 7절 데이터 흐름)
- `/docs/PROTOCOL.md` (2절 WebSocket, 3절 TimelineItem)
- `/docs/ADR.md` (ADR-009, ADR-010)
- `/packages/protocol/src/*.ts` (step 1의 스키마. 여기 정의된 타입을 import해서 쓴다)
- `/packages/server/` (step 0 뼈대)

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

에이전트 종류와 무관한 세션 코어를 만든다. 어댑터 인터페이스, 테스트용 Fake 어댑터, 그리고 SessionManager(레지스트리·seq·이벤트 로그·팬아웃·승인 대기·상태기계·유휴 종료)다. HTTP는 이 step에 없다(step 4).

### 1. 어댑터 인터페이스 `packages/server/src/agents/types.ts`

```ts
import type { Approval, SessionMode, SessionStatus, TimelineItem, TurnInput, Usage } from '@mam/protocol';

export type AgentKind = 'claude' | 'codex';
export interface AgentProbe { available: boolean; version?: string; loggedIn: boolean; account?: string | null; binPath?: string; detail?: string }
export interface StartOptions { cwd: string; mode: SessionMode; model?: string; resumeNativeId?: string }

/** 어댑터 → 매니저. seq/sessionId/ts 없음. 매니저가 붙인다. */
export type ItemDraft = Omit<TimelineItem, 'seq'>;
export type AgentEvent =
  | { type: 'native_id'; nativeId: string }
  | { type: 'item.started'; item: ItemDraft }
  | { type: 'item.delta'; itemId: string; field: 'text' | 'output' | 'patch'; delta: string }
  | { type: 'item.completed'; item: ItemDraft }
  | { type: 'approval.requested'; approval: Approval }
  | { type: 'status'; status: SessionStatus; reason?: string }
  | { type: 'turn.completed'; turnId: string; durationMs: number; usage: Usage; costUsd?: number; stopReason: string }
  | { type: 'error'; message: string; recoverable: boolean };

export interface AgentSession {
  readonly nativeId: string | undefined;
  readonly events: AsyncIterable<AgentEvent>;
  sendTurn(input: TurnInput): Promise<void>;
  interrupt(): Promise<void>;
  respondApproval(approvalId: string, optionId: string, inputs?: Record<string, string>, message?: string): Promise<void>;
  setMode(mode: SessionMode): Promise<void>;
  close(): Promise<void>;
}
export interface AgentAdapter { readonly kind: AgentKind; probe(): Promise<AgentProbe>; start(opts: StartOptions): Promise<AgentSession> }
```

- 아이템 ID(`itm_`)와 승인 ID(`apr_`), 턴 ID(`trn_`)는 **어댑터가** 만든다. 공용 유틸 `packages/server/src/ids.ts`에 `newId(prefix: 'ses'|'itm'|'apr'|'trn'|'flw'): string` (ULID)을 둔다.
- seq는 **매니저만** 발급한다(CLAUDE.md CRITICAL 7).

### 2. Fake 어댑터 `packages/server/src/agents/fake/`

`FakeAdapter(options)`: 테스트와 개발 스모크가 쓴다.

- 각 `sendTurn`마다 스크립트된 응답을 재생한다. 기본 스크립트: `user_message` 아이템 → `assistant_message`(3조각 delta 후 completed) → `tool_call(bash, "echo hi")` → **승인 요청**(`kind: command`, options allow/allow_session/deny) → 응답이 오면 tool_call completed(output "hi") → `turn_summary` + `turn.completed` → status idle. `deny`면 tool_call `failed`, `abort`면 턴 중단.
- 옵션으로 승인 없이 진행(`autoApprove: true`), 지연(ms), 커스텀 스크립트 함수 주입을 지원한다.
- `interrupt()`는 진행 중인 재생을 멈추고 `status idle`을 낸다. `resumeNativeId`가 오면 `nativeId`를 그대로 쓴다. 텍스트에 `"fail"`이 포함되면 `error` 이벤트를 낸다(에러 경로 테스트용).

### 3. 이벤트 로그 `packages/server/src/sessions/event-log.ts`

`EventLog(filePath)`: `append(event: ServerEvent): Promise<void>` (JSON 한 줄, `fs.appendFile`), `readSince(seq: number): AsyncIterable<ServerEvent>`, `tail(n): Promise<ServerEvent[]>`. 파일이 없으면 빈 결과. 손상된 줄은 건너뛰고 경고 로그.

### 4. SessionManager `packages/server/src/sessions/manager.ts`

```ts
export interface SessionManagerOptions {
  dataDir: string;                                  // ~/.mam
  adapters: Partial<Record<AgentKind, AgentAdapter>>;
  idleTimeoutMs?: number;                           // 기본 30분
  ringBufferSize?: number;                          // 기본 500
  now?: () => Date;                                 // 테스트 주입
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}
export class SessionManager {
  static async open(opts: SessionManagerOptions): Promise<SessionManager>;   // dataDir/sessions/*.json 로드
  list(filter?: { cwd?: string; status?: SessionStatus }): Session[];
  get(id: string): Session | undefined;
  create(req: CreateSessionRequest): Promise<Session>;                        // 어댑터 start까지 수행, status starting→idle
  patch(id: string, patch: PatchSessionRequest): Promise<Session>;
  close(id: string): Promise<Session>;
  detail(id: string, limit?: number): Promise<{ session: Session; items: TimelineItem[]; truncated: boolean }>;
  subscribe(id: string, since: number, listener: (ev: ServerEvent) => void): Promise<() => void>;  // since 이후 재생 후 라이브
  startTurn(id: string, input: TurnInput): Promise<void>;                      // running 중이면 SessionBusyError
  interrupt(id: string): Promise<void>;
  respondApproval(id: string, approvalId: string, optionId: string, inputs?: Record<string,string>, message?: string): Promise<void>;
  setMode(id: string, mode: SessionMode): Promise<void>;
  pendingApprovals(id: string): Approval[];
  shutdown(): Promise<void>;
}
```

핵심 규칙:

- 어댑터 이벤트를 받으면 `seq`(세션별 단조 증가, 재시작 후에도 `lastSeq`에서 이어짐), `sessionId`, `ts`를 붙여 `ServerEvent`로 변환 → 링버퍼 push → `EventLog.append` → 구독자 전부에게 동기 팬아웃. 순서: 로그 append가 실패해도 팬아웃은 한다(경고 로그).
- `item.started/completed`는 세션의 **아이템 인덱스**(id → 최신 아이템)도 갱신해 `detail()`이 최종 상태를 돌려준다. `item.delta`는 인덱스의 해당 필드에 append한다.
- 승인: `approval.requested`를 `pending` 맵에 넣고 상태를 `waiting_approval`로. `respondApproval`은 첫 응답만 어댑터에 전달하고 `approval.resolved{by:'client'}`를 발행한 뒤 `running`으로. 두 번째 응답은 `ApprovalAlreadyResolvedError`. **자동 만료는 없다**(사용자가 올 때까지 무한 대기. 이유: 이동 중 사용자를 위한 제품이다).
- 상태기계는 ARCHITECTURE 2.4. 어댑터가 `status`를 보내지 않아도 `turn.start`→`running`, `turn.completed`→`idle`, `approval.requested`→`waiting_approval`은 매니저가 전이시킨다. `status` 전이마다 `session.status` 이벤트 1개.
- `create`는 `cwd`가 존재하는 디렉토리인지 확인한다(홈 검사는 step 4의 HTTP 계층이 한다). 어댑터가 없으면 `AgentUnavailableError`.
- 유휴 종료: 마지막 이벤트 후 `idleTimeoutMs`가 지나고 구독자가 0이면 어댑터 세션을 `close()`하고 `session.status{status:'idle', reason:'idle_timeout'}`을 로그에 남긴다(상태는 idle 유지). 이후 `startTurn`은 `resumeNativeId: nativeId`로 어댑터를 다시 `start`한다. 타이머는 `now` 주입과 vitest fake timers로 테스트 가능해야 한다.
- 영속화: `dataDir/sessions/<id>.json`에 Session 메타를 변경 때마다 원자적으로 쓴다(tmp 파일 후 rename). `open()` 시 로드하고, 프로세스가 죽었던 세션은 `closed`가 아니면 `idle`로 둔다.
- 오류 클래스는 `packages/server/src/errors.ts`에 `MamError(code, message, status)` 하나와 `code`별 서브클래스. `code`는 PROTOCOL 0절 값과 일치.

### 5. 테스트 (`packages/server/test/sessions/`)

- 생성 → 턴 → 승인 → 완료까지 이벤트 시퀀스와 seq 연속성.
- 구독자 2개 팬아웃, 늦게 붙은 구독자의 `since` 재생(링버퍼 안/밖 두 경우, 밖은 파일에서).
- 승인 first-wins, 두 번째 응답 오류, deny/abort 경로.
- 재시작: 같은 `dataDir`로 새 매니저를 열면 세션 목록과 `detail()`이 복구되고 다음 seq가 이어진다.
- 유휴 종료 후 `startTurn`이 `resumeNativeId`로 재시작한다(Fake 어댑터가 받은 옵션으로 검증).
- `startTurn` 중복 호출 → `SessionBusyError`.

## Acceptance Criteria

```bash
npm ci
npm run typecheck
npm test
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - `docs/ARCHITECTURE.md` 2.4의 상태기계와 유휴 종료 규칙을 따르는가?
   - seq를 어댑터가 만들지 않는가(CRITICAL 7)? 이벤트 스키마는 `@mam/protocol`의 것을 그대로 쓰는가?
   - 파일 쓰기가 `dataDir` 아래에만 일어나는가?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- Claude/Codex 실제 어댑터를 만들지 마라. 이유: step 5, 6의 범위다. 이 step은 Fake만 쓴다.
- HTTP/WebSocket 코드를 넣지 마라. 이유: step 4의 범위다. 매니저는 순수 로직이어야 테스트가 빠르다.
- `@mam/protocol` 스키마를 수정하지 마라. 필요하면 `needs_input`으로 보고하라. 이유: 계약 변경은 fixture부터 시작해야 한다(CRITICAL 5).
- 새 런타임 의존성을 추가하지 마라. 이유: step 0이 전부 설치했다. 부족하면 summary에 적고 `needs_input`.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
