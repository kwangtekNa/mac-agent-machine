# Step 4: verify-and-install

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/PROTOCOL.md` 6절, `/docs/IOS.md` 10절, `/docs/RUNBOOK.md` "팀 운영", `/README.md`
- `/scripts/dev-smoke.sh`, `/scripts/dev-smoke.mjs`(팀 단계 15~20 과 그 뒤 번호들 — 실제 번호는 파일에서 확인한다)
- `/packages/server/src/agents/fake/script.ts`(`ask @<핸들>`, `write file <이름>` 지시)
- `/ios/MacAgentUITests/TeamRoomUITests.swift`
- step 0~3 산출물 (`git diff --stat main`)

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

### 1. dev-smoke 확장 (기존 마지막 번호 + 1)

팀 단계 안에서 팀원 3명(팀장·개발자·리뷰어)으로:

1. 그룹방에 `"@minsu jiyeon 에게 ask @jiyeon 로 물어봐줘"` 같은 식으로 **팀장이 개발자를 부르게** 만든다(Fake 의 `ask @<핸들>` 지시 활용).
2. `GET /teams/:id` 의 `rooms` 에 `kind: "side"` 방이 1개 생겼고 `participants` 가 두 팀원인지.
3. 그룹방 상세에 `sideRoom.kind === "opened"` 시스템 메시지가 1건, 개발자의 답변은 **그룹방에 없고** 곁방 상세에 있는지.
4. 연쇄가 끝난 뒤 그룹방에 `sideRoom.kind === "closed"` 카드가 1건이고 `messages` 가 곁방 메시지 수와 같은지.
5. 같은 조합을 다시 부르면 방 수가 늘지 않는지.
6. 곁방에 `POST .../messages { text: "정리해줘" }`(멘션 없음) → `dispatches` 가 참가자 수만큼인지.
7. **맥락 격리 검증**: 곁방에 참가하지 않은 세 번째 팀원을 그룹방에서 부르고, 그 팀원 세션의 마지막 턴 입력(Fake 가 `system` 아이템으로 남기는 instructions 가 아니라, `GET /sessions/:id` 타임라인의 `user_message` 본문)에 곁방 메시지 문구가 **없는지** 확인한다.

### 2. UI 테스트 (`TeamRoomUITests` 확장 또는 `SideRoomUITests` 신규)

새 팀 → 그룹방에서 팀장이 개발자를 부르게 하는 메시지 전송 → 그룹방에 연결 카드(`room.sideRoom.*`) 등장 → 탭 → 곁방 화면(제목 `↔`, 부제 "에이전트 간") → 메시지 존재 → 뒤로 → 방 목록에 "에이전트 간" 섹션과 `rooms.side.*` 행 → 곁방에 사람이 직접 한 줄 보내기 → 컴포저 캡션 "참가자 전원에게 전달됩니다" 확인. 정리는 기존 UI 테스트와 같은 방식(REST 팀 삭제).

### 3. 검증·설치

- `npm ci && npm run typecheck && npm test`, `bash scripts/dev-smoke.sh`.
- dev-smoke `--keep` 서버로 UI 테스트 전부 통과 후 서버 종료·`agent-host` 잔여 없음·7777 free.
- **효과 측정(중요)**: 스모크가 만든 팀의 그룹방·곁방 로그로 "한 팀원의 턴 입력에 들어간 문자 수"를 step 0 이전 규칙과 비교해 summary 에 적는다. 비교는 `buildTurnText` 를 두 번(필터 on/off) 호출하는 **단위 테스트**로 하고(`test/teams/format.test.ts` 에 측정용 케이스 1개), 실측 로그가 아니라 그 수치를 보고한다.
- iPhone 설치(절대 경로 프로젝트, 이전 phase 와 같은 세 명령). 기기 없음·서명 실패는 `blocked`.

### 4. 문서

- `docs/IOS.md` 10절에 `10.11 곁방(에이전트 간 대화)` + 식별자 표(`rooms.side.<roomId>`, `room.sideRoom.<roomId>`).
- `docs/RUNBOOK.md` "팀 운영" 에 한 단락: 에이전트끼리 부르면 자동으로 곁방이 열리고 그룹방에는 연결 카드만 남는다, 곁방에 직접 끼어들 수 있다, 참가자 상한(`sideRoomMaxParticipants`, 기본 3)을 넘는 호출은 그룹방 공지로 처리된다.
- `docs/ADR.md` ADR-018: "에이전트 간 대화는 곁방으로 분리하고 턴 입력은 본인 관련 카드만" — 근거로 측정치(무관 비율 57%, 팀장 92%, 상한 초과로 잘린 턴)를 적는다.

## Acceptance Criteria

```bash
npm ci && npm run typecheck && npm test
bash scripts/dev-smoke.sh
bash scripts/dev-smoke.sh --keep >/tmp/mam-ui-server.log 2>&1 & SERVER_PID=$!; sleep 25
REPO=$(grep -ao 'MAM_UI_TEST_REPO=.*' /tmp/mam-ui-server.log | head -1 | cut -d= -f2-); test -d "$REPO"
cd ios && xcodegen generate --quiet && MAM_UI_TEST_SERVER=http://127.0.0.1:7777 MAM_UI_TEST_REPO="$REPO" xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet test -only-testing:MacAgentUITests && cd ..
kill $SERVER_PID; sleep 3; pgrep -f "agent-host --socket" && exit 1 || true
xcrun devicectl device info details --device 530EAE6A-D5BE-52C8-A0A5-E1D7B8C5E51C >/dev/null
grep -q "10.11" docs/IOS.md
grep -q "ADR-018" docs/ADR.md
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 곁방에 참가하지 않은 팀원의 턴 입력에 그 대화가 들어가지 않는가(맥락 격리가 실제로 되는가)?
   - 그룹방에 사용자가 볼 것(연결 카드·변경 카드·사용자 대화)이 그대로 남는가?
   - 로그·스모크가 끝난 뒤 잔여 프로세스가 없는가?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(맥락 절감 수치·설치 결과 포함)
   - 실패 → `error` / 개입 필요 → `blocked` / 설계 분기 → `needs_input`

## 금지사항

- `tail -f` 나 끝나지 않는 대기를 쓰지 마라. 폴링은 상한을 두고(`for i in $(seq 1 60)`), 로그를 grep 할 때는 **`grep -a`** 를 써라. 이유: xcodebuild 출력에는 NUL 바이트가 섞여 macOS grep 이 바이너리로 보고 건너뛴다(이전 phase 에서 세션이 30분 타임아웃으로 날아갔다).
- `pkill -f node` 같은 광범위한 종료를 하지 마라. 띄운 pid 만 정리한다.
- 설계 변경이 필요한 버그는 고치지 말고 `needs_input`.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
