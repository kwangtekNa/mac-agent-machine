# Step 4: dispatcher-core

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/PROTOCOL.md` 6.4 디스패치 규칙, 3절 TimelineItem(`assistant_message`, `tool_call`, `file_change`, `turn_summary`), `/docs/ADR.md` ADR-017
- `/packages/protocol/src/teams.ts`, `timeline.ts`
- `/packages/server/src/teams/types.ts`, `mentions.ts`, `room-manager.ts` (step 3)
- `/packages/server/test/teams/mentions.test.ts` (테스트 스타일)

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

디스패치의 **순수 로직** 세 모듈을 만든다: 라우팅·큐·홉(`dispatcher.ts`), 턴 입력 텍스트(`format.ts`), 답변·작업 요약 추출(`summary.ts`). I/O·세션·git 은 전혀 모른다. step 5 의 `TeamManager` 가 이 함수들을 조립한다.

### 확정된 결정

- 그룹방: 멘션된 팀원 각각. 멘션 없음 → 팀장. `@all` → 작성자 제외 전원. DM 방: 그 방의 팀원만(다른 멘션 무시). 작성자가 에이전트인 메시지에 멘션이 없으면 대상 없음(연쇄 종료). 자기 멘션 무시.
- 홉: 사용자 메시지 `hop 0`, 에이전트 답변에서 파생되면 `parent.hop + 1`, `hop > maxHops`(기본 6)이면 디스패치하지 않고 "홉 상한" 시스템 메시지 사유를 돌려준다.
- 큐: 팀별 FIFO, `maxConcurrent`(기본 2). 한 팀원은 동시에 하나만 실행. 이미 실행·대기 중인 팀원에게 온 새 트리거는 **합쳐진다**(대기 항목을 하나로 유지; 어차피 맥락에 누적됨). 같은 루트 디스패치 안에서 `(memberId, sourceMessageId)` 중복 제거.
- 맥락: 그룹방 + 자기 DM 방에서 `seq > lastSeen[roomId]` 인 메시지 전부, 상한 `contextMaxMessages`(기본 40) / 12,000자. 넘치면 오래된 것부터 버리고 `(이전 메시지 N개 생략)` 한 줄. 트리거 메시지는 항상 마지막.

### 1. `src/teams/dispatcher.ts`

```ts
export interface DispatchTarget { memberId: string; reason: "mention" | "lead" | "dm" | "all" }
export interface RouteInput { team: Pick<Team, "members">; room: Pick<Room, "kind" | "memberId">; author: RoomAuthor; mentions: MentionResult }
export function route(input: RouteInput): DispatchTarget[];

