# ADR: mac-agent-machine

각 항목은 배경 → 결정 → 결과 순서다. 상태가 `검증 필요`인 항목은 해당 step 세션이 먼저 확인하고, 틀리면 `needs_input`으로 보고한다.

## ADR-001 외부 노출은 Tailscale 전용

- 배경: 공유기 포트포워딩은 인터넷에 직접 노출되고, Cloudflare Tunnel은 SSH에 별도 클라이언트와 도메인이 필요하다.
- 결정: Mac을 Tailscale tailnet에 올린다(`brew install tailscale`, `tailscaled` 시스템 데몬). SSH와 gateway 모두 tailnet IP에만 바인딩한다. 사용자는 관리자의 tailnet에 초대되거나 공유 노드로 접근한다.
- 결과: 포트 개방 없음. 사용자 기기마다 Tailscale 설치 필요. 신원 조회(whois)를 공짜로 얻는다(ADR-003).

## ADR-002 사용자 격리는 macOS 계정, 프로세스 구조는 sshd 모델

- 배경: 단일 계정은 서로의 파일과 자격증명이 보이고, Docker는 macOS 도구를 못 쓴다.
- 결정: 사용자마다 macOS 계정을 만든다(`sysadminctl -addUser`, 관리자 권한 없음). root LaunchDaemon인 gateway가 접속을 받고, 사용자별 agent-host 프로세스를 해당 계정으로 생성해 프록시한다. 파일·git·에이전트 실행은 전부 agent-host에서 일어난다.
- 대안: 사용자별 LaunchDaemon(`UserName` 키)을 미리 등록하는 방식. 사용자 추가 시 plist 등록이 필요하고 유휴 종료가 어려워 채택하지 않았다. root 단일 프로세스가 uid를 바꿔 직접 에이전트를 실행하는 방식은 root 코드가 커져 배제했다.
- 결과: root 코드는 `src/gateway/`로 한정된다. 사용자 추가는 계정 생성과 config 한 줄이다.

## ADR-003 신원은 `tailscale whois`

- 배경: 별도 계정/비밀번호 체계는 코드와 운영 부담이 늘고, 어차피 네트워크가 Tailscale로 닫혀 있다.
- 결정: gateway가 접속 소켓의 원격 IP로 `tailscale whois --json <ip>`를 실행해 `UserProfile.LoginName`(이메일)을 얻고 `config.users[]`로 macOS 계정에 매핑한다. 60초 캐시. 태그 노드, 조회 실패, 매핑 없음은 403.
- 대안: `tailscale serve`의 `Tailscale-User-Login` 헤더. serve가 loopback으로 프록시하므로 같은 Mac의 다른 로컬 사용자가 헤더를 위조해 접속할 수 있어 배제했다.
- 결과: 클라이언트는 로그인 화면이 없다. 같은 사용자의 기기 여러 대가 자동으로 같은 계정에 매핑된다. tailnet 밖에서는 접속 자체가 불가능하다.

## ADR-004 TLS는 `tailscale cert`, 프록시는 직접 구현

- 배경: iOS App Transport Security는 평문 HTTP를 기본 차단한다. tailnet 안이라 WireGuard로 이미 암호화되지만 앱 쪽 예외 설정보다 정식 인증서가 깔끔하다.
- 결정: `tailscale cert <host>.<tailnet>.ts.net`으로 Let's Encrypt 인증서를 받아 gateway가 직접 HTTPS를 종단한다. 갱신은 launchd 주기 작업. gateway ↔ agent-host는 unix socket 위 평문 HTTP/WS이고, 프록시는 `node:http`/`node:net`으로 직접 구현한다(라이브러리 없음).
- 결과: 앱은 `https://<magicdns>` 하나만 입력한다. 개발 모드는 `http://127.0.0.1:7777`이며 시뮬레이터는 loopback 평문을 허용한다.

## ADR-005 서버 스택

- 결정: TypeScript, Node 24(설치됨), ESM, npm workspaces(`packages/*`, `apps/*`). agent-host HTTP는 Fastify 5 + `@fastify/websocket`. 스키마는 zod 4(Agent SDK peer dep과 일치). 테스트 vitest, 개발 실행 tsx, 빌드 tsc.
- 근거: Codex가 app-server 프로토콜의 TS 바인딩을 생성해 주고(`codex app-server generate-ts`), Claude Agent SDK가 TS다. 웹 대시보드와 `@mam/protocol`을 공유한다.
- 결과: Python 하네스 tdd-guard 규칙은 `.py`에만 적용되므로 이 프로젝트와 무관하다.

