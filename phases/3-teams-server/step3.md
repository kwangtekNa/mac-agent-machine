# Step 3: room-store

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md` (CRITICAL 3, 6, 7)
- `/docs/PROTOCOL.md` 6절 (모델, 방 WS 이벤트, 디스패치 규칙 — step 0 이 추가), `/docs/ADR.md` ADR-017
- `/docs/ARCHITECTURE.md` (2.4 SessionManager 의 seq·링 버퍼·JSONL 설명, 3 저장소 구조)
- `/packages/protocol/src/teams.ts`, `common.ts`, `index.ts` (step 0)
- `/packages/protocol/fixtures/rest/team-roles.json`, `room.json`, `room-ws/*.json`
- `/packages/server/src/sessions/event-log.ts` (`EventLog`), `manager.ts` (`emit`, 링 버퍼, `subscribe` 의 재생·라이브 큐, `schedulePersist` 의 tmp+rename)
- `/packages/server/src/ids.ts`, `errors.ts`
- `/packages/server/test/sessions/manager.test.ts`, `event-log.test.ts`(있으면), `helpers/tmp-home.ts`

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

팀·방·메시지의 **저장과 스트림** 을 만든다: 팀 레코드 파일, 방별 seq·링 버퍼·JSONL 로그·구독, 역할 프리셋, 멘션 파서, ID 접두어. 세션·디스패치·git 은 모른다(step 4~6).

### 확정된 결정

- 방 seq 는 **방마다** 독립된 단조 증가 정수이며 `RoomManager` 만 발급한다. 세션 seq(SessionManager)와 무관하다.
- 링 버퍼 500, JSONL 한 줄에 `RoomServerEvent` 하나. 세션 이벤트 로그와 같은 재생 규칙(`since` 보다 큰 것, 링에 없으면 파일).
- 역할 프리셋 프롬프트는 **영어**, 답변은 **한국어** 로 하라고 명시. 커스텀 역할은 프롬프트가 비어 있어도 팀 규약 블록은 항상 붙는다.
- 멘션: `@` 뒤에 이름 또는 핸들. `@all` 은 작성자 제외 전원. 정규화는 NFC + 소문자. 이름 중복은 저장 시 409 로 막으므로 파서는 모호성을 다루지 않는다.

### 1. `src/ids.ts`

`IdPrefix` 에 `"team" | "agt" | "room" | "msg" | "chg" | "tpl" | "dsp"` 추가.

### 2. `src/sessions/event-log.ts` → 제네릭 `JsonlLog<T extends { seq: number }>`

```ts
export class JsonlLog<T extends { seq: number }> {
  constructor(filePath: string, schema: ZodType<T>, logger?: Pick<Console, "warn">);
  append(event: T): Promise<void>; flush(): Promise<void>;
  readSince(seq: number): AsyncIterable<T>; tail(n: number): Promise<T[]>;
}
export class EventLog extends JsonlLog<ServerEvent> { constructor(filePath, logger?) { super(filePath, ServerEventSchema, logger) } }
```

기존 호출부(`manager.ts`, 테스트)는 바뀌지 않아야 한다.

### 3. `src/teams/types.ts` + `src/teams/store.ts`

- 내부 레코드 `TeamRecord = Team & { members: Array<TeamMember & { lastSeen: Record<string /*roomId*/, number> }> }`. zod `TeamRecordSchema` 로 파일을 검증하고, **응답으로 나갈 때는 `TeamSchema` 로 파싱해 `lastSeen` 을 떨어뜨린다**(`toTeam(record)`).
- `TeamStore(dataDir)`: `teamsDir = <dataDir>/teams`, `list(): Promise<TeamRecord[]>`(디렉토리 스캔, 손상 파일은 경고 후 건너뜀), `load(teamId)`, `save(record)`(`<teamsDir>/<teamId>/team.json` tmp+rename, 디렉토리 0700), `remove(teamId)`(team.json·rooms/ 만 지운다. worktrees/ 는 step 5·6 이 git 으로 정리), `templatesDir = <dataDir>/team-templates` 와 같은 CRUD(`listTemplates/saveTemplate/removeTemplate`).
- `slug(name)`: 팀 이름 → `[a-z0-9-]` 슬러그(비어 있으면 `team`), `makeHandle(name, taken: Set<string>, index: number)`: 이름의 ascii 문자·숫자·하이픈만 남겨 소문자로, 비어 있으면(한글 이름) `agent-<index>`, 이미 있으면 `-2`, `-3` 접미.

### 4. `src/teams/roles.ts`

```ts
export const ROLE_PRESETS: readonly RolePreset[];   // developer, planner, team-lead, code-reviewer, custom(prompt "")
export function buildInstructions(input: { member: Pick<TeamMember, "name" | "handle" | "roleLabel" | "prompt" | "branch" | "worktreePath">; team: Pick<Team, "name" | "cwd">; teammates: Array<Pick<TeamMember, "name" | "handle" | "roleLabel" | "isLead">> }): string;
```

`buildInstructions` = 역할 프롬프트(`member.prompt`, 비어 있으면 프리셋 기본) + 아래 **팀 규약 블록**(영어). 규약 블록에 반드시 들어갈 내용:

- 너는 팀 `<team.name>` 의 `<roleLabel>` `<name>` 이고, 저장소 `<cwd>` 의 **자기 worktree** `<worktreePath>`(브랜치 `<branch>`)에서만 일한다.
- 메시지는 `[#전체] 사용자: …`, `[DM] 사용자: …`, `[#전체] @민수(개발자): …`, `[#전체] 시스템: …` 형식으로 도착한다. 마지막 메시지가 답해야 할 것이다.
- **답변은 한국어**, 간결하게. 동료가 행동해야 할 때만 `@이름` 으로 부른다(동료 목록: 이름·핸들·역할, 팀장 표시). 자기 자신을 부르지 말고, 이미 답한 요청을 다시 넘기지 마라.
- `git commit/push/merge/rebase/checkout` 을 실행하지 마라: 서버가 턴 끝에 커밋하고 사용자가 머지한다. 파일은 worktree 안에서만 만들고 고친다.
- 일을 끝내면 무엇을 바꿨는지 1~3줄로 요약한다.

역할별 프리셋 프롬프트(영어, 각 5~10문장): developer(구현·테스트·보고), planner(요구 정리·계획·문서, 요청 없으면 코드 수정 금지), team-lead(멘션 없는 메시지의 기본 응답자, 작업을 쪼개 `@이름` 으로 위임, 진행 상황 추적·요약, 큰 구현은 직접 하지 않음), code-reviewer(diff 를 읽고 버그·위험을 구체적 제안과 함께 지적, 요청 없으면 코드를 고치지 않음). `custom` 은 label "커스텀", prompt "".

### 5. `src/teams/mentions.ts`

```ts
export interface MentionResult { memberIds: string[]; all: boolean; unknown: string[] }
export function parseMentions(text: string, members: Array<Pick<TeamMember, "id" | "name" | "handle">>, opts?: { excludeMemberId?: string }): MentionResult;
export function normalizeName(s: string): string;   // NFC + toLowerCase + trim
```

규칙: 정규식 `/@([\p{L}\p{N}_.\-]+)/gu`, 토큰 끝의 `.,!?:;)]}"'` 제거, `normalizeName` 후 `name`·`handle` 과 비교. `@all` → `all: true`. `excludeMemberId`(작성자) 는 결과에서 뺀다. 같은 팀원이 여러 번 언급돼도 한 번. 모르는 토큰은 `unknown` 에 넣고 텍스트는 건드리지 않는다.

### 6. `src/teams/room-manager.ts`

```ts
export interface RoomManagerOptions { teamDir: string; team: TeamRecord; ringBufferSize?: number; now?: () => Date; logger? }
export class RoomManager {
  static open(opts): Promise<RoomManager>;      // rooms/<roomId>.events.jsonl 를 tail 해 lastSeq 를 team.json 의 값과 맞춘다(큰 쪽)
  post(roomId, draft: { author: RoomAuthor; kind: RoomMessageKind; text: string; mentions?: string[]; hop?: number; dispatchId?: string | null; work?; approval?; changes? }): Promise<RoomMessage>;   // msg_ id, seq 발급, room.message 이벤트 append + 팬아웃, room.lastSeq/lastMessageAt 갱신 콜백
  update(roomId, messageId, patch: Partial<Pick<RoomMessage, "text" | "work" | "approval" | "changes">>): Promise<RoomMessage>;   // room.message.updated (새 seq, message.seq 는 원래 값 유지)
  status(roomId, dispatch: DispatchState, members: Array<{ memberId; state; sessionId }>): Promise<void>;   // room.status
  error(roomId, message: string, recoverable: boolean): Promise<void>;
  subscribe(roomId, since: number, listener: (e: RoomServerEvent) => void): Promise<() => void>;   // 세션 subscribe 와 같은 재생·라이브 큐 규칙
  detail(roomId, limit = 200): Promise<{ room: Room; messages: RoomMessage[]; truncated: boolean }>;   // message + updated 를 재생해 최신 상태의 메시지 목록
  messagesSince(roomId, seq: number): Promise<RoomMessage[]>;   // 디스패처의 맥락 수집용(최신 상태)
  lastSeq(roomId): number;
  onRoomChanged?: (room: Room) => void;   // TeamManager 가 team.json 저장에 연결
}
```

- 메시지의 현재 상태는 `room.message` 를 기준으로 `room.message.updated` 를 덮어써 만든다(메모리 맵 `messagesById`, 열 때 로그 전체를 한 번 읽어 재구성).
- seq 발급은 이 클래스의 `emit()` 한 곳에서만. 세션 `SessionManager.emit` 을 재사용하거나 import 하지 않는다.
- 팬아웃은 동기, 리스너 예외는 로그만.

### 7. 테스트

- `test/sessions/event-log.test.ts`(있으면 확장, 없으면 신규): `JsonlLog` 제네릭이 세션 스키마와 임의 스키마 둘 다에서 `readSince`/`tail`/손상 줄 건너뛰기를 지킨다.
- `test/teams/store.test.ts`: 저장·로드 왕복, `lastSeen` 이 `toTeam` 에서 사라짐, 손상 파일 건너뜀, 템플릿 CRUD, `slug`/`makeHandle`(한글 이름 → `agent-1`, 중복 → `-2`).
- `test/teams/roles.test.ts`: 프리셋 5개, `buildInstructions` 에 규약 블록(한국어 답변, git 금지, `@` 규칙, 동료 목록)이 들어 있고 커스텀 빈 프롬프트에도 붙는다.
- `test/teams/mentions.test.ts`: 한글 이름(`@민수`), 핸들(`@minsu`), 대소문자·NFC, 끝 문장부호(`@민수,`), `@all`, 자기 제외, 모르는 토큰, 중복 제거.
- `test/teams/room-manager.test.ts`: 방별 seq 단조·독립, `post` → 구독자 수신, `update` 가 새 seq 를 쓰되 `message.seq` 유지, 링 안/밖 `since` 재생(500 초과 후 파일 재생), 재시작(`open` 재호출) 후 `detail` 이 최신 상태 복원, `truncated` 계산, `messagesSince`.

## Acceptance Criteria

```bash
npm ci
npm run typecheck
npm test
test -f packages/server/src/teams/room-manager.ts
test -f packages/server/src/teams/roles.ts
test -f packages/server/src/teams/mentions.ts
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 방 seq 발급이 `RoomManager` 한 곳뿐이고 세션 seq 와 섞이지 않는가?
   - 파일 쓰기가 tmp+rename 이고 디렉토리 권한이 0700 인가? 메시지 본문을 로그(logger)에 남기지 않는가(CRITICAL 6)?
   - `EventLog` 를 쓰는 기존 코드·테스트가 무변경으로 통과하는가?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약, 프리셋 프롬프트 요지 포함)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- `SessionManager` 를 import 하거나 세션 seq 를 방 이벤트에 쓰지 마라. 이유: CRITICAL 7 과 방 스트림 독립성.
- HTTP 라우트·WS 를 만들지 마라. 이유: step 7.
- `packages/protocol` 을 수정하지 마라. 필요하면 `needs_input`.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