export interface DispatchItem { dispatchId: string; rootId: string; memberId: string; roomId: string; sourceMessageId: string; hop: number; enqueuedAt: string }
export interface RunningItem extends DispatchItem { sessionId: string; turnId: string | null; startedAt: string }
export class DispatchQueue {
  constructor(opts: { maxConcurrent: number; now?: () => Date; newId: (prefix: "dsp") => string });
  /** 합치기·중복 제거 후 큐에 넣는다. 합쳐졌으면 기존 항목을 돌려준다. */
  enqueue(input: Omit<DispatchItem, "dispatchId" | "enqueuedAt">): { item: DispatchItem; coalesced: boolean };
  /** 실행 가능한 다음 항목(맨 앞부터, 팀원이 실행 중이 아니고 running 수 < maxConcurrent). 없으면 null. */
  next(): DispatchItem | null;
  markRunning(dispatchId: string, sessionId: string): RunningItem;
  setTurn(dispatchId: string, turnId: string): void;
  markDone(dispatchId: string): void;
  clear(): DispatchItem[];                 // stop: 대기 항목 전부 제거
  isBusy(memberId: string): boolean;
  state(): DispatchState;
  setMaxConcurrent(n: number): void;
}
export function nextHop(parentHop: number | null): number;           // null → 0
export function hopExceeded(hop: number, maxHops: number): boolean;  // hop > maxHops
```

### 2. `src/teams/format.ts`

```ts
export interface FormatInput {
  member: Pick<TeamMember, "id" | "name" | "roleLabel">;
  members: Array<Pick<TeamMember, "id" | "name" | "roleLabel">>;
  rooms: Array<Pick<Room, "id" | "kind" | "name">>;
  context: RoomMessage[];          // seq > lastSeen 인 것들, 방 구분 없이 createdAt 순
  trigger: RoomMessage;            // 마지막에 놓인다(context 에 이미 있어도 중복 없이)
  maxMessages: number; maxChars: number;
  conflictNote?: string;           // step 6 이 넣는 worktree 충돌 안내(있으면 맨 앞)
}
export function formatMessageLine(message: RoomMessage, members, rooms): string;   // "[#전체] 사용자: …" / "[DM] 사용자: …" / "[#전체] @민수(개발자): …" / "[#전체] 시스템: …"
export function buildTurnText(input: FormatInput): { text: string; omitted: number };
```

- `kind: "approval"`/`"changes"` 메시지는 맥락에서 한 줄 요약으로 렌더(`[#전체] 시스템: 민수의 승인 요청 'npm test' — 허용됨` / `변경 준비됨: 3개 파일`). 도구 상세는 넣지 않는다.
- 꼬리말(영어 한 줄): `Reply for room #<name>. Address teammates with @name only when they must act.` DM 이면 `Reply in this DM.`
- 12,000자 상한은 렌더된 줄 기준으로 뒤에서부터 채운다.

### 3. `src/teams/summary.ts`

```ts
/** 해당 turnId 의 완료된 assistant_message 중 마지막(phase 'final' 우선, 없으면 마지막 텍스트). 빈 문자열이면 null. */
export function extractReply(items: TimelineItem[], turnId: string): string | null;
/** tool_call 수, file_change.files[].path 합집합(정렬), turn_summary 의 durationMs/usage/costUsd. turn_summary 가 없으면 durationMs 0, usage 0. */
export function summarizeWork(items: TimelineItem[], turnId: string): Omit<WorkSummary, "sessionId" | "turnId">;
```

### 4. 테스트

- `test/teams/dispatcher.test.ts`: 표 기반 `route`(그룹 멘션 1·2명, 멘션 없음 → 팀장, 팀장 없음 → 빈 배열, `@all` 작성자 제외, DM 은 그 팀원만, 에이전트 작성자 멘션 없음 → 빈 배열, 자기 멘션 제외); `DispatchQueue`(FIFO, `maxConcurrent 2` 로 세 번째는 대기, 같은 팀원 합치기 `coalesced: true`, 같은 루트 중복 제거, `markDone` 후 `next` 가 대기 항목을 꺼냄, `clear`, `state()` 가 `DispatchStateSchema` 를 통과); `nextHop`/`hopExceeded` 경계(6 허용, 7 초과).
- `test/teams/format.test.ts`: 접두어 형식이 문서와 **글자 단위로** 같음, DM 접두어, 시스템·승인·변경 요약 줄, 40개/12,000자 상한과 생략 줄, 트리거가 마지막에 한 번만, `conflictNote` 가 맨 앞.
- `test/teams/summary.test.ts`: `session-detail.json` fixture 스타일 아이템으로 마지막 final 메시지 추출, 다른 turnId 무시, 스트리밍 중(running) 제외, 빈 답변 null, 파일 경로 합집합·정렬, turn_summary 없음.

## Acceptance Criteria

```bash
npm ci
npm run typecheck
npm test
test -f packages/server/src/teams/dispatcher.ts
test -f packages/server/src/teams/format.ts
test -f packages/server/src/teams/summary.ts
! grep -n "SessionManager\|node:fs\|child_process" packages/server/src/teams/dispatcher.ts packages/server/src/teams/format.ts packages/server/src/teams/summary.ts
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 세 모듈이 I/O 없는 순수 함수/클래스인가(파일·프로세스·타이머 없음)?
   - 접두어 문자열이 PROTOCOL.md 6.4 와 같은가?
   - `DispatchState` 가 프로토콜 스키마로 검증되는가?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- `SessionManager`, `RoomManager` 인스턴스를 이 모듈 안에서 쓰지 마라(타입 import 만 허용). 이유: 순수 로직이어야 테스트가 빠르고 step 5 가 조립한다.
- 답변 텍스트를 요약·번역·수정하지 마라. 이유: 방에는 에이전트의 원문이 실린다.
- `packages/protocol` 을 수정하지 마라.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
