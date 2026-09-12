# Step 6: changes-and-merge

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md` (CRITICAL 3, 4)
- `/docs/PROTOCOL.md` 6.2(`/changes` 엔드포인트 의미), 6.5 worktree·커밋·머지 규칙, `/docs/ADR.md` ADR-017
- `/packages/protocol/src/teams.ts` (`ChangeSet`, `MergeResult`)
- `/packages/server/src/git/worktree.ts` (step 2: `mergeIntoBase`, `syncFromBase`, `hasMergeInProgress`, `changesVsBase`, `commitAll`)
- `/packages/server/src/teams/team-manager.ts` (step 5: `runDispatch` 의 동기화 단계, ChangeSet 게시, `changes.json`), `room-manager.ts`, `format.ts`(`conflictNote`)
- `/packages/server/src/errors.ts` (`ConflictError` 등 409 매핑)
- `/packages/server/test/teams/team-manager.test.ts`, `/packages/server/test/git/worktree.test.ts`

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

"변경 준비됨" 카드의 **머지·거절·충돌·동기화·stale** 흐름을 `TeamManager` 에 완성한다. 사용자가 방에서 머지를 승인하면 서버가 베이스 브랜치에 `--no-ff` 머지하고, 충돌이면 해당 팀원에게 해결 턴을 보낸다.

### 확정된 결정

- 머지 전제조건: 프로젝트 체크아웃(`team.cwd`)이 깨끗하고 현재 브랜치가 `team.baseBranch`. 아니면 409 `conflict` 와 사람이 읽을 문구("프로젝트에 커밋되지 않은 변경이 있어 머지할 수 없습니다. 먼저 커밋하거나 stash 하세요" / "현재 브랜치가 <base> 가 아닙니다").
- 머지는 `--no-ff --no-edit`, 메시지 `Merge <branch> (<name>)`. 브랜치는 유지. 자동 머지는 없다(사용자 액션만).
- 충돌: 베이스 체크아웃은 깨끗하게 되돌리고(`merge --abort`), ChangeSet 은 `conflict` + `conflictFiles`, 그 팀원의 worktree 에서 `syncFromBase` 로 충돌 마커를 남긴 뒤 **그 팀원 DM 방** 에 `system` 메시지로 해결을 지시하고 그 팀원에게 디스패치(루트, `hop 0`)한다. 팀원이 해결하면 턴 종료 자동 커밋이 머지 커밋을 완성하고 새 `ready` ChangeSet 이 올라온다. 사용자가 다시 머지한다.
- 턴 전 동기화: worktree 가 깨끗하고 진행 중 머지가 없을 때만 `syncFromBase`; 충돌이면 마커를 남기고 턴 텍스트 앞에 `conflictNote`. 진행 중 머지(`MERGE_HEAD`)가 있으면 동기화하지 않고 `conflictNote` 로 남은 충돌 파일을 안내.
- `dismiss`: 상태 `dismissed`, 브랜치·커밋은 그대로.

### 1. `src/teams/changes.ts` (+ `team-manager.ts` 연결)

```ts
export class ChangeStore { constructor(teamDir: string); load(): Promise<ChangeSet[]>; save(list: ChangeSet[]): Promise<void>; }   // step 5 가 team-manager 안에 두었다면 여기로 옮긴다
export function conflictNoteFor(files: string[], base: string): string;   // "머지 충돌: <files>. worktree 안에서 충돌 마커(<<<<<<<, >>>>>>>)를 정리하고 파일을 저장하라. git 명령은 실행하지 마라."
```

`TeamManager` 에 추가:

```ts
merge(teamId, changeId): Promise<MergeResult>;        // ready 아니면 ConflictError(409). merging → mergeIntoBase → merged | conflict | dirty | wrong_branch
dismiss(teamId, changeId): Promise<ChangeSet>;        // ready|conflict 만 가능, 아니면 409
```

`merge` 흐름:

1. `status: "merging"` 으로 바꾸고 `room.message.updated`.
2. `mergeIntoBase({ repo: team.cwd, base, branch, message })`.
3. `merged` → `status: "merged"`, `MergeResult.mergeCommit = sha`, 메시지 갱신, 그 팀원 worktree 를 `syncFromBase`(깨끗할 때만) 해 베이스와 맞춘다. 팀원이 실행 중이면 동기화는 다음 턴 전으로 미룬다.
4. `dirty`/`wrong_branch` → 상태를 `ready` 로 되돌리고 409 `conflict` 를 던진다(메시지 위 문구).
5. `conflict` → `status: "conflict"`, `conflictFiles`, 메시지 갱신; worktree 가 깨끗하고 실행 중이 아니면 `syncFromBase(worktree, base)`(마커 남김); DM 방에 `system` 메시지 `"<base> 에 머지하는 중 충돌이 났습니다: <files>. worktree 에서 충돌을 해결하고 파일을 저장하세요."` 를 게시하고 그 팀원에게 디스패치(작성자 system, 루트, `hop 0`). 팀원이 실행 중이면 디스패치는 큐에 들어간다.

턴 종료 자동 커밋(step 5)은 `hasMergeInProgress` 가 true 여도 `commitAll` 을 그대로 실행한다(진행 중 머지가 있으면 git 이 머지 커밋을 만든다). 커밋 메시지는 `"<name>(<roleLabel>): merge <base> — <요약>"`.

### 2. `stale` 과 재시작

- 팀원의 새 ChangeSet 이 생기면 같은 팀원의 이전 `ready`/`conflict` 는 `stale` (step 5 의 규칙을 `conflict` 까지 확장).
- `TeamManager.open` 시 `ready`/`conflict` ChangeSet 을 `changesVsBase` 로 다시 계산: 브랜치 head 가 `commit` 과 다르거나 commits 가 0 이면 `stale`. `merging` 으로 남아 있던 것은 베이스 로그에 머지 커밋이 있으면 `merged`, 아니면 `ready`.
- `dismissed`/`merged`/`stale` 은 `GET /teams/:id` 의 `changes` 에 최근 20개까지만 포함(나머지는 파일에만).

### 3. 테스트 `test/teams/changes.test.ts`

step 5 의 헬퍼(팀 + Fake 스크립트가 `ctx.cwd` 에 파일을 씀)를 재사용:

- 머지 성공: 베이스 `git log --merges` 에 머지 커밋, ChangeSet `merged` + `mergeCommit`, 방 메시지 갱신, 팀원 worktree 가 베이스와 같은 head.
- 더러운 체크아웃(베이스에 미커밋 파일) → 409 이고 ChangeSet 은 `ready` 로 남음. 베이스를 다른 브랜치로 checkout → 409 `wrong_branch` 문구.
- 충돌: 베이스에서 같은 파일 같은 줄을 먼저 바꿔 커밋 → 머지 → `conflict` + `conflictFiles`, 베이스 `status --porcelain` 빈 문자열이고 `MERGE_HEAD` 없음, 팀원 worktree 에는 `MERGE_HEAD` 와 마커, DM 방에 system 메시지, 그 팀원에게 디스패치가 큐/실행됨(Fake 스크립트가 "충돌 해결" 지시를 받으면 마커를 지운 파일을 씀) → 턴 종료 커밋이 머지 커밋이 되고 새 `ready` ChangeSet → 다시 머지하면 `merged`.
- `dismiss` → `dismissed`, 브랜치 커밋 유지, 다시 dismiss 면 409.
- 재시작: `merging` 흔적이 `merged`/`ready` 로 정리되고, 브랜치가 움직인 `ready` 는 `stale`.
- `ready` 아닌 ChangeSet 머지 → 409.

## Acceptance Criteria

```bash
npm ci
npm run typecheck
npm test
grep -q "merge(" packages/server/src/teams/team-manager.ts
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 머지가 사용자 액션(`merge()` 호출)으로만 일어나는가? 베이스 체크아웃이 실패 경로에서 항상 깨끗한가?
   - 다른 팀원의 worktree 를 건드리지 않는가(충돌 팀원만)?
   - git 호출이 전부 `worktree.ts` 헬퍼(spawn)인가(CRITICAL 4)?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- 자동 머지(리뷰어 승인 등으로 서버가 스스로 머지)를 만들지 마라. 이유: 결정 사항은 사용자 승인 머지뿐이다.
- squash·rebase·강제 삭제·하드 리셋을 쓰지 마라. 이유: no-ff 와 브랜치 유지가 확정됐고 이력 손실 위험이 있다.
- 충돌 마커를 서버가 자동으로 해결하려 하지 마라. 이유: 해결은 그 팀원(에이전트)의 턴이 한다.
- HTTP 라우트·WS 를 만들지 마라(step 7).
- `packages/protocol` 을 수정하지 마라.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
