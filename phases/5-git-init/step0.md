# Step 0: git-init-server

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md` (CRITICAL 3, 4, 5)
- `/docs/PROTOCOL.md` 0절, 1절의 `GET /git/status`·`GET /git/diff`·`POST /fs/mkdir (2026-09-10 추가)` 표기 방식, 6.5(팀 생성이 git 저장소를 요구하는 이유)
- `/docs/RUNBOOK.md` "팀 운영" 절
- `/packages/protocol/src/rest.ts` (`GitStatusResponseSchema`, `FsMkdirRequestSchema/ResponseSchema`), `index.ts`
- `/packages/protocol/test/fixtures.test.ts` (`REST` 테이블, `ADDED_2026_09_12`), `/packages/protocol/fixtures/rest/git-status.json`, `fs-mkdir.json`
- `/ios/MacAgentTests/ProtocolFixturesTests.swift` (`ADDED_2026_09_12` 가 실제 타입으로 등록돼 있고 파일 수 69)
- `/packages/server/src/agent-host/routes/git.ts` (`resolveCwd`, `validate`, `send`), `routes/fs.ts` (`POST /fs/mkdir` 의 201·409 처리)
- `/packages/server/src/git/status.ts` (`runGit`, `findRepoRoot`), `worktree.ts` (`detectBaseBranch`, `commitAll` 의 작성자 처리), `/packages/server/src/fs/sandbox.ts` (`resolveInsideHome`, `statResolved`), `/packages/server/src/fs/mkdir.ts`
- `/packages/server/src/errors.ts`
- `/packages/server/test/git/worktree.test.ts`, `/packages/server/test/fs/mkdir.test.ts`, `/packages/server/test/agent-host/rest.test.ts`, `/packages/server/test/helpers/tmp-home.ts`

이전 phase 에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 배경

폰에서 팀을 만들 때 고른 디렉토리가 git 저장소가 아니면 `POST /teams` 가 400 을 돌려준다. 폰에서 그 자리에서 저장소를 초기화할 수 있게 `POST /git/init` 을 만든다. 팀원 worktree 는 베이스 브랜치를 체크아웃하므로 **기존 파일은 첫 커밋에 담겨야** 에이전트가 볼 수 있다.

## 확정된 결정 (바꾸지 마라)

- 초기화 = (없을 때만) 기본 `.gitignore` 생성 → `git init -b main` → `git add -A` → `git commit -m "Initial commit"`. 파일이 하나도 없으면 `--allow-empty`.
- 기본 브랜치는 항상 `main`(사용자 git 전역 설정과 무관).
- `dryRun: true` 면 아무것도 바꾸지 않고 커밋될 파일 수·바이트를 **정확히** 계산해 돌려준다(아래 방식).
- 이미 저장소이거나 상위 디렉토리가 저장소면 409 `conflict`. 홈 밖 403. 없는 경로·파일 400.

## 작업

### 1. `docs/PROTOCOL.md` 1절 — `### POST /git/init (2026-09-13 추가)`

`GET /git/diff` 뒤에 추가한다. 요청 `{ cwd: string, dryRun?: boolean }`, 응답 `GitInitResponse`:

| 필드 | 타입 | 설명 |
|---|---|---|
| `initialized` | boolean | 실제로 초기화했으면 true, `dryRun` 이면 false |
| `branch` | string | 항상 `main` |
| `commit` | string \| null | 첫 커밋 sha(40자). `dryRun` 이면 null |
| `files` | int ≥ 0 | 첫 커밋에 담기는(담길) 파일 수 |
| `bytes` | int ≥ 0 | 그 파일들의 합계 크기 |
| `createdGitignore` | boolean | 기본 `.gitignore` 를 만들었(만들)는지 |

오류: 홈 밖 403 `forbidden`; 디렉토리가 아니거나 없음 400 `invalid_request`; 이미 저장소이거나 상위에 저장소가 있음 409 `conflict`(메시지에 어느 경로가 저장소인지). 상태 코드는 초기화 201, `dryRun` 200. RUNBOOK "팀 운영" 절에 "폰에서 저장소 초기화" 한 단락(기본 .gitignore 내용, 첫 커밋 정책).

### 2. zod + fixture

- `rest.ts`: `GitInitRequestSchema { cwd: z.string().min(1), dryRun: z.boolean().optional() }`, `GitInitResponseSchema`(위 표). `index.ts` 에서 타입 export.
- `fixtures/rest/git-init.json`(`initialized: true`, sha, files 12, bytes 48213, createdGitignore true), `fixtures/rest/git-init-dry-run.json`(`initialized: false`, `commit: null`).
- `fixtures.test.ts` `REST` 테이블 2개 추가 + `ADDED_2026_09_13 = ["rest/git-init.json", "rest/git-init-dry-run.json"]` 검사.
- `ios/MacAgentTests/ProtocolFixturesTests.swift`: 두 경로를 임시로 `decode(JSONValue.self)` 로 등록하고 `files.count` 69 → 71, `ADDED_2026_09_13` 집합 검사 추가(iOS step 1 이 실제 타입으로 바꾼다). Swift 파일을 새로 만들지 않는다.

### 3. `packages/server/src/git/init.ts`

