# Step 2: git-worktrees

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md` (CRITICAL 3, 4)
- `/docs/PROTOCOL.md` 6.5 (worktree·커밋·머지 규칙, step 0 이 추가), `/docs/ADR.md` ADR-017
- `/packages/server/src/git/status.ts` (`runGit`, `findRepoRoot`, `gitStatus`), `diff.ts`
- `/packages/server/src/fs/sandbox.ts` (`resolveInsideHome`)
- `/packages/server/src/errors.ts`
- `/packages/server/test/helpers/tmp-home.ts` (`makeTmpHome`, `git`, `initRepo`), `/packages/server/test/git/*.test.ts`

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

팀원 worktree 를 만들고, 턴 종료 시 커밋하고, 베이스 브랜치와 비교·머지·동기화하는 **순수 git 헬퍼** 를 만든다. 팀 개념은 모른다(경로·브랜치 이름을 인자로 받는다). 모든 git 호출은 `runGit(["-C", repo, ...])` 처럼 `spawn` 기반이어야 한다.

### 확정된 규칙

- 브랜치 이름은 호출자가 `mam/<team-slug>/<handle>` 형태로 넘긴다(충돌 시 호출자가 `-2` 접미). 이 모듈은 검증만(`^[A-Za-z0-9._/-]+$`, `..`·공백 금지).
- 커밋 작성자: `--author "<name> (mam-team) <handle@mam.local>"` 을 인자로 받는다. 커밋은 `git -C <wt> add -A && git -C <wt> commit -q -m <msg> --author <author>`. 변경이 없으면 커밋하지 않고 `null`.
- 머지는 `--no-ff --no-edit`, 브랜치 유지. 머지 전제조건: 프로젝트 체크아웃이 깨끗(`status --porcelain` 빈 문자열)하고 현재 브랜치가 베이스 브랜치일 것.
- `git worktree remove` 에 강제 플래그를 쓰지 않는다. 더러우면 실패를 그대로 돌려준다.

### 1. `src/git/worktree.ts`

```ts
export interface WorktreeError extends Error { code: "not_repo" | "detached" | "dirty" | "wrong_branch" | "conflict" | "git_failed"; detail?: string }

/** 프로젝트 체크아웃의 현재 브랜치. detached 면 code "detached". */
export async function detectBaseBranch(repo: string): Promise<string>;
export function isValidBranchName(name: string): boolean;
/** `git -C repo worktree add -b branch path base`. path 의 부모 디렉토리는 만들어 둔다. 브랜치가 이미 있으면 `-b` 없이 붙인다. */
export async function addWorktree(opts: { repo: string; path: string; branch: string; base: string }): Promise<void>;
export async function worktreeIsDirty(wt: string): Promise<boolean>;
/** 더러우면 code "dirty" 로 던진다. 성공 후 `git worktree prune`. 브랜치는 지우지 않는다. */
export async function removeWorktree(repo: string, path: string): Promise<void>;
/** add -A + commit. 변경 없으면 null, 있으면 커밋 sha. */
export async function commitAll(wt: string, opts: { message: string; author: string }): Promise<string | null>;
/** `rev-list --count base..branch` 와 `diff --numstat base...branch`. */
export async function changesVsBase(repo: string, base: string, branch: string): Promise<{ commits: number; files: Array<{ path: string; additions: number; deletions: number }>; head: string }>;
/** 전제조건 검사 후 no-ff 머지. 충돌이면 conflictFiles 를 모으고 `merge --abort` 한 뒤 status "conflict". */
export async function mergeIntoBase(opts: { repo: string; base: string; branch: string; message: string }): Promise<{ status: "merged"; sha: string } | { status: "conflict"; conflictFiles: string[] } | { status: "dirty" } | { status: "wrong_branch"; current: string }>;
/** worktree 에서 `merge --no-edit base`. 이미 조상이면 아무것도 안 함(status "up_to_date"). 충돌이면 마커·MERGE_HEAD 를 남기고 "conflict" + 파일 목록. */
export async function syncFromBase(wt: string, base: string): Promise<{ status: "up_to_date" | "merged" | "conflict"; conflictFiles?: string[] }>;
/** worktree 에 진행 중인 머지(MERGE_HEAD)가 있는가. */
export async function hasMergeInProgress(wt: string): Promise<boolean>;
```

- `runGit` 의 기본 타임아웃(10초)이 머지에 짧을 수 있으니 `timeoutMs` 를 넘길 수 있게 하고 머지·worktree add 에는 60초를 쓴다.
- 경로 인자는 호출자가 이미 `resolveInsideHome` 을 거쳤다고 가정하되, 이 모듈도 `path.isAbsolute` 를 검사한다.
- untracked 파일이 `.gitignore` 에 걸리면 `add -A` 가 무시하는 것이 정상이다(별도 처리 없음).

### 2. 테스트 `test/git/worktree.test.ts`

`tmp-home.ts` 의 `makeTmpHome`/`initRepo`/`git` 으로 임시 저장소를 만들고(`git config user.name/email` 은 헬퍼가 설정하는지 확인, 아니면 테스트에서 설정):

- `detectBaseBranch` 가 `main`(또는 초기 브랜치)을 돌려주고, detached 에서 `detached` 를 던진다. 저장소가 아니면 `not_repo`.
- `addWorktree` 가 홈 안 별도 경로에 worktree 를 만들고 브랜치가 생긴다. 같은 브랜치로 다시 부르면 `-b` 없이 붙는다.
- `commitAll`: 변경 없음 → null; 파일 추가 → sha, `git log -1 --format=%an` 이 `민수 (mam-team)`.
- `changesVsBase`: 커밋 수와 numstat 파일 목록.
- `mergeIntoBase`: 성공 시 `git log --merges` 에 머지 커밋 1개, 메시지 일치; 프로젝트 체크아웃이 더러우면 `dirty`; 다른 브랜치면 `wrong_branch`; 같은 줄을 양쪽에서 고치면 `conflict` + 파일 목록이고 베이스 체크아웃은 깨끗(`status --porcelain` 빈 문자열, `MERGE_HEAD` 없음).
- `syncFromBase`: 베이스에 새 커밋 후 `merged`; 이미 최신이면 `up_to_date`; 충돌이면 `conflict` 이고 `hasMergeInProgress` 가 true.
- `removeWorktree`: 깨끗하면 제거되고 브랜치는 남음; 더러우면 `dirty` 를 던지고 디렉토리가 남음.

## Acceptance Criteria

```bash
npm ci
npm run typecheck
npm test
test -f packages/server/src/git/worktree.ts
grep -q "runGit" packages/server/src/git/worktree.ts
! grep -n "execSync\|shell: true" packages/server/src/git/worktree.ts
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 모든 git 호출이 `spawn` 인자 배열인가(CRITICAL 4)? 사용자 입력이 인자로만 들어가는가?
   - 강제 삭제·하드 리셋·rebase·push 를 어디에도 쓰지 않았는가?
   - 실패 경로에서 베이스 체크아웃을 항상 깨끗하게 되돌리는가(`merge --abort`)?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- worktree 강제 삭제, 하드 리셋, rebase, push 를 쓰지 마라. 이유: 에이전트의 미커밋 작업이나 사용자의 저장소 이력을 잃을 수 있다. (하네스의 위험 명령 가드도 이런 명령을 막는다.)
- 팀·세션 코드를 import 하지 마라. 이유: 이 모듈은 순수 git 헬퍼이고 step 5·6 이 조립한다.
- `packages/protocol` 을 수정하지 마라.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
