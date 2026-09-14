# mac-agent-machine

Mac 한 대를 여러 사용자의 에이전트 코딩 서버로 만드는 프로젝트다. Tailscale 사설망 안에서 SSH, iOS 앱, 웹 대시보드로 접속해 각자 macOS 계정 권한으로 [Claude Code](https://claude.com/claude-code)와 [Codex](https://openai.com/index/openai-codex/)를 돌린다. 설계 원칙은 sshd와 같다: root로 도는 코드는 접속 수락·신원 확인·프로세스 생성·프록시뿐이고, 실제 작업은 전부 접속한 사용자 권한의 프로세스에서 일어난다.

```
 iPhone (MacAgent 앱) ──HTTPS/WSS──┐
 브라우저 (웹 대시보드) ─HTTPS/WSS─┼─ tailnet ─▶ [Mac] gateway  (root LaunchDaemon, 443, tailscale cert)
 노트북 (ssh alice@mac) ───SSH─────┘                 │  1) 접속 IP → tailscale whois → 로그인 이메일
                                                     │  2) 이메일 → macOS 계정 (config users[])
                                                     │  3) 계정별 agent-host 프로세스 확보 (없으면 sudo -u 로 생성)
                                                     │  4) HTTP/WS 를 unix socket 으로 프록시
                                                     ▼
                                   agent-host (macOS 사용자 권한, 사용자당 1개, /var/run/mam/<user>/agent.sock)
                                   ├─ sessions/  SessionManager: 세션 레지스트리, 이벤트 로그(JSONL), 팬아웃, 유휴 종료
                                   ├─ agents/claude  Claude Agent SDK → claude CLI (사용자 ~/.claude 자격증명)
                                   ├─ agents/codex   codex app-server (JSON-RPC over stdio, 사용자 ~/.codex)
                                   ├─ fs/   홈 디렉토리로 제한된 파일 목록/읽기
                                   └─ git/  status/diff/init (git CLI 래핑)
```

자세한 설계는 `docs/ARCHITECTURE.md`를 참고한다.

## 디렉토리

| 경로 | 내용 |
|---|---|
| `packages/protocol` | `@mam/protocol` — REST/WS 계약 zod 스키마, 타입, fixture. iOS와 서버가 공유하는 유일한 계약 |
| `packages/server` | `@mam/server` — `mam` CLI(`gateway`, `agent-host`, `user`, `doctor`, `config`), gateway, agent-host, 세션 매니저, Claude/Codex/Fake 어댑터, fs/git 샌드박스 |
| `apps/web` | Phase 2. Vite + React + TS 웹 대시보드 (`@mam/protocol` 재사용) |
| `ios/` | Phase 1. `MacAgent` iOS 앱 — XcodeGen `project.yml`, `MacAgent/`(SwiftUI 소스), `MacAgentTests/`(XCTest, `packages/protocol/fixtures` 폴더 참조). `*.xcodeproj`는 생성물이라 커밋하지 않는다. 설계는 `docs/IOS.md` |
| `scripts/` | `dev-smoke.sh`/`dev-smoke.mjs`(개발 e2e), `setup-server.sh`(설치), `test.sh`(전체 게이트) |
| `docs/` | `PRD.md`, `ARCHITECTURE.md`, `PROTOCOL.md`, `ADR.md`, `IOS.md`, `RUNBOOK.md` |

## 개발 빠른 시작

```bash
npm ci
bash scripts/dev-smoke.sh --keep   # 빌드 → Fake 어댑터로 gateway 기동(:7777) → REST/WS 검증(세션 1~14 + 팀 15~21 + git init 22 + net/ports 23 + 문서 24단계) → 서버 유지
```

`--keep`으로 띄운 서버는 Phase 1(iOS)과 Phase 2(웹) 개발 백엔드로 그대로 쓸 수 있다(`http://127.0.0.1:7777`). Ctrl-C로 종료한다.

같은 Wi-Fi나 핫스팟에 있는 실제 iPhone에서 붙어 보려면 Mac의 LAN IP로 바인딩한다(신원이 현재 사용자로 고정되므로 신뢰할 수 있는 네트워크에서만). 폰에서 팀 기능(새 팀 → 방 → 승인 → 머지)을 실제로 보려면 Fake 어댑터(`MAM_FAKE_AGENT`) 없이 **실제 어댑터** gateway 를 이 LAN IP 로 띄운다(`MAM_CODEX_BIN` 은 `zsh -ic 'command -v codex'` 결과):

```bash
MAM_DEV_BIND=$(ipconfig getifaddr en0) node packages/server/dist/cli.js gateway --dev   # 앱에는 http://<그 IP>:7777 입력
```

어디서나 같은 주소로 붙으려면 tailnet IP 에 바인딩한 개발 gateway 를 로그인 시 자동 시작시킨다: `bash scripts/install-dev-gateway.sh` (LaunchAgent `dev.mam.dev-gateway`, 상태 `--status`, 제거 `--uninstall`. 절차는 `docs/RUNBOOK.md` 8절).

```bash
curl -s -H 'X-MAM-Protocol: 1' http://127.0.0.1:7777/api/v1/me
curl -s -H 'X-MAM-Protocol: 1' -H 'Content-Type: application/json' \
  -d '{"agent":"claude","cwd":"'"$HOME"'/work"}' \
  http://127.0.0.1:7777/api/v1/sessions
curl -s -H 'X-MAM-Protocol: 1' http://127.0.0.1:7777/api/v1/usage   # 에이전트별 구독 사용 한도(Claude 는 세션을 한 번 돌린 뒤 관측값이 생긴다)
```

에이전트 팀(`docs/PROTOCOL.md` 6절): git 저장소인 프로젝트에 팀장 1명 + 개발자 1명을 만들고 그룹방(`rooms[]` 의 `kind: "group"`)에 지시한다. 멘션이 없으면 팀장이, `@이름`/`@handle` 이 있으면 그 팀원이 답한다.

```bash
curl -s -H 'X-MAM-Protocol: 1' -H 'Content-Type: application/json' \
  -d '{"cwd":"'"$HOME"'/work/app","name":"backend","members":[{"name":"민수","role":"team-lead","agent":"claude","isLead":true},{"name":"지연","role":"developer","agent":"codex"}]}' \
  http://127.0.0.1:7777/api/v1/teams                                        # → 201 Team (id, members[].sessionId, rooms[])
curl -s -H 'X-MAM-Protocol: 1' -H 'Content-Type: application/json' \
  -d '{"text":"@지연 README 에 설치 절을 추가해줘"}' \
  http://127.0.0.1:7777/api/v1/teams/<teamId>/rooms/<groupRoomId>/messages  # → 201 { message, dispatches }. 답변·변경 카드는 GET .../rooms/<roomId> 또는 방 WS
```

에이전트 worktree 는 `~/.mam/teams/<teamId>/worktrees/` 에 생기고 `node_modules` 는 없다(의존성이 필요하면 사용자가 그 디렉토리에서 직접 설치한다).

테스트:

```bash
npm run build             # TS 빌드
npm run typecheck         # TS 타입 검사
npm test                  # vitest (packages/*/test)
bash scripts/test.sh       # 전체 게이트 (TS + iOS). MAM_TEST_SKIP_IOS=1 로 iOS 생략
bash scripts/dev-smoke.sh  # 개발 모드 e2e (빌드 → 기동 → 검증 → 종료)
```

iOS 앱(`ios/`, 설계는 `docs/IOS.md`):

```bash
cd ios && xcodegen generate                                   # MacAgent.xcodeproj 생성(생성물, 커밋하지 않음)
open MacAgent.xcodeproj                                       # Xcode 에서 iPhone 17 Pro 시뮬레이터로 실행(⌘R)
xcodebuild test -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro'   # 단위 테스트
# UI 테스트 6개(ApprovalFlowUITests: hello → 승인 허용 → 완료, UsageAndFilesUITests: 찾아보기 → 새 폴더 → 파일 탭 → 컨텍스트 게이지 → 세션 정보 시트,
# TeamRoomUITests: 새 팀 → #전체 → @멘션 → write file → 승인 허용 → 작업 요약 → 팀원 타임라인 → main에 병합 → 병합됨,
# GitInitUITests: 새 팀 → 찾아보기 → 새 폴더 → 피커에서 저장소 초기화 → 이 폴더 선택 → 팀 만들기 / 직접 입력 → 시트에서 저장소 초기화 → "git 저장소 (main)",
# PreviewUITests: 새 세션 → serve 3456 → 승인 허용 → 답변의 localhost 링크 탭 → 앱 안 브라우저 → 닫기 → 툴바 미리보기 → "열린 포트" 시트,
# DocumentViewerUITests: 새 세션(cwd=저장소) → 파일 탭 → sample.pdf → QuickLook → 닫기 → sample.hwpx → 웹 뷰의 "안녕하세요").
# 다른 터미널에서 bash scripts/dev-smoke.sh --keep 으로 개발 서버를 띄운 뒤 실행한다. MAM_UI_TEST_SERVER 가 없으면 여섯 다 XCTSkip.
# TeamRoomUITests·DocumentViewerUITests(와 GitInitUITests 의 직접 입력 시나리오)는 MAM_UI_TEST_REPO(dev-smoke --keep 이 마지막에 `MAM_UI_TEST_REPO=<git 저장소>` 로 출력하는 경로)도 필요하며 없으면 XCTSkip.
# DocumentViewerUITests 가 여는 sample.pdf·sample.hwpx 는 dev-smoke 24단계가 그 저장소에 만들어 커밋한다.
# 같은 저장소에 두 번 돌리면 ui.txt 가 이미 main 에 있어 변경 카드가 안 올라오므로 서버를 다시 띄워 새 저장소로 돌린다.
MAM_UI_TEST_SERVER=http://127.0.0.1:7777 MAM_UI_TEST_REPO=<위 경로> xcodebuild test -scheme MacAgent \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -only-testing:MacAgentUITests
```

팀 기능(팀 섹션, 새 팀 시트, 방, 카드)은 서버 phase 3 의 API(`docs/PROTOCOL.md` 6절)를 쓴다. 화면 설계는 `docs/IOS.md` 10절.

시뮬레이터 앱의 첫 화면에는 "개발 서버(127.0.0.1:7777)에 연결" 버튼이 있다. 실기기 설치는 `docs/RUNBOOK.md` 의 "iPhone에 설치" 절.

## 프로덕션 설치

관리자가 실제 Mac에 설치하고 사용자를 추가하는 절차는 `docs/RUNBOOK.md`에 있다.

## 문서

- [`docs/PRD.md`](docs/PRD.md) — 요구사항과 범위
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — 프로세스 구조, 저장소 구조, 런타임 경로, 보안 모델
- [`docs/PROTOCOL.md`](docs/PROTOCOL.md) — REST/WS 계약과 TimelineItem 모델
- [`docs/ADR.md`](docs/ADR.md) — 기술 결정과 근거
- [`docs/IOS.md`](docs/IOS.md) — iOS 앱 구조, 내비게이션, 디자인 시스템, 상태 흐름
- [`docs/RUNBOOK.md`](docs/RUNBOOK.md) — 설치, 사용자 추가, 운영, 문제 해결
