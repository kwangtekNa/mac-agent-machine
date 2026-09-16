# Step 3: verify-and-install

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/RUNBOOK.md`(step 2 가 갱신한 스모크 문단 포함), `/docs/IOS.md` 10.13, `/docs/PROTOCOL.md` 1절
- step 0~2 산출물 (`git diff --stat main`)
- `/ios/MacAgentUITests/` 의 기존 테스트들 — 특히 팀을 만드는 흐름과 teardown 규칙
- `~/Library/LaunchAgents/dev.mam.dev-gateway.plist`(읽기만 한다. `packages/server/dist/cli.js` 를 실행하므로 빌드 후 재시작해야 반영된다)

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 배경: 이 step 이 증명할 것

사용자가 겪은 두 가지가 실제로 사라졌는지 실서버에서 확인한다.

1. 프로젝트 목록에 `agt_…` 가 없다. 2026-09-16 손 정리 직후 값은 프로젝트 13개이고 그중 `agt_` 가 6개(살아 있는 확언팀 팀원)였다. step 0 이 반영되면 **6개가 0개**가 되어야 한다.
2. 방 화면에서 파일을 열 수 있다.

## 작업

### 1. 게이트 · 단위 테스트

```bash
npm ci && npm run typecheck && npm test
cd ios && xcodegen generate --quiet && xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet test -only-testing:MacAgentTests && cd ..
```

### 2. 스모크 (게이트웨이를 내리지 않는다)

step 2 의 격리가 실제로 되는지 여기서 한 번 더 확인한다.

- 스모크 전 `~/.mam/sessions` 의 파일 수와 `~/.mam/teams` 의 디렉토리 수를 센다.
- `MAM_DEV_PORT=7799 bash scripts/dev-smoke.sh` 를 **LaunchAgent 를 내리지 않고** 돌린다.
- 스모크 뒤 같은 값을 다시 세서 **변화가 없어야 한다**. 달라지면 `status: "error"`.
- 스모크 직후 실제 게이트웨이가 여전히 응답해야 한다: tailnet 주소로 `/healthz` 200.

### 3. UI 테스트

`MAM_DEV_PORT=7799 bash scripts/dev-smoke.sh --keep` 으로 띄운 서버(임시 데이터 디렉토리)에 붙여 UI 테스트를 돌린다. 팀 파일 시트를 실제로 눌러 보는 테스트를 하나 더한다(`TeamFilesUITests` 신규 또는 `TeamRoomUITests` 확장):

새 팀 → 그룹방 → 툴바 `room.files.button` 탭 → 시트(`room.files`) → 기본 범위가 프로젝트이고 파일 목록에 저장소의 파일이 보인다 → 범위 선택(`room.files.scope`) 에서 팀원 하나 고르기 → 목록이 그 worktree 로 바뀐다 → 닫기. 정리는 기존 방식대로 REST 로 팀 삭제.

**시뮬레이터가 불안정하면** (이전 phase 에서 `Lost connection to the application` 과 `Test crashed with signal kill` 이 반복됐다) 다음을 지켜라: UI 테스트 클래스를 한 번에 하나씩 `-only-testing` 으로 돌리고, 시작 전에 `xcrun simctl shutdown` → `xcrun simctl boot` → `xcrun simctl bootstatus -b` 로 기기를 정리한다. 두 번 시도해도 같은 크래시면 그 클래스만 `needs_input` 이 아니라 summary 에 적고 나머지로 진행한다.

### 4. 실서버 반영과 확인

```bash
npm run build --workspaces --if-present
launchctl bootout gui/$UID/dev.mam.dev-gateway 2>/dev/null || true
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/dev.mam.dev-gateway.plist
```

재기동 뒤 tailnet 주소로:

- `GET /api/v1/projects` 에 이름이 `agt_` 로 시작하는 항목이 **0개**.
- 사용자의 실제 프로젝트(`affirm` 등)가 그대로 있다.
- `GET /api/v1/teams` 의 확언팀과 팀원 6명이 그대로다(팀원 세션이 지워지지 않았다).
- 프로젝트 개수를 정리 전(494) · 손 정리 후(13) · 이번 고침 후 세 값으로 summary 에 적는다.

폴링은 상한을 두고(`for i in $(seq 1 30)`), 로그를 grep 할 때는 `grep -a` 를 써라.

### 5. iPhone 설치 (최선 노력)

`xcrun devicectl list devices` 로 기기가 `available` 이면 이전 phase 와 같은 방식으로 빌드·설치한다. 케이블이 빠져 있거나 `unavailable` 이면 건너뛰고 그 사실을 summary 첫 줄에 적는다. 이것 때문에 `blocked` 로 보고하지 마라.

## Acceptance Criteria

```bash
npm ci && npm run typecheck && npm test
cd ios && xcodegen generate --quiet && xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet test -only-testing:MacAgentTests && cd ..
launchctl list | grep -q dev.mam.dev-gateway
MAM_DEV_PORT=7799 bash scripts/dev-smoke.sh
curl -sf -m 8 "http://$(/usr/local/bin/tailscale ip -4 | head -1):7777/healthz" >/dev/null
npm run build --workspaces --if-present
bash scripts/test.sh
```

그리고 4번의 "프로젝트 목록에 `agt_` 0개" 확인.

## 검증 절차

1. 위 AC 커맨드와 2·4번 확인을 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 스모크가 `~/.mam` 을 건드리지 않았는가(전후 개수 동일)?
   - 실제 게이트웨이가 끝까지 살아 있는가(폰에서 계속 쓸 수 있는가)?
   - 살아 있는 팀의 팀원 세션과 worktree 가 그대로인가?
   - 잔여 `agent-host` 프로세스가 없고 7799 가 비었는가?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(프로젝트 수 3단계, 스모크 전후 파일 수, 설치 여부)
   - 실패 → `error` / 개입 필요 → `blocked` / 설계 분기 → `needs_input`

## 금지사항

- LaunchAgent 를 내린 채로 step 을 끝내지 마라. 반드시 되살리고 응답을 확인한다.
- 사용자 데이터(`~/.mam/sessions`, `~/.mam/teams`)를 지우거나 고치지 마라. 이 step 은 확인만 한다.
- `pkill -f node` 같은 광범위한 종료를 하지 마라.
- 기기가 없다고 `blocked` 로 보고하지 마라.
- `tail -f` 나 끝나지 않는 대기를 쓰지 마라. `grep -a` 를 써라(xcodebuild 출력의 NUL 바이트 때문에 macOS grep 이 파일을 건너뛴다).
- 설계 변경이 필요한 버그는 고치지 말고 `needs_input`.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