## ADR-006 Claude는 Agent SDK로 구동

- 배경: 선택지는 (a) `claude --print --input-format stream-json --output-format stream-json` 직접 파싱, (b) `@anthropic-ai/claude-agent-sdk`.
- 결정: (b). `query({ prompt: AsyncIterable<SDKUserMessage>, options })` 스트리밍 입력 모드로 세션당 프로세스 하나를 유지한다. `canUseTool`로 승인 요청, `includePartialMessages`로 델타, `resume`/`forkSession`, `interrupt()`, `setPermissionMode()`를 쓴다. SDK 버전은 CLI와 같은 라인(0.3.266 ↔ 2.1.266)으로 고정한다.
- 결과: control 프로토콜을 직접 구현하지 않는다. SDK가 자체 실행파일을 번들하므로 사용자의 `claude` 설치와 무관하게 동작할 수 있다. `pathToClaudeCodeExecutable`로 사용자 설치본을 강제할 수 있게 설정을 남긴다.

## ADR-007 Codex는 app-server JSON-RPC로 구동

- 배경: 선택지는 `codex exec --json`(턴마다 프로세스, 승인 불가), `codex mcp-server`, `codex app-server`(Codex 데스크톱/IDE가 쓰는 프로토콜).
- 결정: `codex app-server`를 사용자 권한 자식 프로세스로 띄우고 줄 단위 JSON-RPC로 통신한다. 흐름은 `initialize` → `initialized` → `thread/start`(또는 `thread/resume`) → `turn/start`. 승인은 서버 요청(`item/*/requestApproval`, `item/tool/requestUserInput`)에 같은 `id`로 응답한다. 타입은 `codex app-server generate-ts --out`으로 생성해 `packages/server/src/agents/codex/generated/`에 커밋한다(실험적 API라 버전 고정).
- 결과: 승인, 스트리밍, 재개(`thread/list`, `thread/resume`)를 모두 얻는다. 프로토콜이 experimental이므로 Codex CLI 업데이트 시 바인딩 재생성과 매핑 테스트가 필요하다.

## ADR-008 자격증명은 사용자별 OAuth, Claude는 setup-token 방식 (`검증 필요`)

- 배경: 사용자마다 자기 구독으로 로그인한다. Claude Code는 macOS에서 OAuth 토큰을 Keychain에 저장하는 것으로 알려져 있는데, GUI 로그인 없이 `sudo -u`로 뜬 프로세스는 로그인 키체인이 잠겨 있거나 없다. Codex는 `~/.codex/auth.json` 파일이라 문제가 없다.
- 결정: Claude는 `claude setup-token`이 발급하는 장기 토큰을 agent-host가 `~/.mam/secrets/claude-oauth-token`(0600)에 저장하고, SDK 실행 시 `CLAUDE_CODE_OAUTH_TOKEN` 환경변수로 주입한다. Keychain에 의존하지 않는다. 앱 로그인 흐름(F8): `POST /auth/claude/login`이 PTY에서 `claude setup-token`을 띄워 URL을 읽어 돌려주고, 사용자가 폰 브라우저에서 인증 후 받은 코드를 `.../code`로 보내면 stdin에 써서 토큰을 얻는다. Codex는 app-server `account/login/start { type: "chatgptDeviceCode" }`가 주는 `verificationUrl`과 `userCode`를 앱에 보여주고, `account/login/completed` 알림으로 완료를 확인한다(이 머신의 codex-cli 0.153.4 바인딩에서 확인됨). 콜백 포트가 필요 없다.
- 검증 필요: (1) `claude setup-token`이 PTY 안에서 URL을 출력하고 코드를 stdin으로 받는지, (2) `CLAUDE_CODE_OAUTH_TOKEN`이 SDK 경로에서 인식되는지. 실패 시 SSH 안내(`ssh alice@mac` 후 직접 로그인)로 폴백하고 앱은 501 메시지를 보여준다.
- 결과: 서버 주인의 API 키를 공유하지 않는다. 비용과 사용량은 각자에게 간다.

## ADR-009 정규화 이벤트 모델과 fixture 계약