```ts
export const DEFAULT_GITIGNORE: string;   // 아래 내용 그대로
export interface GitInitOptions { dryRun?: boolean; now?: () => Date }
/** cwd 는 이미 resolveInsideHome 을 거친 절대 경로. */
export async function initRepository(cwd: string, opts?: GitInitOptions): Promise<GitInitResponse>;
export async function assertNotInsideRepo(cwd: string): Promise<void>;   // findRepoRoot(cwd) !== null → ConflictError("이미 git 저장소입니다: <root>")
```

기본 `.gitignore`(첫 줄 주석 포함, 정확히 이 내용):

```
# MacAgent 기본 .gitignore — 필요에 맞게 고치세요
.DS_Store
node_modules/
dist/
build/
.build/
DerivedData/
xcuserdata/
__pycache__/
.venv/
*.log
.env
.env.*
```

**dryRun 계산 방식**(정확성을 위해 실제 git 을 쓰되 cwd 를 건드리지 않는다): 임시 디렉토리 `tmp` 를 만들고 `git --git-dir=<tmp> --work-tree=<cwd> init -q -b main`(GIT_DIR 이 밖에 있으므로 cwd 에는 아무것도 생기지 않는다) → 기본 .gitignore 가 없을 때는 그 내용을 임시 파일에 써 `--exclude-from` 으로 → `git --git-dir=<tmp> --work-tree=<cwd> ls-files --others --exclude-standard --exclude-from=<tmpIgnore> -z` 로 파일 목록 → 수와 `stat` 크기 합. 끝나면 `tmp` 를 지운다. 실제 초기화도 같은 목록으로 `files/bytes` 를 보고한다(`git ls-files -z` 로 커밋 후 집계).

실제 초기화 순서: `assertNotInsideRepo` → `.gitignore` 없으면 생성(`createdGitignore: true`) → `git -C cwd init -q -b main` → `git -C cwd add -A` → `git -C cwd commit -q -m "Initial commit"`(파일 0개면 `--allow-empty`). 커밋 작성자: `git config user.name` 이 비어 있으면 `-c user.name=MacAgent -c user.email=mam@mam.local` 을 붙인다(전역 설정은 건드리지 않는다). 모든 git 호출은 `runGit`(spawn). 실패 시 만들어 둔 `.gitignore` 는 우리가 만든 것이면 지우고, `.git` 은 남기지 않는다(초기화 실패 시 `rm` 대신 `git` 이 만든 `.git` 디렉토리를 `fs.rm(recursive)` 로 정리 — 이 경로는 우리가 방금 만든 것으로 한정).

### 4. 라우트 `routes/git.ts`

`app.post("/git/init", { preHandler: validate({ body: GitInitRequestSchema }) })`: `resolveCwd` 재사용 → `initRepository` → `send(…, GitInitResponseSchema, result, dryRun ? 200 : 201)`.

### 5. 테스트 (먼저 쓴다)

- `test/git/init.test.ts`(`makeTmpHome`): 빈 디렉토리 → `--allow-empty` 커밋 1개, 브랜치 main, `files 0`; 파일 3개 + `node_modules/x.js` + `.DS_Store` → `files 3`, `.gitignore` 생성, `git ls-files` 에 node_modules 없음; 기존 `.gitignore` 가 있으면 건드리지 않고 `createdGitignore false`; `dryRun` 은 cwd 에 `.git`·`.gitignore` 를 만들지 않고 실제와 같은 `files/bytes`; 이미 저장소 → 409; 상위가 저장소인 하위 디렉토리 → 409(메시지에 상위 경로); user.name 없는 환경(`GIT_CONFIG_GLOBAL=/dev/null` 같은 env 주입)에서도 커밋 성공.
- `test/agent-host/rest.test.ts` 확장: `POST /git/init` 201/200, 홈 밖 403, 없는 경로 400, 저장소 409, 응답 스키마 통과; 초기화 후 `POST /teams` 가 그 cwd 로 201.
- `packages/protocol` 테스트(위 2절).

## Acceptance Criteria

```bash
npm ci
npm run typecheck
npm test
test -f packages/server/src/git/init.ts
test -f packages/protocol/fixtures/rest/git-init.json
grep -q "POST /git/init" docs/PROTOCOL.md
grep -q "git-init.json" ios/MacAgentTests/ProtocolFixturesTests.swift
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 모든 경로가 `resolveInsideHome` 을 거치고 git 은 `runGit`(spawn) 만 쓰는가(CRITICAL 3, 4)?
   - `dryRun` 이 cwd 에 아무 흔적도 남기지 않는가? 실패 경로가 `.git`·우리가 만든 `.gitignore` 를 정리하는가?
   - fixture → zod → 문서 → iOS 테이블(개수 71)이 맞는가(CRITICAL 5)?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- 사용자의 전역 git 설정(`git config --global`)을 바꾸지 마라. 이유: 작성자 fallback 은 그 커밋 한 번의 `-c` 로만.
- 기존 `.gitignore` 를 덮어쓰거나 수정하지 마라. 이유: 사용자 설정이다.
- `git init` 을 저장소 안(상위에 저장소가 있는 곳)에서 허용하지 마라. 이유: 중첩 저장소는 팀 worktree·머지를 깨뜨린다.
- iOS UI 를 만들지 마라(step 1). 테이블 등록만.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
