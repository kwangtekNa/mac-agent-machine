# Step 2: verify-and-install

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/IOS.md` 10절, `/docs/PROTOCOL.md` 4절·6.2, `/docs/RUNBOOK.md` "팀 운영", `/README.md`
- `/scripts/dev-smoke.sh`, `/scripts/dev-smoke.mjs` (팀 단계, `--keep` 의 `MAM_UI_TEST_REPO`)
- `/ios/MacAgentUITests/TeamRoomUITests.swift` 와 다른 UI 테스트
- step 0·1 산출물 (`git diff --stat main`)

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

### 1. dev-smoke 확장

팀 단계 안에서: `PATCH /teams/:id/members/:memberId { mode: "full-auto" }` → 200, 응답 `members[].mode == "full-auto"`; 이어서 그 팀원에게 메시지(Fake 기본 스크립트는 승인을 요청하는데, full-auto 세션에서는 **승인 카드가 오지 않고** 바로 답변이 와야 한다 — Fake 어댑터가 `mode === "full-auto"` 면 `autoApprove` 로 동작하도록 step 0 에서 이미 바뀌었는지 확인하고, 아니면 Fake 만 최소 수정); `PATCH { effort: "low" }` → 응답 반영; `PATCH { model: "fake-mini" }` → 응답 반영(다음 세션부터라는 의미는 문서 확인만).

### 2. UI 테스트 확장 (`TeamRoomUITests`)

팀 생성 뒤 방 툴바의 팀원 시트 → `room.member.<id>` 탭 → `memberControl.effort` 에서 "low" 선택 → 시트에 low 표시; `memberControl.mode` 에서 full-auto → 확인 다이얼로그 → "full-auto로 전환" → 표시 갱신. 그 뒤 기존 흐름(멘션 → 답변)이 승인 카드 없이 진행되면 승인 단계는 건너뛴다(둘 다 허용하도록 분기).

### 3. 검증·설치

- `npm ci && npm run typecheck && npm test`, `bash scripts/dev-smoke.sh`.
- dev-smoke `--keep` 서버로 UI 테스트 전부 통과, 서버 종료·잔여 없음.
- **실제 어댑터 확인**(비용 수 센트): loopback 개발 gateway(실제 어댑터)로 팀장 1명(Claude, full-auto) 팀을 만들고 그룹방에 `"Use the Bash tool to run: echo pong. Reply with only its output."` → 방에 승인 카드 없이 답변(pong, `work.toolCalls >= 1`). Codex 팀원으로도 한 번. 결과 형태를 summary 에 적고 팀을 지우고 서버를 끈다.
- iPhone 설치(절대 경로 프로젝트, phase 4 step 8 과 동일한 세 명령). 기기 없음·서명 실패는 `blocked`, 잠금으로 launch 만 거부되면 설치까지로 완료.

### 4. 문서

- `docs/IOS.md` 10절에 `10.8 팀원 제어(권한·모델·사고 수준)` + 식별자 표 갱신.
- `docs/PROTOCOL.md` 4절 모드 매핑 표에 Claude `allowDangerouslySkipPermissions` 주석 한 줄, `docs/ADR.md` ADR-015 에 "full-auto 는 모든 도구 승인 없음(2026-09-13 확정)" 추가.
- `docs/RUNBOOK.md` "팀 운영" 에 "권한·모델·사고 수준은 편집기와 방의 팀원 시트에서" 한 줄.

## Acceptance Criteria

```bash
npm ci && npm run typecheck && npm test
bash scripts/dev-smoke.sh
bash scripts/dev-smoke.sh --keep >/tmp/mam-ui-server.log 2>&1 & SERVER_PID=$!; sleep 25
REPO=$(grep -o 'MAM_UI_TEST_REPO=.*' /tmp/mam-ui-server.log | head -1 | cut -d= -f2-); test -d "$REPO"
cd ios && xcodegen generate --quiet && MAM_UI_TEST_SERVER=http://127.0.0.1:7777 MAM_UI_TEST_REPO="$REPO" xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet test -only-testing:MacAgentUITests && cd ..
kill $SERVER_PID; sleep 3; pgrep -f "agent-host --socket" && exit 1 || true
xcrun devicectl device info details --device 530EAE6A-D5BE-52C8-A0A5-E1D7B8C5E51C >/dev/null
grep -q "10.8" docs/IOS.md
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 실제 어댑터에서 full-auto 가 승인 없이 도구를 실행했는가(Claude·Codex 둘 다)?
   - 서버 코드를 고쳤다면 CRITICAL 규칙과 회귀 테스트를 지켰는가?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약. 실제 어댑터 관측값·설치 결과 포함)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- 실제 어댑터 확인에서 파일을 바꾸는 지시를 보내지 마라. `echo pong` 한 턴이면 충분하다.
- `tail -f` 같은 끝나지 않는 대기를 쓰지 마라. 이유: 이전 phase 에서 세션이 30분 타임아웃으로 날아갔다. 폴링은 `until … ; do sleep 2; done` 에 상한을 둔다.
- `pkill -f node` 같은 광범위한 종료를 하지 마라.
- 설계 변경이 필요한 버그는 고치지 말고 `needs_input`.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
