# Step 2: verify-and-install

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/PROTOCOL.md` `POST /git/init`, `/docs/IOS.md` 9.2·10.1, `/docs/RUNBOOK.md` "팀 운영", `/README.md`
- `/scripts/dev-smoke.sh`, `/scripts/dev-smoke.mjs` (팀 단계 15~20, `teamSteps(cwd)`, `--keep` 의 `MAM_UI_TEST_REPO` 출력)
- `/ios/MacAgentUITests/TeamRoomUITests.swift`, `UsageAndFilesUITests.swift` (새 폴더 만들기·정리 패턴, `MAM_UI_TEST_SERVER` 게이트)
- step 0·1 산출물 (`git diff --stat main`)

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

### 1. dev-smoke 21단계

팀 단계 뒤에: `~/.mam/smoke/<ts>/fresh` 디렉토리를 만들고 파일 2개 + `node_modules/x.js` 를 넣은 뒤 `POST /git/init { cwd, dryRun: true }` → 200, `files 2`, `initialized false`, 디렉토리에 `.git` 없음 → `POST /git/init { cwd }` → 201, `commit` 40자, `.gitignore` 존재, `git -C fresh log --oneline` 1줄, `git ls-files` 에 `node_modules` 없음 → 같은 cwd 로 `POST /teams`(팀장 1명) → 201 → `DELETE /teams/:id` → 200 → 다시 `POST /git/init` → 409.

### 2. UI 테스트 `ios/MacAgentUITests/GitInitUITests.swift`

`MAM_UI_TEST_SERVER` 없으면 skip. 흐름: 홈 `+` → 새 팀 → 이름 → 디렉토리 "찾아보기" → 새 폴더 `ui-git-<ts>` → 그 폴더에서 툴바 `directoryPicker.gitInit` → 확인 다이얼로그(문구에 "빈 저장소") → 초기화 → 목록에 git 표시 → "이 폴더 선택" → 시트의 디렉토리 행에 "git 저장소 (main)" → 팀원 1명(팀장, 프리셋 팀장) 추가 → 팀 만들기 → 방 목록에 `rooms.group`. 정리: REST 로 팀 삭제(`keepWorktrees=true`) + 만든 폴더 삭제(`FileManager`, 시뮬레이터는 호스트 파일시스템). 두 번째 시나리오(짧게): 새 팀 시트에서 "직접 입력" 으로 같은 종류의 새 폴더 경로를 넣으면 `newTeam.gitInit` 이 보이고 초기화 후 사라진다.

### 3. 검증·설치

- `npm ci && npm run typecheck && npm test`, `bash scripts/dev-smoke.sh`(21단계 포함).
- dev-smoke `--keep` 서버로 UI 테스트 4개 전부(`ApprovalFlow`, `UsageAndFiles`, `TeamRoom`, `GitInit`) 통과 후 서버 종료, `agent-host` 잔여 없음.
- 실제 어댑터 확인은 이 phase 에서는 필요 없다(git 만 바뀌었다).
- iPhone 설치(절대 경로 프로젝트, phase 4 step 8 과 동일):

```bash
xcodebuild -project /Users/kwangtekna/vibe/mac-agent-machine/ios/MacAgent.xcodeproj -scheme MacAgent -destination 'id=00008150-000559441141401C' -allowProvisioningUpdates -derivedDataPath /tmp/mam-dd -quiet build
xcrun devicectl device install app --device 530EAE6A-D5BE-52C8-A0A5-E1D7B8C5E51C /tmp/mam-dd/Build/Products/Debug-iphoneos/MacAgent.app
xcrun devicectl device process launch --terminate-existing --device 530EAE6A-D5BE-52C8-A0A5-E1D7B8C5E51C dev.mam.MacAgent
```

기기가 없거나 서명 실패면 `blocked`. 잠금으로 launch 만 거부되면 설치까지로 완료 처리하고 summary 에 적는다.

### 4. 문서

- `docs/IOS.md` 10절에 `10.7 저장소 초기화`(진입점 두 곳, 확인 문구 규칙, 식별자 `newTeam.gitInit`·`directoryPicker.gitInit`), 식별자 표 갱신.
- `README.md` iOS 절 UI 테스트 4개로 갱신. RUNBOOK 은 step 0 이 적은 단락을 확인만.

## Acceptance Criteria

```bash
npm ci && npm run typecheck && npm test
bash scripts/dev-smoke.sh
bash scripts/dev-smoke.sh --keep >/tmp/mam-ui-server.log 2>&1 & SERVER_PID=$!; sleep 25
REPO=$(grep -o 'MAM_UI_TEST_REPO=.*' /tmp/mam-ui-server.log | head -1 | cut -d= -f2-); test -d "$REPO"
cd ios && xcodegen generate --quiet && MAM_UI_TEST_SERVER=http://127.0.0.1:7777 MAM_UI_TEST_REPO="$REPO" xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet test -only-testing:MacAgentUITests && cd ..
kill $SERVER_PID; sleep 3; pgrep -f "agent-host --socket" && exit 1 || true
xcrun devicectl device info details --device 530EAE6A-D5BE-52C8-A0A5-E1D7B8C5E51C >/dev/null
grep -q "10.7" docs/IOS.md
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 스모크·UI 테스트가 `POST /git/init` 의 dryRun → 확인 → 초기화 → 팀 생성 흐름을 실제로 통과하는가?
   - 서버·프로토콜 코드를 바꿨다면 CRITICAL 규칙과 회귀 테스트를 지켰는가?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약, 설치 결과 포함)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- `pkill -f node` 같은 광범위한 종료를 하지 마라. 이 step 이 띄운 pid 만 정리한다.
- 설계 변경이 필요한 버그는 고치지 말고 `needs_input`.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
