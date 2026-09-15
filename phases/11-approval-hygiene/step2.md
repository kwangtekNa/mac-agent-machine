# Step 2: verify-and-install

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/RUNBOOK.md` "팀 운영" 과 개발용 게이트웨이 운영 문단
- `/scripts/test.sh`, `/scripts/dev-smoke.sh`
- step 0·1 산출물 (`git diff --stat main`)
- `~/Library/LaunchAgents/dev.mam.dev-gateway.plist` (읽기만 한다. 이 LaunchAgent 는 `packages/server/dist/cli.js` 를 실행하므로 **빌드 후 재시작해야 고침이 반영된다**)

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 배경: 이 step 이 실제로 증명해야 하는 것

사용자의 실제 팀(`확언팀`)에는 지금 세션에 존재하지 않는 유령 승인 카드가 남아 있다. 이 phase 를 시작하기 전 실측값이다:

| 방 | 미해결 승인 카드 |
|---|---|
| `전체` (그룹방) | 2건 |
| `머스크 ↔ 올트먼 ↔ icml` (곁방) | 1건 |

셋 다 같은 세션(`ses_01M2CXVR7B1H2J75V9VZB2M3B3`)의 것이고, 그 세션의 대기 승인은 0 이다. step 0 의 재조정이 게이트웨이 재시작과 함께 반영되면 **이 카드들이 전부 `by: "system"` 으로 정리돼야 한다.** 개수는 그 사이 사용자가 앱을 쓰면 달라질 수 있으니, 고정 숫자가 아니라 "재시작 뒤 미해결 카드가 0 건" 을 기준으로 삼는다.

## 작업

### 1. 게이트 · 스모크

```bash
npm ci && npm run typecheck && npm test
cd ios && xcodegen generate --quiet && xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet test -only-testing:MacAgentTests && cd ..
```

`bash scripts/dev-smoke.sh` 는 개발용 게이트웨이가 7777 을 점유하므로 **아래 3번에서 LaunchAgent 를 내린 뒤** 돌린다.

### 2. 재조정 전 상태 기록

개발용 게이트웨이의 주소는 tailnet IP 다(`MAM_DEV_BIND=tailscale`, 루프백으로는 열리지 않는다). 주소는 이렇게 얻는다:

```bash
BASE="http://$(/usr/local/bin/tailscale ip -4 | head -1):7777/api/v1"
```

`GET $BASE/teams` → 각 팀의 `rooms[]` → `GET $BASE/teams/<teamId>/rooms/<roomId>` 를 돌며 `kind == "approval" && approval.resolution == null` 인 메시지 수를 세어 **재시작 전 값**으로 적어 둔다. 짧은 python3 스크립트로 해도 되고 `curl`+`python3 -c` 조합도 좋다. 결과(팀·방별 건수)를 summary 에 넣는다.

### 3. 빌드 → LaunchAgent 재시작 → dev-smoke

```bash
launchctl bootout gui/$UID/dev.mam.dev-gateway 2>/dev/null || true
npm run build --workspaces --if-present
bash scripts/dev-smoke.sh
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/dev.mam.dev-gateway.plist
```

- dev-smoke 는 LaunchAgent 가 내려간 상태에서 7777 로 돈다.
- 재시작 뒤 `launchctl print gui/$UID/dev.mam.dev-gateway` 또는 `launchctl list | grep dev.mam` 로 살아 있는지, `~/.mam/dev-gateway.log` 마지막 줄에 `gateway listening on http://100.x.x.x:7777` 이 있는지 확인한다.
- 폴링은 반드시 상한을 둔다(`for i in $(seq 1 30)`). `tail -f` 나 끝나지 않는 대기를 쓰지 마라.

### 4. 재조정 후 검증 (이 step 의 핵심 AC)

같은 방식으로 다시 훑어 **모든 팀·모든 방에서 `kind == "approval" && approval.resolution == null` 인 메시지가 0 건**임을 확인한다. 하나라도 남으면:

- 그 카드의 `approval.sessionId` 로 `GET $BASE/sessions/<sessionId>` 를 보고 `pendingApprovals` 가 0 이 아니면 **정상**(살아 있는 승인은 정리하지 않는 것이 설계다). 그 경우만 예외로 인정하고 summary 에 적는다.
- `pendingApprovals` 가 0 인데 카드가 남았으면 step 0 의 재조정이 동작하지 않은 것이다 → `status: "error"`.

정리된 카드 하나를 골라 `approval.resolution` 이 `{ "optionId": "abort", "by": "system", "at": ... }` 인지도 확인해 summary 에 적는다.

### 5. 문서

`docs/RUNBOOK.md` 의 팀 운영 문단에 한 줄: 서버를 다시 시작하면 답을 받지 못한 승인 카드는 "시스템이 취소함" 으로 정리된다. 에이전트는 그 턴을 잃으므로 필요하면 방에 다시 요청하면 된다.

### 6. iPhone 설치 (최선 노력)

```bash
xcrun devicectl list devices
```

- 기기가 `available` 이면 이전 phase 와 같은 세 명령으로 빌드·설치한다(절대 경로 프로젝트, `ios/Local.xcconfig` 서명).
- 케이블이 빠져 있거나 `unavailable`(CoreDeviceError 1011) 이면 **설치를 건너뛰고 그대로 진행한다.** 이 phase 의 실제 효과(유령 카드 정리)는 서버 쪽이라 앱을 다시 깔지 않아도 사용자에게 바로 보인다. 건너뛴 사실과 이유를 summary 첫 줄에 적는다. 이것 때문에 `blocked` 로 보고하지 마라.

## Acceptance Criteria

```bash
npm ci && npm run typecheck && npm test
cd ios && xcodegen generate --quiet && xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet test -only-testing:MacAgentTests && cd ..
launchctl bootout gui/$UID/dev.mam.dev-gateway 2>/dev/null || true
npm run build --workspaces --if-present
bash scripts/dev-smoke.sh
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/dev.mam.dev-gateway.plist
launchctl list | grep -q dev.mam.dev-gateway
grep -q "시스템이 취소함" docs/RUNBOOK.md || grep -q "취소" docs/RUNBOOK.md
bash scripts/test.sh
```

그리고 4번의 "미해결 승인 카드 0 건"(또는 살아 있는 승인만 남음) 확인.

## 검증 절차

1. 위 AC 커맨드와 4번 검증을 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 개발용 게이트웨이가 다시 살아 있고 tailnet 주소로 응답하는가(폰에서 계속 쓸 수 있는가)?
   - dev-smoke 뒤 `agent-host` 잔여 프로세스가 없는가?
   - 살아 있는 승인을 지우지 않았는가?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(재시작 전/후 미해결 카드 수, 설치 여부)
   - 실패 → `error` / 개입 필요 → `blocked` / 설계 분기 → `needs_input`

## 금지사항

- `pkill -f node` 같은 광범위한 종료를 하지 마라. 이유: 사용자의 개발용 게이트웨이와 팀 세션이 함께 죽는다. 띄운 pid 와 이름 있는 LaunchAgent 만 다룬다.
- LaunchAgent 를 내린 채로 step 을 끝내지 마라. 이유: 사용자가 폰에서 접속하지 못하게 된다. 반드시 `bootstrap` 으로 되살리고 살아 있음을 확인한다.
- plist 파일을 고치지 마라. 읽기만 한다.
- `~/.mam/teams/` 아래 파일을 직접 수정하거나 지우지 마라. 이유: 실제 사용자 데이터다. 정리는 서버 코드가 한다.
- 기기가 없다고 `blocked` 로 보고하지 마라(6번 참고).
- `tail -f` 나 끝나지 않는 대기를 쓰지 마라. 로그를 grep 할 때는 `grep -a` 를 써라. 이유: xcodebuild 출력의 NUL 바이트 때문에 macOS grep 이 파일을 바이너리로 보고 건너뛴다.
- 설계 변경이 필요한 버그는 고치지 말고 `needs_input`.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
