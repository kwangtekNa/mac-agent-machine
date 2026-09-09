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
                                   └─ git/  status/diff (git CLI 래핑)
```

자세한 설계는 `docs/ARCHITECTURE.md`를 참고한다.

## 디렉토리

| 경로 | 내용 |
|---|---|
| `packages/protocol` | `@mam/protocol` — REST/WS 계약 zod 스키마, 타입, fixture. iOS와 서버가 공유하는 유일한 계약 |
| `packages/server` | `@mam/server` — `mam` CLI(`gateway`, `agent-host`, `user`, `doctor`, `config`), gateway, agent-host, 세션 매니저, Claude/Codex/Fake 어댑터, fs/git 샌드박스 |
| `apps/web` | Phase 2. Vite + React + TS 웹 대시보드 (`@mam/protocol` 재사용) |
| `ios/` | Phase 1. SwiftUI 앱 (XcodeGen) |
| `scripts/` | `dev-smoke.sh`/`dev-smoke.mjs`(개발 e2e), `setup-server.sh`(설치), `test.sh`(전체 게이트) |
| `docs/` | `PRD.md`, `ARCHITECTURE.md`, `PROTOCOL.md`, `ADR.md`, `RUNBOOK.md` |

## 개발 빠른 시작

```bash
npm ci
bash scripts/dev-smoke.sh --keep   # 빌드 → Fake 어댑터로 gateway 기동(:7777) → REST/WS 검증 → 서버 유지
```

`--keep`으로 띄운 서버는 Phase 1(iOS)과 Phase 2(웹) 개발 백엔드로 그대로 쓸 수 있다(`http://127.0.0.1:7777`). Ctrl-C로 종료한다.

```bash
curl -s -H 'X-MAM-Protocol: 1' http://127.0.0.1:7777/api/v1/me
curl -s -H 'X-MAM-Protocol: 1' -H 'Content-Type: application/json' \
  -d '{"agent":"claude","cwd":"'"$HOME"'/work"}' \
  http://127.0.0.1:7777/api/v1/sessions
```

테스트:

```bash
npm run build             # TS 빌드
npm run typecheck         # TS 타입 검사
npm test                  # vitest (packages/*/test)
bash scripts/test.sh       # 전체 게이트 (TS + iOS). MAM_TEST_SKIP_IOS=1 로 iOS 생략
bash scripts/dev-smoke.sh  # 개발 모드 e2e (빌드 → 기동 → 검증 → 종료)
```

## 프로덕션 설치

관리자가 실제 Mac에 설치하고 사용자를 추가하는 절차는 `docs/RUNBOOK.md`에 있다.

## 문서

- [`docs/PRD.md`](docs/PRD.md) — 요구사항과 범위
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — 프로세스 구조, 저장소 구조, 런타임 경로, 보안 모델
- [`docs/PROTOCOL.md`](docs/PROTOCOL.md) — REST/WS 계약과 TimelineItem 모델
- [`docs/ADR.md`](docs/ADR.md) — 기술 결정과 근거
- [`docs/RUNBOOK.md`](docs/RUNBOOK.md) — 설치, 사용자 추가, 운영, 문제 해결