- 배경: 두 에이전트의 이벤트 형태가 다르고, iOS는 TS 타입을 import할 수 없다.
- 결정: `docs/PROTOCOL.md`의 TimelineItem/Approval/WS 이벤트로 정규화한다. TS는 zod 스키마, Swift는 손으로 쓴 Codable이며 `packages/protocol/fixtures/*.json`을 양쪽이 디코딩하는 테스트로 계약을 지킨다. 프로토콜 변경은 fixture → zod → 서버 → iOS 순서.
- 결과: 클라이언트는 에이전트 종류를 몰라도 그린다. 에이전트별 원본 이벤트는 `payload.raw`에 넣지 않는다(크기와 결합도 때문).

## ADR-010 세션 영속화는 JSONL, 재개는 네이티브 ID

- 결정: agent-host가 `~/.mam/sessions/<id>.json`과 `<id>.events.jsonl`을 쓴다. 프로세스가 죽거나 유휴 종료돼도 앱은 히스토리를 본다. 다음 턴은 Claude `resume`, Codex `thread/resume`로 이어간다. 에이전트 네이티브 트랜스크립트(`~/.claude/projects/`, Codex `thread/list`)의 가져오기(import)는 Phase 3.
- 결과: 세션 수명이 프로세스 수명과 분리된다.

## ADR-011 프로세스 생성은 `sudo -u <user> -H -n`

- 배경: Node `spawn`의 `uid/gid` 옵션은 보조 그룹(initgroups)을 설정하지 않는다. `su -l`은 로그인 셸 rc에 의존한다.
- 결정: root gateway가 `/usr/bin/sudo -u <user> -H -n -- <node> <mamCli> agent-host --socket <path>`로 생성한다. sudo가 HOME/USER/SHELL을 대상 사용자 기준으로 초기화하고 보조 그룹을 채운다. agent-host는 시작 후 `$SHELL -lc 'command -v claude; command -v codex'`로 도구 경로를 해석한다.
- 결과: 개발 모드(비 root)에서는 sudo 없이 같은 사용자로 직접 spawn한다. Keychain이 필요한 작업은 하지 않는다(ADR-008).

## ADR-012 iOS 앱 스택

- 결정: Swift 6, SwiftUI, 최소 iOS 17(`@Observable`, `NavigationSplitView`). 프로젝트는 XcodeGen `ios/project.yml`로 생성하고 `*.xcodeproj`는 커밋하지 않는다. 네트워킹은 URLSession(`URLSessionWebSocketTask`). 마크다운은 `AttributedString(markdown:)` 기본, 코드 하이라이트 라이브러리는 Phase 1 파일 뷰어 step에서 결정한다. 서명은 `ios/Local.xcconfig`(gitignore)의 `DEVELOPMENT_TEAM`으로 개인 기기 설치.
- 결과: 시뮬레이터(iPhone 17 Pro, iOS 26.2)에서 `xcodebuild test`로 AC를 검증한다.

## ADR-013 웹 대시보드는 Vite + React, gateway가 서빙

- 결정: Phase 2에서 `apps/web`을 Vite + React + TS로 만들고 `@mam/protocol`을 import한다. 빌드 산출물을 gateway가 `/`에서 정적 서빙한다. 별도 프로세스나 포트 없음.

## ADR-014 배포는 시뮬레이터와 개인 기기부터

- 결정: Phase 1은 시뮬레이터 + 관리자 본인 iPhone(개발 서명, 7일 재서명) 설치까지다. TestFlight/APNs는 유료 개발자 계정 확보 후 Phase 3.

## ADR-015 세션 모드는 4종 프리셋

- 결정: `ask`, `auto-edit`, `full-auto`, `plan`. 매핑은 `docs/PROTOCOL.md` 4절. `full-auto`는 앱에서 별도 확인 후에만 설정 가능하며 서버는 기본값을 `ask`로 강제한다.

## 미결 사항

| 항목 | 결정 시점 |
|---|---|
| Claude setup-token 비대화형 구동 및 `CLAUDE_CODE_OAUTH_TOKEN` 인식 | Phase 0 `claude-adapter`, `auth-login-flow` step |
| iOS 코드 하이라이트 라이브러리 | Phase 1 `file-browser-ui` step |
| 프로젝트/앱 표시 이름(현재 `MacAgent`, 번들 ID `dev.mam.MacAgent`) | Phase 1 `xcodegen-project` step |
| 유휴 종료 시간 기본값(현재 30분) | 운영 후 조정 |
