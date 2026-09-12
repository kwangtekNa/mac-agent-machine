# Step 8: verify-and-install

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/IOS.md` 10절, `/docs/PROTOCOL.md` 6절, `/docs/RUNBOOK.md`("팀 운영", "iPhone에 설치"), `/README.md`
- `/scripts/dev-smoke.sh`, `/scripts/dev-smoke.mjs`, `/scripts/test.sh`
- `/ios/MacAgentUITests/*.swift`
- 이 phase 의 step 0~7 산출물 전반(변경 파일 목록은 `git diff --stat main` 으로 확인)
- `/phases/2-usage-and-files/step7.md` 와 같은 설치 절차가 이 문서 아래에 있다

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

이 phase 전체를 end-to-end 로 검증하고 관리자 iPhone 에 새 빌드를 설치한다.

### 1. 전체 검증

- `npm ci && npm run typecheck && npm test`, `bash scripts/dev-smoke.sh`(팀 단계 15~20 포함).
- dev-smoke `--keep` 서버를 띄우고 UI 테스트 3개(`ApprovalFlowUITests`, `UsageAndFilesUITests`, `TeamRoomUITests`) 전부 통과. 끝나면 서버를 종료하고 `agent-host` 잔여 프로세스가 없는지 확인.
- 단위 테스트 전체(`xcodebuild test`)와 `bash scripts/test.sh`.

### 2. 실제 어댑터 확인 (비용 수 센트, 선택이 아니라 실행)

개발 gateway 를 **실제 어댑터** 로 loopback 에 띄운다(`MAM_DEV_BIND` 없이, `MAM_CODEX_BIN` 은 `zsh -ic 'command -v codex'` 로 찾아 지정, 포트가 이미 쓰이면 `MAM_DEV_PORT=7778`). `~/.mam/smoke/<ts>/repo` 같은 임시 git 저장소(홈 안)에 팀장 1명(Claude, 프리셋 팀장)짜리 팀을 `curl` 로 만들고 그룹방에 `"Reply with exactly the word pong."` 를 보낸 뒤, 방 상세에 에이전트 답변(`author.kind agent`, `work` 있음)이 오는지 확인한다. 답변 형태(홉·work 값)를 summary 에 적는다. 끝나면 팀을 지우고(`keepWorktrees` 불필요) 서버를 종료한다. Codex 도 같은 한 턴을 돌린다.

### 3. iPhone 설치

관리자 iPhone 이 케이블로 연결되어 있다(xcodebuild 대상 `id=00008150-000559441141401C`, devicectl 대상 `530EAE6A-D5BE-52C8-A0A5-E1D7B8C5E51C`, 팀 `Z2XN5A7534` 는 `ios/Local.xcconfig` 에 있음). 프로젝트 경로는 절대 경로로 지정한다(작업 디렉토리에 의존하지 않도록):

```bash
xcodebuild -project /Users/kwangtekna/vibe/mac-agent-machine/ios/MacAgent.xcodeproj -scheme MacAgent -destination 'id=00008150-000559441141401C' -allowProvisioningUpdates -derivedDataPath /tmp/mam-dd -quiet build
xcrun devicectl device install app --device 530EAE6A-D5BE-52C8-A0A5-E1D7B8C5E51C /tmp/mam-dd/Build/Products/Debug-iphoneos/MacAgent.app
xcrun devicectl device process launch --terminate-existing --device 530EAE6A-D5BE-52C8-A0A5-E1D7B8C5E51C dev.mam.MacAgent
```

기기가 연결되어 있지 않거나 서명에 실패하면 `blocked` 로 보고하라(원인 메시지 포함). 잠금 상태면 `process launch` 가 거부될 수 있으니(FBSOpenApplicationErrorDomain 7) 설치까지만 성공해도 완료로 보되 summary 에 적는다.

### 4. 문서

- `docs/RUNBOOK.md` "팀 운영" 절에 "앱에서 팀 만들기·방·머지" 단락(폰에서의 흐름 5줄)과 "worktree 에 의존성이 없으면 에이전트가 테스트를 못 돌리므로 필요하면 사용자가 worktree 에서 직접 설치" 안내.
- `README.md` 개발 빠른 시작에 "폰에서 팀 기능을 보려면 실제 어댑터 gateway 를 LAN IP 로 띄운다" 한 줄(기존 `MAM_DEV_BIND` 설명에 붙인다).

## Acceptance Criteria

```bash
npm ci && npm run typecheck && npm test
bash scripts/dev-smoke.sh
bash scripts/dev-smoke.sh --keep >/tmp/mam-ui-server.log 2>&1 & SERVER_PID=$!; sleep 25
REPO=$(grep -o 'MAM_UI_TEST_REPO=.*' /tmp/mam-ui-server.log | head -1 | cut -d= -f2-); test -d "$REPO"
cd ios && xcodegen generate --quiet && MAM_UI_TEST_SERVER=http://127.0.0.1:7777 MAM_UI_TEST_REPO="$REPO" xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet test -only-testing:MacAgentUITests && cd ..
kill $SERVER_PID; sleep 3; pgrep -f "agent-host --socket" && exit 1 || true
xcrun devicectl device info details --device 530EAE6A-D5BE-52C8-A0A5-E1D7B8C5E51C >/dev/null
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - UI 테스트 3개가 dev-smoke Fake 서버에서 통과하는가? 실제 어댑터 한 턴이 방 답변으로 돌아오는가?
   - 서버·프로토콜 코드를 바꾸지 않았는가? 바꿨다면 CRITICAL 규칙과 회귀 테스트를 지켰는가?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약. 실제 어댑터 관측값 형태·설치 결과 포함)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- 실제 어댑터 확인에서 `full-auto` 나 파일을 바꾸는 지시를 보내지 마라. pong 한 턴이면 충분하다.
- `pkill -f node` 처럼 광범위한 종료를 하지 마라. 이 step 이 띄운 pid 만 정리한다.
- 설계 변경이 필요한 버그는 고치지 말고 `needs_input`.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
