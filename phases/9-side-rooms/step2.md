# Step 2: side-rooms-server

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md` (CRITICAL 3, 6, 7)
- `/docs/PROTOCOL.md` 6절 전체(step 1 이 갱신한 6.4·6.6 포함)
- `/packages/protocol/src/teams.ts` (step 1)
- `/packages/server/src/teams/dispatcher.ts` (`route`, `DispatchQueue`, `nextHop`, `hopExceeded`)
- `/packages/server/src/teams/team-manager.ts` 전체 흐름: `postUserMessage`, `runDispatch`, `buildInput`, `statusRooms`, `groupRoom`, `dmRoom`, `dmRoomFor`, 답변 게시(`rt.rooms.post(item.roomId, …)`), 승인 미러링, 변경 카드(그룹방 고정), `lastSeen` 갱신, `emitStatus`
- `/packages/server/src/teams/room-manager.ts` (`post`, `update`, `subscribe`, `detail`, `messagesSince`, seq 발급), `store.ts`(`TeamRecord` 영속화), `format.ts`(step 0 의 `isContextRelevant`), `mentions.ts`
- `/packages/server/test/teams/*.test.ts`

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 확정된 결정 (바꾸지 마라)

step 1 문서의 6.4·6.6 규칙 그대로. 요약:

- 그룹방에서 **에이전트가 에이전트를 멘션**하면 `{작성자} ∪ {멘션 대상}` 곁방으로 디스패치를 옮긴다. 원본 답변은 그룹방에 남고, 곁방에 같은 본문을 트리거로 한 번 게시한다.
- 참가자 수 > `settings.sideRoomMaxParticipants`(기본 3) → 곁방을 만들지 않고 그룹방에서 디스패치(브로드캐스트).
- 곁방이 처음 생기면 그룹방에 `opened` 연결 카드, 그 뿌리의 연쇄가 끝나면 `closed` 카드(대화 수 + 마지막 답변 첫 줄).
- 사용자가 곁방에 멘션 없이 쓰면 참가자 전원 디스패치.
- 변경 카드는 그룹방 고정(현행 유지).
- 팀원 맥락 방 = 그룹방 + 자기 DM + 자기가 참가한 곁방.

## 작업

### 1. 레코드·마이그레이션 (`src/teams/types.ts`, `store.ts`)

- `TeamRecord.settings.sideRoomMaxParticipants` 기본 3. `TeamStore.load` 가 키 없는 기존 팀 레코드를 읽으면 기본값을 채워 넣는다(저장은 다음 변경 때).
- 방 레코드에 `participants?: string[]`. `toTeam` 이 그대로 내보낸다.

### 2. 곁방 찾기·만들기 (`team-manager.ts`)

```ts
/** 참가자 집합(정렬)으로 곁방을 찾는다. */
private findSideRoom(rt: TeamRuntime, participants: string[]): Room | undefined;
/** 없으면 만들고 그룹방에 opened 연결 카드를 남긴다. 이름은 참가자 이름을 " ↔ " 로 이은 것. */
private async ensureSideRoom(rt: TeamRuntime, participants: string[]): Promise<Room>;
```

- 참가자는 항상 `[...new Set(ids)].sort()`. 2명 미만이면 만들지 않는다.
- 방 id 는 `newId("room")`, `kind: "side"`, `memberId: null`, `lastSeq: 0`.
- 만든 직후 그룹방에 `kind: "system"` 메시지: `text: "<이름들> 곁방을 열었습니다"`, `sideRoom: { roomId, participants, kind: "opened", messages: 0 }`.
- `rt.record.rooms` 에 추가하고 즉시 영속화. 팀원들의 `lastSeen[새 방] = 0`.

### 3. 라우팅 (`dispatcher.ts` `route` + `team-manager` 의 디스패치 생성부)

`route()` 는 **순수 함수로 유지** 하되 곁방을 알게 한다:

```ts
export type RoomRef = Pick<Room, "kind" | "memberId" | "participants">;
// route(input) 의 반환에 방 결정을 더한다
export interface DispatchTarget { memberId: string; reason: "mention" | "lead" | "dm" | "all" | "side"; }
/** 이 트리거가 어느 방에서 실행돼야 하는지. null 이면 현재 방 그대로. */
export function sideRoomParticipants(input: { author: RoomAuthor; room: RoomRef; targets: DispatchTarget[]; maxParticipants: number }): string[] | null;
```

규칙:

- 현재 방이 `group` 이고 `author.kind === "agent"` 이고 `targets.length >= 1` → 후보 = `[author.memberId, ...targets]`. 후보 수 ≤ `maxParticipants` 면 그 집합을 돌려주고, 넘으면 `null`(그룹방 유지).
- 현재 방이 `side`:
  - 모든 target 이 `room.participants` 안에 있으면 `null`(같은 방에서 계속).
  - 밖의 팀원이 섞이면 `[author, ...targets]` 집합을 돌려준다(상한 초과면 `null` → 그룹방으로 보낸다. 이때 `team-manager` 가 그룹방 id 를 쓴다).
- 현재 방이 `dm` → 항상 `null`(규칙 그대로).
- 사용자 작성자 → 항상 `null`(그 방에서 처리).

`route()` 자체도 곁방을 지원해야 한다: `room.kind === "side"` 이고 `author.kind === "user"` 이고 멘션이 없으면 **참가자 전원**(`reason: "side"`), 멘션이 있으면 멘션된 참가자. 에이전트 작성자는 기존 그룹방 규칙과 동일(멘션된 사람만).

`team-manager` 는 디스패치를 만들 때:

```
const targets = route(...)
const side = sideRoomParticipants(...)
const roomId = side ? (await ensureSideRoom(rt, side)).id : (현재 방이 side 이고 상한 초과면 groupRoom.id : 현재 방 id)
// side 이면 트리거 본문을 그 방에 한 번 게시하고 그 메시지를 sourceMessageId 로 쓴다
```

곁방에 게시하는 트리거 메시지: `author` 는 원본과 같음(그 에이전트), `kind: "text"`, `text` 는 원본 본문 그대로, `mentions` 는 해석된 대상, `hop` 은 원본과 같음, `dispatchId: null`. 원본 그룹방 메시지는 **지우거나 바꾸지 않는다**.

### 4. 맥락·상태 방 (`statusRooms`, `buildInput`)

`statusRooms(rt, memberId)` = 그룹방 + 그 팀원 DM + `rooms.filter(r => r.kind === "side" && r.participants?.includes(memberId))`. `buildInput` 은 그대로 이 목록을 쓰면 된다(방마다 `lastSeen`). step 0 의 필터가 각 방에 그대로 적용된다.

`emitStatus` 도 같은 목록에 발행한다.

### 5. 연쇄 종료 감지 → `closed` 카드

`runDispatch` 가 끝나고 큐를 펌프한 뒤, **그 뿌리(`rootId`)에 속한 실행·대기 항목이 하나도 남지 않았고** 그 뿌리가 곁방을 만들었다면:

- 그 곁방에서 이 뿌리 동안 오간 메시지 수(`rt.rooms.messagesSince(roomId, 시작 시점 seq)` 의 개수)와 마지막 에이전트 답변의 첫 줄(80자)로 그룹방에 `closed` 카드를 남긴다: `text: "<이름들> 곁방 대화 N건 · 결론: <첫 줄>"`, `sideRoom: { roomId, participants, kind: "closed", messages: N }`.
- 뿌리별로 한 번만 남긴다(`rt` 에 `Map<rootId, { roomId, startSeq, posted }>`).
- 곁방은 **지우지 않는다**. 다음에 같은 조합이면 재사용한다.

### 6. 테스트 (먼저 쓴다)

`test/teams/dispatcher.test.ts` 확장(순수):

- `sideRoomParticipants` 표: 그룹방 에이전트→1명(pair), →2명(3인), →3명(상한 3 초과 → null), 곁방 안 참가자만(null), 곁방에서 외부인 멘션(새 집합), DM(null), 사용자(null).
- `route` 곁방 케이스: 사용자 멘션 없음 → 참가자 전원, 멘션 있음 → 그 참가자, 에이전트 → 멘션 대상, 자기 멘션 제외.

`test/teams/side-rooms.test.ts` 신규(`FakeAdapter` 통합):

- 팀장이 그룹방에서 `@개발자` 를 부르면: 곁방이 생기고, 그룹방에 `opened` 카드가 뜨고, 개발자의 턴 입력이 **곁방 트리거**로 오며, 개발자의 답변이 곁방에 게시된다(그룹방 메시지 수는 연결 카드 1건만 증가).
- 같은 조합을 다시 부르면 **같은 방 재사용**(방 수가 늘지 않는다).
- 팀장이 한 번에 3명을 부르면(상한 3, 후보 4명) 곁방을 만들지 않고 그룹방에서 디스패치된다.
- 곁방 안에서 개발자가 팀장을 멘션하면 같은 방에서 이어진다(홉 +1).
- 곁방 안에서 제3자를 멘션하면 새 곁방(3인)으로 간다.
- 사용자가 곁방에 멘션 없이 쓰면 참가자 전원이 디스패치된다.
- 연쇄가 끝나면 그룹방에 `closed` 카드가 정확히 1건 생기고 `messages` 가 곁방 메시지 수와 같다.
- 곁방에서 파일을 바꾼 턴의 **변경 카드는 그룹방**에 올라간다.
- 곁방 참가자가 아닌 팀원의 턴 입력에는 그 곁방 메시지가 들어가지 않는다(맥락 격리 검증 — 이 phase 의 핵심).
- 재시작(`TeamManager.open` 재호출) 후 곁방·참가자·`lastSeen` 이 복원된다.

## Acceptance Criteria

```bash
npm ci
npm run typecheck
npm test
grep -q "ensureSideRoom" packages/server/src/teams/team-manager.ts
grep -q "sideRoomParticipants" packages/server/src/teams/dispatcher.ts
bash scripts/dev-smoke.sh
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 방 seq 는 여전히 `RoomManager` 만 발급하는가(CRITICAL 7)? 곁방도 같은 경로인가?
   - `route`·`sideRoomParticipants` 가 순수 함수로 남아 있는가(세션·파일 접근 없음)?
   - 기존 그룹방·DM 동작(사용자 메시지, 팀장 기본 응답, 홉 상한, 동시 실행 상한)이 그대로인가?
   - 메시지 본문을 로그에 남기지 않는가(CRITICAL 6)?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`
   - 실패 → `error` / 개입 필요 → `blocked` / 설계 분기 → `needs_input`

## 금지사항

- 그룹방의 원본 답변을 지우거나 곁방으로 "이동"시키지 마라. 이유: 사람이 보던 기록이 사라진다. 곁방에는 복사본을 트리거로 넣는다.
- 곁방을 자동으로 삭제하지 마라. 이유: 같은 조합이면 재사용해야 맥락이 이어진다.
- 변경 카드를 곁방에 올리지 마라(그룹방 고정).
- DM 방 규칙을 바꾸지 마라.
- HTTP 라우트·WS 를 새로 만들지 마라. 기존 `/teams/:id/rooms/:roomId` 와 방 WS 가 곁방에도 그대로 쓰인다(방 id 만 다르다).
- iOS 를 수정하지 마라(step 3).
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
