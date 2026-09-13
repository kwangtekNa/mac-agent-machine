# Step 3: verify-and-install

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/IOS.md` 10절, `/docs/PROTOCOL.md` `GET /net/ports`, `/docs/RUNBOOK.md` 8절, `/README.md`
- `/scripts/dev-smoke.sh`, `/scripts/dev-smoke.mjs`, `/scripts/install-dev-gateway.sh`
- `/packages/server/src/agents/fake/script.ts`, `/ios/MacAgentUITests/*.swift`
- step 0~2 산출물 (`git diff --stat main`)

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

### 1. dev-smoke 22단계

`node:net` 으로 임시 서버를 `127.0.0.1:0` 에 띄운 뒤 `GET /api/v1/net/ports` 에 그 포트가 `address 127.0.0.1` 로 있고 gateway 포트(7777)는 없음을 확인, 임시 서버 종료 후 목록에서 사라짐.

### 2. Fake 스크립트 + UI 테스트

- `agents/fake/script.ts`: 입력에 `serve <port>` 가 있으면 답변 텍스트에 `http://localhost:<port>/` 링크(마크다운)를 넣는다(서버는 띄우지 않는다).
- `ios/MacAgentUITests/PreviewUITests.swift`(`MAM_UI_TEST_SERVER` 없으면 skip): 세션에서 `serve 3456` 전송 → 답변 카드의 링크 탭 → `SFSafariViewController`(접근성: 브라우저 화면의 "완료"/닫기 버튼 존재)가 뜨는지 → 닫기; 방/세션 툴바 `timeline.preview` → 시트에 "열린 포트" 섹션이 뜨는지(dev-smoke `--keep` 서버가 띄운 임시 포트가 있으면 행 존재, 없으면 빈 문구).

### 3. 검증·설치

- `npm ci && npm run typecheck && npm test`, `bash scripts/dev-smoke.sh`(22단계), `bash scripts/install-dev-gateway.sh --dry-run | plutil -lint -`.
- dev-smoke `--keep` 서버로 UI 테스트 전부 통과, 서버 종료·잔여 없음.
- iPhone 설치(절대 경로 프로젝트, phase 4 step 8 과 동일한 세 명령). 기기 없음·서명 실패는 `blocked`.

### 4. 문서

- `docs/IOS.md` 10절에 `10.9 미리보기(localhost 링크·열린 포트)` + 식별자 표.
- `README.md` iOS 절 UI 테스트 5개.

## Acceptance Criteria

```bash
npm ci && npm run typecheck && npm test
bash scripts/dev-smoke.sh
bash scripts/install-dev-gateway.sh --dry-run | plutil -lint -
bash scripts/dev-smoke.sh --keep >/tmp/mam-ui-server.log 2>&1 & SERVER_PID=$!; sleep 25
REPO=$(grep -o 'MAM_UI_TEST_REPO=.*' /tmp/mam-ui-server.log | head -1 | cut -d= -f2-); test -d "$REPO"
cd ios && xcodegen generate --quiet && MAM_UI_TEST_SERVER=http://127.0.0.1:7777 MAM_UI_TEST_REPO="$REPO" xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet test -only-testing:MacAgentUITests && cd ..
kill $SERVER_PID; sleep 3; pgrep -f "agent-host --socket" && exit 1 || true
xcrun devicectl device info details --device 530EAE6A-D5BE-52C8-A0A5-E1D7B8C5E51C >/dev/null
grep -q "10.9" docs/IOS.md
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 링크 변환·포트 목록·설치 스크립트가 각각 문서와 일치하는가?
   - 이 step 이 끝난 뒤 7777 을 듣는 프로세스가 없는가?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약. 설치 결과 포함)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- `launchctl` 로 LaunchAgent 를 실제 설치하지 마라(사용자가 한다).
- `tail -f` 같은 끝나지 않는 대기를 쓰지 마라(상한 있는 폴링만).
- `pkill -f node` 같은 광범위한 종료를 하지 마라.
- 설계 변경이 필요한 버그는 고치지 말고 `needs_input`.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
