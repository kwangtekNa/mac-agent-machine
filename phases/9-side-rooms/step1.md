# Step 1: side-rooms-protocol

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md` (CRITICAL 5)
- `/docs/PROTOCOL.md` **6절 전체**(6.1 `Room`·`RoomMessage`, 6.2 REST, 6.3 방 WS, 6.4 디스패치 규칙), 0절 규약
- `/docs/ADR.md` ADR-017
- `/packages/protocol/src/teams.ts` (`RoomKindSchema`, `RoomSchema`, `RoomMessageSchema`, `TeamSettingsSchema`), `common.ts`, `index.ts`
- `/packages/protocol/test/fixtures.test.ts`(`ROOM_WS`/`ROOM_CLIENT` 테이블, `ADDED_2026_09_13`), `schemas.test.ts`
- `/packages/protocol/fixtures/rest/team.json`, `room.json`, `/packages/protocol/fixtures/room-ws/*.json`
- `/ios/MacAgentTests/ProtocolFixturesTests.swift` (현재 파일 수는 파일에서 직접 확인한다)

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 배경

에이전트끼리의 1:1·2:1 대화가 전부 그룹방에서 일어나 다른 팀원의 맥락을 잠식한다(측정: 팀장 맥락의 92%가 무관). 에이전트 간 대화를 **곁방(side room)** 으로 자동 분리한다. 이 step 은 계약만 만든다(스키마·fixture·문서). 서버 동작은 step 2.

## 확정된 결정 (바꾸지 마라)

- 곁방은 **참가자 집합**으로 식별한다. 같은 집합이면 같은 방을 재사용한다.
- 에이전트가 다른 에이전트를 멘션하면 그 대화는 **항상 곁방에서** 이어진다. 사용자↔에이전트는 그룹방 유지.
- 곁방이 처음 생기면 그룹방에 **연결 카드 한 줄**, 대화가 끝나면 **결론 한 줄**을 남긴다.
- 사람은 방 목록의 "에이전트 간" 섹션에서 곁방을 보고 **직접 끼어들 수 있다**.
- 사용자가 곁방에 멘션 없이 쓰면 **참가자 전원**이 응답한다.
- 곁방에서 한 작업의 "변경 준비됨" 카드는 **그룹방 고정**(사람이 한곳에서 머지).
- 참가자 수 상한(기본 3): `{작성자} ∪ {멘션 대상}` 이 이 수를 넘으면 곁방을 만들지 않고 **그룹방에 남긴다**(그건 공지·브로드캐스트다).

## 작업

### 1. zod 스키마 (`packages/protocol/src/teams.ts`)

```ts
export const RoomKindSchema = z.enum(["group", "dm", "side"]);   // side 추가
// RoomSchema 에 추가(둘 다 optional — 기존 방은 키가 없다)
participants: z.array(MemberIdSchema).optional(),   // side 일 때만. 정렬된 팀원 id 집합, 2개 이상
// RoomMessageSchema 에 추가
sideRoom: z.object({
  roomId: RoomIdSchema,
  participants: z.array(MemberIdSchema),
  kind: z.enum(["opened", "closed"]),
  messages: z.number().int().min(0),      // closed 일 때 곁방에서 오간 메시지 수, opened 면 0
}).nullable().default(null),               // kind: "system" 의 연결 카드에만 값
```

`TeamSettingsSchema` 에 `sideRoomMaxParticipants: z.number().int().min(2).max(8)` 추가(기본 3). 기존 팀 레코드에 키가 없을 수 있으므로 서버는 기본값으로 채운다(스키마는 필수로 두되 step 2 가 마이그레이션한다 — 이 step 은 스키마와 문서만).

`RoomSchema.name` 규칙: 곁방 이름은 참가자 이름을 `↔` 로 이은 문자열(예: `카파시 ↔ icml`). 서버가 만든다.

### 2. `docs/PROTOCOL.md` 6절 갱신 (인라인 "(2026-09-14 추가)" 표기)

- 6.1 `Room` 표: `kind` 에 `side` 추가, `participants` 행 추가(“`side` 일 때 정렬된 팀원 id. 그 외에는 키 생략”), `memberId` 설명에 “`side` 는 `null`”.
- 6.1 `RoomMessage` 표: `sideRoom` 행 추가(연결 카드. `kind: "system"` 이고 곁방이 열리거나 닫힐 때만 값).
- 6.1 `TeamSettings`: `sideRoomMaxParticipants`(기본 3) 추가.
- **6.4 디스패치 규칙 갱신**(핵심):
  - 그룹방에서 **작성자가 에이전트이고** 멘션 대상이 에이전트일 때: `{작성자} ∪ {멘션 대상}` 의 곁방을 찾거나 만들고, 그 팀원들의 디스패치는 **곁방에서** 실행한다. 원본 답변은 그룹방에 그대로 남고, 곁방에는 같은 본문이 트리거 메시지로 한 번 게시된다(작성자는 그 에이전트).
  - 참가자 수가 `sideRoomMaxParticipants` 를 넘으면 곁방을 만들지 않고 지금처럼 그룹방에서 디스패치한다.
  - 사용자 메시지는 언제나 그 방(그룹·DM·곁방)에서 처리한다. 곁방에서 사용자가 멘션 없이 쓰면 **참가자 전원**에게 디스패치.
  - 곁방 안에서 에이전트가 **그 방 참가자**를 멘션하면 같은 방에서 이어진다. 참가자가 아닌 팀원을 멘션하면 그 조합의 새 곁방으로 간다(상한 초과면 그룹방).
  - DM 방 규칙은 그대로(사용자 발화만, 다른 멘션 무시).
  - 홉·동시 실행 상한·중복 제거는 방과 무관하게 그대로.
- 6.4 "턴 입력": 팀원의 맥락 방 = **그룹방 + 자기 DM 방 + 자기가 참가한 곁방 전부**(방마다 `lastSeen` 별도).
- 6.5: 곁방에서 한 작업의 변경 카드도 **그룹방**에 올린다는 문장 추가(현행 동작 명시).
- 새 소절 `6.6 곁방(2026-09-14 추가)`: 생성·재사용 규칙, 연결 카드 두 종류(`opened`/`closed`), 사람이 끼어들 수 있다는 점, 방은 지우지 않고 재사용한다는 점.

### 3. Fixture

- `fixtures/rest/team.json`: `rooms` 에 곁방 1개 추가(`kind: "side"`, `participants: [카파시, icml]`, `name: "카파시 ↔ icml"`, `memberId: null`), `settings.sideRoomMaxParticipants: 3`.
- 새 `fixtures/room-ws/room.message.side-opened.json`: 그룹방에 올라간 `kind: "system"` 메시지로 `sideRoom: { kind: "opened", roomId, participants, messages: 0 }`, `text: "카파시 ↔ icml 곁방을 열었습니다"`.
- 새 `fixtures/room-ws/room.message.side-closed.json`: `sideRoom.kind: "closed"`, `messages: 7`, `text: "카파시 ↔ icml 곁방 대화 7건 · 결론: 린트 오류 3건을 고쳤습니다"`.
- `fixtures/rest/room.json` 의 `room` 을 곁방으로 바꾸지 마라(그룹방 유지). 곁방 자체의 상세 fixture 가 필요하면 `rest/room-side.json` 을 새로 만든다.
- `fixtures.test.ts`: `REST`/`ROOM_WS` 테이블에 새 항목 추가, `ADDED_2026_09_14` 배열로 이번 추가분 검사. `room.snapshot` 이 여전히 통과하는지 확인.
- `ios/MacAgentTests/ProtocolFixturesTests.swift`: 새 경로를 임시 `decode(JSONValue.self)` 로 등록하고 하드코딩된 파일 수를 갱신(step 3 이 실제 타입으로 바꾼다).

### 4. 테스트

- `schemas.test.ts` 음수 케이스: `kind: "side"` 인데 `participants` 가 1개 → 실패; `participants` 에 중복 id → 실패(스키마에서 막을 수 없으면 서버 검증으로 넘기고 그 사실을 주석으로); `sideRoomMaxParticipants: 1` → 실패; `sideRoom.kind` 모르는 값 → 실패.
- `index.test.ts`: 새 타입 export 확인.

## Acceptance Criteria

```bash
npm ci
npm run typecheck
npm test
grep -q "side" packages/protocol/src/teams.ts
grep -q "6.6 곁방" docs/PROTOCOL.md
test -f packages/protocol/fixtures/room-ws/room.message.side-opened.json
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 추가만 있고 기존 필드·의미가 바뀌지 않았는가(구 클라이언트 호환)? `participants`·`sideRoom` 이 optional/nullable 인가?
   - fixture → zod → 문서가 필드 단위로 일치하는가? iOS 테이블 개수가 맞는가(CRITICAL 5)?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`
   - 실패 → `status: "error"` + `error_message` / 개입 필요 → `blocked` / 설계 분기 → `needs_input`

## 금지사항

- `packages/server` 를 수정하지 마라(step 2).
- `RoomKind` 를 lenient 로 바꾸거나 `RoomAuthor` 판별자를 건드리지 마라.
- Swift 파일을 새로 만들지 마라(step 3 이 한다).
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
