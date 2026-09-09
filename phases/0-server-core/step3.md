# Step 3: fs-git-api

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md` (CRITICAL 3, 4)
- `/docs/ARCHITECTURE.md` (6절 보안 모델의 파일 샌드박스·셸 실행 금지)
- `/docs/PROTOCOL.md` (1절의 `/fs/list`, `/fs/read`, `/git/status`, `/git/diff`)
- `/packages/protocol/src/rest.ts` (`FsListResponseSchema`, `FsEntrySchema`, `FsReadResponseSchema`, `GitStatusResponseSchema`, `GitDiffResponseSchema`가 있으면 그 타입을 쓴다. step 1이 아직 완료되지 않은 워크트리라면 `docs/PROTOCOL.md`의 형태로 로컬 타입을 정의하고 summary에 적어라)
- `/packages/server/` (step 0 뼈대)

## 작업

HTTP 없이 순수 함수/클래스로 파일 목록·읽기·언어 감지와 git 상태·diff를 만든다. step 4가 라우트에서 호출한다.

### 1. 샌드박스 `packages/server/src/fs/sandbox.ts`

```ts
export class SandboxError extends Error { code: 'forbidden' | 'not_found'; }
/** `~/`를 home으로 치환하고 절대경로로 만든 뒤 realpath로 해석해 home 안인지 검사한다. */
export async function resolveInsideHome(home: string, input: string): Promise<string>;
```

- `home`은 이미 realpath된 값이라고 가정하되, 함수 안에서 한 번 더 `realpath`한다(macOS `/var` → `/private/var` 같은 경우 대비).
- 마지막 세그먼트가 아직 없는 경로(생성 전)도 지원한다: 부모를 realpath하고 basename을 붙인다.
- 판정: `resolved === home || resolved.startsWith(home + '/')`. 아니면 `forbidden`. 존재하지 않으면 `not_found`.
- 심볼릭 링크가 홈 밖을 가리키면 realpath 결과가 밖이므로 자연히 `forbidden`이 된다. 테스트로 보장하라.

### 2. 목록 `packages/server/src/fs/list.ts`

`listDirectory(home, path, opts?: { gitStatus?: Map<string,string> }): Promise<FsListResponse>`

- 정렬: 디렉토리 먼저, 그다음 이름 로케일 무시 대소문자 무시 오름차순.
- `type`: `file | dir | symlink | other` (`lstat` 기준. 링크는 `symlink`로 두고 `size`는 null).
- `isHidden`: 이름이 `.`으로 시작. 숨김 항목도 목록에 포함한다(필터링은 클라이언트).
- `gitStatus`: 옵션 맵에 `path`(리포 루트 기준 상대경로)가 있으면 그 코드, 없으면 null. 디렉토리는 하위에 변경이 하나라도 있으면 `M`.
- `isGitRepo`: `findRepoRoot(path) !== null`.
- 항목 수 상한 5,000. 넘으면 앞 5,000개와 함께 `truncated: true`를 응답에 추가하고 protocol 스키마에 없다면 문서·fixture·스키마를 함께 갱신하지 말고 summary에 제안만 남겨라(이 step은 protocol을 건드리지 않는다).

### 3. 읽기 `packages/server/src/fs/read.ts`

`readFileForClient(home, path): Promise<FsReadResponse>`

- 바이너리 판정: 앞 8 KiB에 NUL 바이트가 있으면 바이너리.
- 텍스트: UTF-8로 최대 1 MiB. 넘으면 앞 1 MiB만 `truncated: true`.
- 이미지 확장자(`png jpg jpeg gif webp heic svg`): 5 MiB까지 `encoding: "base64"`. `svg`는 텍스트지만 이미지 취급해 base64로 준다.
- 그 외 바이너리: `FsError('unsupported_media')` → step 4가 415로 매핑.
- 디렉토리를 읽으려 하면 `invalid_request`.

### 4. 언어 감지 `packages/server/src/fs/language.ts`

`languageForPath(path): string` 확장자 → 소문자 식별자. 최소: ts/tsx→`typescript`, js/mjs/cjs/jsx→`javascript`, swift, py→`python`, rb→`ruby`, go, rs→`rust`, java, kt→`kotlin`, c/h→`c`, cc/cpp/hpp→`cpp`, m/mm→`objective-c`, sh/zsh/bash→`shell`, json, yaml/yml→`yaml`, toml, md→`markdown`, html, css, scss, sql, xml, plist→`xml`, Dockerfile→`dockerfile`, Makefile→`makefile`, 그 외 `plaintext`.

### 5. git `packages/server/src/git/`

- `status.ts`: `findRepoRoot(dir): Promise<string | null>` (`git -C dir rev-parse --show-toplevel`), `gitStatus(cwd): Promise<GitStatusResponse>` (`git -C cwd status --porcelain=v2 --branch -z` 파싱: branch, ahead/behind, entries의 `index`/`worktree` 코드, rename은 새 경로), `gitStatusMap(cwd): Promise<Map<string,string>>` (상대경로 → 한 글자 코드: worktree 코드 우선, 없으면 index 코드, untracked `?`, ignored `!`).
- `diff.ts`: `gitDiff(cwd, opts: { path?: string; staged?: boolean }): Promise<GitDiffResponse>` (`git -C cwd diff [--cached] -- [path]`). untracked 파일은 `git diff --no-index /dev/null <path>`로 패치를 만든다(exit code 1이 정상임에 유의).
- 모든 git 호출은 `spawn('git', [...args])` + 타임아웃 10초. `shell: true` 금지. 리포가 아니면 `isRepo: false`와 빈 값.

### 6. 테스트 (`packages/server/test/fs/`, `test/git/`)

- 임시 홈 디렉토리를 만들어 실제 파일·심볼릭 링크·`git init` 리포로 테스트한다(`os.tmpdir()` 아래, 테스트 후 삭제).
- 샌드박스: `..` 탈출, 홈 밖 심볼릭 링크, `~/` 치환, `/private/var` realpath 케이스, 존재하지 않는 경로.
- 목록 정렬과 gitStatus 병합, 읽기의 1 MiB 절단, 바이너리 판정, 이미지 base64, 디렉토리 읽기 오류.
- git: 깨끗한 리포, 수정·추가·untracked·rename, 리포가 아닌 디렉토리, diff/untracked diff.

## Acceptance Criteria

```bash
npm ci
npm run typecheck
npm test
bash scripts/test.sh
grep -rn "shell: true" packages/server/src && exit 1 || true   # 셸 실행 금지 확인
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 모든 파일 접근이 `resolveInsideHome`을 거치는가(CRITICAL 3)?
   - 자식 프로세스가 전부 인자 배열 `spawn`인가(CRITICAL 4)?
   - 응답 형태가 `docs/PROTOCOL.md` 1절과 일치하는가?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- 파일 쓰기/삭제 API를 만들지 마라. 이유: v1 범위는 읽기 전용 파일 브라우저다(PRD 6절).
- `simple-git` 같은 의존성을 추가하지 마라. 이유: step 0이 의존성을 고정했고 git CLI spawn으로 충분하다.
- `packages/protocol`을 수정하지 마라. 이유: 계약 변경은 별도 절차다. 필요하면 summary에 제안만 남겨라.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
