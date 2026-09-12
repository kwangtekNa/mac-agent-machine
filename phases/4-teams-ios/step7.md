# Step 7: ios-docs-and-ui-test

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/IOS.md` 전체(9절 "2차 추가분" 의 형식을 그대로 따른다), `/docs/PROTOCOL.md` 6절, `/README.md` iOS 절
- `/ios/MacAgentUITests/ApprovalFlowUITests.swift`, `UsageAndFilesUITests.swift`(`MAM_UI_TEST_SERVER` 게이트, `segment()`, `tree()`, `waitUntil`, `capture`, 새 폴더 정리 패턴)
- `/scripts/dev-smoke.sh`, `/scripts/dev-smoke.mjs`(팀 단계 15~20, `--keep`, `~/.mam/smoke/<ts>/repo`)
- `/packages/server/src/agents/fake/script.ts`(`write file <이름>`, `ask @<핸들>`, 승인 요청 규칙)
- step 4~6 의 뷰 파일과 그 접근성 식별자

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

문서를 맞추고, dev-smoke Fake 서버를 상대로 팀 흐름을 끝까지 누르는 XCUITest 를 만든다.

### 1. `docs/IOS.md` — `## 10. 3차 추가분 (2026-09-12, Phase 4-teams-ios)`

기존 `## 10. 범위 밖 (Phase 1)` 을 `## 11.` 로 내리고 그 앞에 10절을 넣는다. 9절과 같은 형식(동기 한 문단 + 번호 절):

- 10.1 세션 홈의 "팀" 섹션, `+` 메뉴, 팀원 세션의 팀 배지, 새 팀 시트·팀원 편집기(프리셋 + 내 프리셋, full-auto 제외), 팀 설정·삭제(`keepWorktrees` 재시도).
- 10.2 방 목록과 방 화면: `#전체`/DM, 작업 중 말풍선·상태 줄·"중단", 멘션 제안 칩·팀장 캡션·길게 눌러 답장, 답변은 턴 종료 후 한 번에, 승인은 방 배너에서(작성자 캡션).
- 10.3 카드: 작업 요약(한 줄, 탭 → 팀원 타임라인), 승인, 변경 준비됨("<base>에 병합" + 확인, 거절, 충돌 표시).
- 10.4 iPad: 사이드바 팀 섹션, content 열 방, detail 열 팀원 타임라인.
- 10.5 상태 흐름: `TeamsStore`, `RoomModel.apply` 단일 경로, `AppState` LRU(8)에 방 포함, `RoomSocket` 재접속 규칙.
- 접근성 식별자 표: `home.newTeam`, `teams.row.<teamId>`, `rooms.group`, `rooms.dm.<memberId>`, `room.composer.input`, `room.composer.send`, `room.mention.<memberId>`, `room.workSummary.<messageId>`, `room.merge.<changeId>`, `room.dismiss.<changeId>`, `newTeam.name`, `newTeam.addMember`, `newTeam.submit`, `memberEditor.name`, `memberEditor.save`.
- 3절 디렉토리 표에 `Features/Teams/`, `Features/Rooms/` 추가. 4절 내비게이션에 팀 경로 추가.

### 2. dev-smoke `--keep` 이 UI 테스트용 저장소를 남기게

`scripts/dev-smoke.mjs` 의 팀 단계는 마지막에 팀을 지우지만 저장소 디렉토리는 남는다. `--keep` 일 때 `MAM_UI_TEST_REPO=<repo 절대 경로>` 를 한 줄 출력하고(`dev-smoke.sh` 가 그대로 전달), 그 저장소를 지우지 않는다. 팀 단계에서 만든 worktree·팀은 지금처럼 정리한다. 서버 코드는 바꾸지 않는다.

### 3. `ios/MacAgentUITests/TeamRoomUITests.swift`

`MAM_UI_TEST_SERVER` 와 `MAM_UI_TEST_REPO` 가 없으면 `XCTSkip`. 흐름:

1. 앱 실행 → 홈 `+` → "새 팀"(`home.newTeam`).
2. 이름 `ui-<timestamp>`, 디렉토리 "직접 입력" 에 `MAM_UI_TEST_REPO`, 팀원 추가: 프리셋 "팀장" 이름 `민수` Claude, 프리셋 "개발자" 이름 `지연` Codex(팀장 토글은 민수만) → `newTeam.submit`.
3. 방 목록에 `rooms.group` 과 DM 행 2개 → `#전체` 진입.
4. 컴포저에 `@지` 입력 → 제안 칩 `room.mention.<지연 id>` 탭 → 이어서 `write file ui.txt` 입력 → 보내기.
5. 승인 카드 + 배너의 "허용" 탭(Fake 기본 스크립트가 승인을 요청한다) → 에이전트 답변 카드와 작업 요약(`room.workSummary.*`, 텍스트에 "도구") 등장 → 작업 요약 탭 → 팀원 타임라인에 `turn_summary`("초 ·") 존재 → 뒤로.
6. 변경 준비됨 카드 → `room.merge.*`("main에 병합") → 확인 다이얼로그 → 카드에 "병합됨".
7. 정리: 테스트 끝에 REST(`URLSession`)로 `DELETE /api/v1/teams/<id>?keepWorktrees=true` 를 호출(팀 id 는 `GET /teams?cwd=` 로 찾는다). 실패해도 테스트 결과에는 영향 없음. 스크린샷은 `capture()` 로 `MAM_UI_TEST_SHOTS` 규칙 그대로.

기존 두 UI 테스트는 그대로 통과해야 한다("새 세션" 라벨·식별자 유지).

### 4. `README.md`

iOS 절에 UI 테스트 3개와 `MAM_UI_TEST_REPO` 설명, "팀 기능은 서버 phase 3 의 API 를 쓴다" 한 줄.

## Acceptance Criteria

```bash
npm run typecheck && npm test
bash scripts/dev-smoke.sh
bash scripts/dev-smoke.sh --keep >/tmp/mam-ui-server.log 2>&1 & SERVER_PID=$!; sleep 25
REPO=$(grep -o 'MAM_UI_TEST_REPO=.*' /tmp/mam-ui-server.log | head -1 | cut -d= -f2-); test -d "$REPO"
cd ios && xcodegen generate --quiet && MAM_UI_TEST_SERVER=http://127.0.0.1:7777 MAM_UI_TEST_REPO="$REPO" xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet test -only-testing:MacAgentUITests && cd ..
kill $SERVER_PID; sleep 3; pgrep -f "agent-host --socket" && exit 1 || true
grep -q "## 10. 3차 추가분" docs/IOS.md
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - UI 테스트가 PROTOCOL 6절 흐름(생성 → 멘션 → 승인 → 답변 → 변경 → 머지)을 실제로 통과하는가?
   - 식별자 표가 코드와 일치하는가?
   - 서버 코드(`packages/server/src`)를 바꾸지 않았는가(스크립트만)?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- 서버 코드(`packages/server/src`, `packages/protocol`)를 수정하지 마라. 이유: 계약은 확정됐다. Fake 흐름이 부족하면 `blocked` 로 부족한 항목을 적어라.
- UI 테스트에서 `Process`/셸을 쓰지 마라(iOS 에서 불가). 저장소는 `MAM_UI_TEST_REPO` 로 받는다.
- `pkill -f node` 같은 광범위한 종료를 하지 마라. 이 step 이 띄운 pid 만 정리한다.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
