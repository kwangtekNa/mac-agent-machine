# Step 7: verify-and-install

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/IOS.md` (9절), `/docs/PROTOCOL.md` (추가분), `/docs/RUNBOOK.md`, `/README.md`
- `/scripts/dev-smoke.sh`, `/scripts/dev-smoke.mjs`, `/scripts/test.sh`
- `/ios/MacAgentUITests/ApprovalFlowUITests.swift` (Phase 1 step 8)
- 이 phase의 step 0~6 산출물 전반(변경 파일 목록은 `git diff --stat main` 으로 확인)

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

이 phase 전체를 end-to-end로 검증하고, 관리자 iPhone에 새 빌드를 설치한다.

### 1. e2e 스모크 확장 (`scripts/dev-smoke.mjs`)

기존 10단계 뒤에 추가: (11) `POST /fs/mkdir` `~/.mam/smoke/<ts>/sub` → 201, 다시 → 409; (12) 턴 완료 후 `GET /sessions/:id`의 `usage.turns == 1`, `usage.context.percent`가 0~100, WS 이벤트 중 `session.usage`가 있었는지; (13) `GET /usage` → agents 2개, `GET /models?agent=claude` → `models.length ≥ 1`; (14) `PATCH /sessions/:id { model: 'fake-mini' }` → 200, 잘못된 모델 → 400.

### 2. UI 테스트 (`ios/MacAgentUITests/`)

`UsageAndFilesUITests.swift`(서버 없으면 `XCTSkip`): 새 세션 → "찾아보기" → 새 폴더 `ui-<timestamp>` → 선택 → 세션 시작 → 세그먼트 "파일" 탭에서 빈 폴더 → "대화"로 돌아와 "hello" → 허용 → 제목 아래 "컨텍스트" 텍스트 존재 → 세션 정보 시트의 "사용량" 섹션에 "턴" 텍스트 존재. 접근성 식별자는 필요한 곳에 추가(`newSession.browse`, `directoryPicker.newFolder`, `directoryPicker.pick`, `timeline.tab.files`, `timeline.contextGauge`).

### 3. 실제 어댑터 확인 (비용 수 센트)

개발 gateway를 **실제 어댑터**로 띄워(`MAM_DEV_BIND` 없이 loopback, `MAM_CODEX_BIN`은 `zsh -ic 'command -v codex'`로 찾아 지정) Claude 세션 하나에 `"Reply with exactly the word pong."`를 보내고 `session.usage`가 오는지, `GET /usage`에 Claude 관측값(턴을 돌린 뒤)과 Codex 즉시 조회값이 들어오는지 `curl`로 확인해 summary에 값 형태(숫자 범위, 라벨)를 적어라. 끝나면 서버를 종료한다.

### 4. iPhone 설치

관리자 iPhone이 케이블로 연결되어 있다(xcodebuild 대상 `id=00008150-000559441141401C`, devicectl 대상 `530EAE6A-D5BE-52C8-A0A5-E1D7B8C5E51C`, 팀 `Z2XN5A7534`는 `ios/Local.xcconfig`에 있음). 다음을 실행한다:

```bash
cd ios && xcodebuild -scheme MacAgent -destination 'id=00008150-000559441141401C' -allowProvisioningUpdates -derivedDataPath /tmp/mam-dd -quiet build
xcrun devicectl device install app --device 530EAE6A-D5BE-52C8-A0A5-E1D7B8C5E51C /tmp/mam-dd/Build/Products/Debug-iphoneos/MacAgent.app
xcrun devicectl device process launch --terminate-existing --device 530EAE6A-D5BE-52C8-A0A5-E1D7B8C5E51C dev.mam.MacAgent
```

기기가 연결되어 있지 않거나 서명에 실패하면 `blocked`로 보고하라(원인 메시지 포함).

### 5. 문서

- `README.md`: 개발 빠른 시작에 새 엔드포인트 curl 예시 1개(`/usage`), iOS 절에 UI 테스트 2개 명시.
- `docs/RUNBOOK.md`: 사용자 온보딩에 "앱에서 사용 한도 보기" 한 줄과, Claude 한도는 세션을 돌려야 갱신된다는 안내.

## Acceptance Criteria

```bash
npm ci && npm run typecheck && npm test
bash scripts/dev-smoke.sh
bash scripts/dev-smoke.sh --keep >/tmp/mam-ui-server.log 2>&1 & SERVER_PID=$!; sleep 20
cd ios && MAM_UI_TEST_SERVER=http://127.0.0.1:7777 xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet test -only-testing:MacAgentUITests && cd ..
kill $SERVER_PID; sleep 3; pgrep -f "agent-host --socket" && exit 1 || true
xcrun devicectl device info details --device 530EAE6A-D5BE-52C8-A0A5-E1D7B8C5E51C >/dev/null   # 기기 연결 확인
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 스모크와 UI 테스트가 `docs/PROTOCOL.md` 추가분과 `docs/IOS.md` 9절을 실제로 통과하는가?
   - 서버 코드 수정이 있었다면 CRITICAL 규칙을 지키고 회귀 테스트를 추가했는가?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약. 실제 어댑터 관측값 형태 포함)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- 실제 어댑터 확인에서 `full-auto`나 파일을 바꾸는 지시를 보내지 마라. pong 한 턴이면 충분하다.
- `pkill -f node`처럼 광범위한 종료를 하지 마라. 이 step이 띄운 pid만 정리한다.
- 설계 변경이 필요한 버그는 고치지 말고 `needs_input`.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
