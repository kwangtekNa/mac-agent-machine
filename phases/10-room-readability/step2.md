# Step 2: verify-and-install

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/IOS.md` 10절(10.12 포함), `/docs/PROTOCOL.md` 6.4, `/docs/RUNBOOK.md` "팀 운영"
- `/scripts/dev-smoke.sh`, `/scripts/dev-smoke.mjs`
- `/ios/MacAgentUITests/TeamRoomUITests.swift`, `SideRoomUITests.swift`(있으면)
- step 0·1 산출물 (`git diff --stat main`)

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

### 1. UI 테스트

`TeamRoomUITests`(또는 새 `WorkGroupUITests`)에 흐름을 더한다: 팀 생성 → 그룹방에서 작업이 도는 메시지를 보내 승인·변경·시스템 카드가 여러 건 쌓이게 함 → 방을 나갔다 다시 들어가면 **최근 메시지가 먼저 보인다**(맨 아래 메시지의 접근성 요소가 화면 안에 있다) → `room.workGroup.*` 셀이 보이고 탭하면 그 자리에서 개별 카드가 펼쳐진다 → 다시 탭하면 접힌다 → 대기 중 승인이 있으면 접히지 않고 그대로 보인다.

Fake 어댑터로 대기 중 승인을 만들려면 `auto-edit` 팀원을 하나 두면 된다(기본 스크립트가 승인을 요청한다). full-auto 팀원은 승인 카드를 만들지 않는다.

### 2. 검증

- `npm ci && npm run typecheck && npm test`, `bash scripts/dev-smoke.sh`.
- dev-smoke `--keep` 서버로 UI 테스트 전부 통과 후 서버 종료·`agent-host` 잔여 없음·7777 free.
- **맥락 절감 재측정**: step 0 이 갱신한 `format.test.ts` "맥락 절감 측정" 값을 summary 에 옮겨 적는다(필터 없음 → phase 9 → 이번 규칙 세 값).

### 3. iPhone 설치

기기가 케이블로 연결돼 있어야 한다. 절대 경로로 빌드한다(작업 디렉토리에 의존하지 않도록):

```bash
xcodebuild -project /Users/kwangtekna/vibe/mac-agent-machine/ios/MacAgent.xcodeproj -scheme MacAgent -destination 'id=00008150-000559441141401C' -allowProvisioningUpdates -derivedDataPath /tmp/mam-dd -quiet build
xcrun devicectl device install app --device 530EAE6A-D5BE-52C8-A0A5-E1D7B8C5E51C /tmp/mam-dd/Build/Products/Debug-iphoneos/MacAgent.app
xcrun devicectl device process launch --terminate-existing --device 530EAE6A-D5BE-52C8-A0A5-E1D7B8C5E51C dev.mam.MacAgent
```

`devicectl list devices` 가 `unavailable` 이면 케이블이 빠진 것이다(빌드가 CoreDeviceError 1011 로 실패한다). 그 경우 `blocked` 로 보고하고 사용자에게 연결을 요청하라.

**주의**: 지금 이 Mac 에는 `dev.mam.dev-gateway` LaunchAgent 가 tailnet 주소(`100.87.186.44:7777`)에 바인딩돼 **상시 실행 중**이다. dev-smoke 는 7777 을 쓰므로 검증 전에 `launchctl bootout gui/$UID/dev.mam.dev-gateway` 로 잠시 내리고, **검증이 끝나면 `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/dev.mam.dev-gateway.plist` 로 반드시 다시 올려라**(사용자가 폰에서 쓰는 서버다). 올린 뒤 `curl -s -o /dev/null -w '%{http_code}' http://100.87.186.44:7777/healthz` 가 200 인지 확인하고 summary 에 적어라.

### 4. 문서

`docs/RUNBOOK.md` "팀 운영" 에 한 줄: 방의 작업 카드는 접혀서 보이고 탭하면 펼쳐지며, 대기 중 승인은 항상 펼쳐져 있다.

## Acceptance Criteria

```bash
npm ci && npm run typecheck && npm test
launchctl bootout gui/$UID/dev.mam.dev-gateway 2>/dev/null; sleep 2
bash scripts/dev-smoke.sh
bash scripts/dev-smoke.sh --keep >/tmp/mam-ui-server.log 2>&1 & SERVER_PID=$!; sleep 25
REPO=$(grep -ao 'MAM_UI_TEST_REPO=.*' /tmp/mam-ui-server.log | head -1 | cut -d= -f2-); test -d "$REPO"
cd ios && xcodegen generate --quiet && MAM_UI_TEST_SERVER=http://127.0.0.1:7777 MAM_UI_TEST_REPO="$REPO" xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet test -only-testing:MacAgentUITests && cd ..
kill $SERVER_PID; sleep 3; pgrep -f "agent-host --socket" && exit 1 || true
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/dev.mam.dev-gateway.plist; sleep 5
curl -s -m 5 -o /dev/null -w "gateway=%{http_code}\n" http://100.87.186.44:7777/healthz
xcrun devicectl device info details --device 530EAE6A-D5BE-52C8-A0A5-E1D7B8C5E51C >/dev/null
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 검증이 끝난 뒤 `dev.mam.dev-gateway` 가 다시 떠 있고 tailnet healthz 가 200 인가?
   - 방을 열었을 때 최신 메시지가 보이는가(UI 테스트가 확인하는가)?
   - 대기 중 승인이 접히지 않는가?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(절감 수치·gateway 복구·설치 결과 포함)
   - 실패 → `error` / 개입 필요 → `blocked` / 설계 분기 → `needs_input`

## 금지사항

- 검증이 끝난 뒤 `dev.mam.dev-gateway` 를 내려둔 채 끝내지 마라. 이유: 사용자가 폰에서 쓰는 서버다.
- `tail -f` 나 끝나지 않는 대기를 쓰지 마라. 폴링은 상한을 두고(`for i in $(seq 1 60)`), 로그 grep 은 **`grep -a`** 를 써라(xcodebuild 출력에 NUL 바이트가 섞여 macOS grep 이 바이너리로 보고 건너뛴다).
- `pkill -f node` 같은 광범위한 종료를 하지 마라. 띄운 pid 만 정리한다.
- 설계 변경이 필요한 버그는 고치지 말고 `needs_input`.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
