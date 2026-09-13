# Step 2: verify-and-install

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/IOS.md` 10절, `/docs/PROTOCOL.md` `GET /fs/download`·`GET /fs/render`, `/docs/RUNBOOK.md`, `/README.md`
- `/scripts/dev-smoke.sh`, `/scripts/dev-smoke.mjs`
- `/ios/MacAgentUITests/UsageAndFilesUITests.swift`(파일 탭 진입 패턴), 다른 UI 테스트
- step 0·1 산출물 (`git diff --stat main`)

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

### 1. dev-smoke 23단계

스모크 저장소에 (a) 최소 PDF(`%PDF-1.4 … %%EOF` 한 페이지, 스크립트가 바이트로 씀), (b) 최소 HWPX(`zip` spawn: `mimetype`, `Contents/header.xml`, `Contents/section0.xml` 문단 1개 "안녕하세요")를 만든 뒤: `GET /fs/download?path=<pdf>` → 200, `content-type: application/pdf`, `content-length` 일치, 바이트 동일; `GET /fs/render?path=<hwpx>` → 200, `kind hwpx`, html 에 "안녕하세요"; `GET /fs/render?path=<pdf>` → 400; `.hwp`(빈 파일) → 501 또는 500(변환기 유무에 따라, 둘 다 허용하되 어느 쪽인지 note); 101 MiB 희소 파일 → 415.

### 2. UI 테스트 `ios/MacAgentUITests/DocumentViewerUITests.swift`

`MAM_UI_TEST_SERVER`·`MAM_UI_TEST_REPO` 없으면 skip. dev-smoke `--keep` 이 남긴 저장소에 스모크가 만든 `sample.pdf`·`sample.hwpx` 가 있어야 한다(23단계가 `MAM_UI_TEST_REPO` 저장소 안에 만들고 지우지 않도록 조정). 흐름: 세션 생성(cwd = repo) → 파일 탭 → `sample.pdf` 탭 → QuickLook 화면(접근성: 페이지/문서 뷰 존재, 스크린샷) → 뒤로 → `sample.hwpx` 탭 → 웹 뷰에 "안녕하세요" 텍스트(`app.webViews.staticTexts`) → 뒤로.

### 3. 검증·설치

- `npm ci && npm run typecheck && npm test`, `bash scripts/dev-smoke.sh`(23단계).
- dev-smoke `--keep` 서버로 UI 테스트 전부 통과, 서버 종료·잔여 없음.
- iPhone 설치(절대 경로 프로젝트, 이전 phase 와 같은 세 명령). 기기 없음·서명 실패는 `blocked`.

### 4. 문서

- `docs/IOS.md` 10절에 `10.10 문서 뷰어(PDF·Office QuickLook, 한글 HTML)`.
- `docs/RUNBOOK.md` 새 절 `## 9. 문서 미리보기`: 지원 형식, 100 MiB 상한, **한글 변환기 설치** (`python3 -m pip install --user pyhwp` 후 `hwp5html --version` 확인; anaconda python 이면 그 pip; PATH 에 없으면 `MAM_HWP5HTML_BIN=<경로>` 를 gateway 환경에 — LaunchAgent 는 `scripts/install-dev-gateway.sh` 재실행), HWPX 는 변환기 없이 동작.
- `README.md` iOS 절 UI 테스트 6개.

## Acceptance Criteria

```bash
npm ci && npm run typecheck && npm test
bash scripts/dev-smoke.sh
bash scripts/dev-smoke.sh --keep >/tmp/mam-ui-server.log 2>&1 & SERVER_PID=$!; sleep 25
REPO=$(grep -o 'MAM_UI_TEST_REPO=.*' /tmp/mam-ui-server.log | head -1 | cut -d= -f2-); test -d "$REPO"; test -f "$REPO/sample.pdf"; test -f "$REPO/sample.hwpx"
cd ios && xcodegen generate --quiet && MAM_UI_TEST_SERVER=http://127.0.0.1:7777 MAM_UI_TEST_REPO="$REPO" xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet test -only-testing:MacAgentUITests && cd ..
kill $SERVER_PID; sleep 3; pgrep -f "agent-host --socket" && exit 1 || true
xcrun devicectl device info details --device 530EAE6A-D5BE-52C8-A0A5-E1D7B8C5E51C >/dev/null
grep -q "10.10" docs/IOS.md
grep -q "## 9. 문서 미리보기" docs/RUNBOOK.md
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 스모크·UI 테스트가 다운로드·변환 흐름을 실제로 통과하는가?
   - pyhwp 를 설치하지 않았는가(문서 안내만)?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약. 설치 결과 포함)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- `pip install` 로 사용자 환경을 바꾸지 마라.
- `tail -f` 같은 끝나지 않는 대기·`pkill -f node` 를 쓰지 마라.
- 설계 변경이 필요한 버그는 고치지 말고 `needs_input`.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
