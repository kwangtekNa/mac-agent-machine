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
- 보완(Phase 0 step 6 인터뷰): Codex가 생성한 TS 바인딩이 확장자 없는 상대 import를 쓰기 때문에 `tsconfig.base.json`을 `module: ESNext`, `moduleResolution: Bundler`로 바꿨다. 직접 작성하는 코드는 계속 상대 import에 `.js` 확장자를 붙인다(런타임은 tsc 출력 + Node ESM).

## ADR-006 Claude는 Agent SDK로 구동

- 배경: 선택지는 (a) `claude --print --input-format stream-json --output-format stream-json` 직접 파싱, (b) `@anthropic-ai/claude-agent-sdk`.
- 결정: (b). `query({ prompt: AsyncIterable<SDKUserMessage>, options })` 스트리밍 입력 모드로 세션당 프로세스 하나를 유지한다. `canUseTool`로 승인 요청, `includePartialMessages`로 델타, `resume`/`forkSession`, `interrupt()`, `setPermissionMode()`를 쓴다. SDK 버전은 CLI와 같은 라인(0.3.266 ↔ 2.1.266)으로 고정한다.
- 결과: control 프로토콜을 직접 구현하지 않는다. SDK가 자체 실행파일을 번들하므로 사용자의 `claude` 설치와 무관하게 동작할 수 있다. `pathToClaudeCodeExecutable`로 사용자 설치본을 강제할 수 있게 설정을 남긴다.

## ADR-007 Codex는 app-server JSON-RPC로 구동

- 배경: 선택지는 `codex exec --json`(턴마다 프로세스, 승인 불가), `codex mcp-server`, `codex app-server`(Codex 데스크톱/IDE가 쓰는 프로토콜).
- 결정: `codex app-server`를 사용자 권한 자식 프로세스로 띄우고 줄 단위 JSON-RPC로 통신한다. 흐름은 `initialize` → `initialized` → `thread/start`(또는 `thread/resume`) → `turn/start`. 승인은 서버 요청(`item/*/requestApproval`, `item/tool/requestUserInput`)에 같은 `id`로 응답한다. 타입은 `codex app-server generate-ts --out`으로 생성해 `packages/server/src/agents/codex/generated/`에 커밋한다(실험적 API라 버전 고정).
- 결과: 승인, 스트리밍, 재개(`thread/list`, `thread/resume`)를 모두 얻는다. 프로토콜이 experimental이므로 Codex CLI 업데이트 시 바인딩 재생성과 매핑 테스트가 필요하다.

## ADR-008 자격증명은 사용자별 OAuth, Claude는 파일 폴백 + setup-token

- 배경: 사용자마다 자기 구독으로 로그인한다. Claude Code는 macOS에서 OAuth 토큰을 기본적으로 로그인 Keychain에 저장하지만, 공식 문서(code.claude.com/docs/en/authentication)에 따르면 Keychain이 잠겨 있거나 없는 환경(SSH, LaunchDaemon, `su -l`)에서는 **자동으로 `~/.claude/.credentials.json`(0600)에 저장·조회한다.** 따라서 사용자가 SSH로 접속해 `claude login`만 해도 `sudo -u`로 뜬 agent-host 프로세스가 같은 홈의 파일을 읽어 동작한다. Codex는 `~/.codex/auth.json` 파일이라 처음부터 문제가 없다.
- 결정:
  - 기본 경로는 SSH에서의 `claude login`(파일 폴백)과 `codex login`이다. 서버는 Keychain을 호출하지 않는다.
  - 앱 로그인 흐름(F8)은 편의 기능이다. Claude는 `claude setup-token`(1년 유효 OAuth 토큰, 공식 headless 경로)을 PTY에서 띄워 URL을 돌려주고, 사용자가 폰 브라우저에서 인증 후 받은 코드를 `.../code`로 보내면 stdin에 써서 토큰을 얻어 `~/.mam/secrets/claude-oauth-token`(0600)에 저장한다. agent-host는 이 파일이 있으면 SDK 실행 시 `CLAUDE_CODE_OAUTH_TOKEN`으로 주입한다. 이 변수는 인증 우선순위에서 `/login` 자격증명보다 앞서므로, 계정을 바꾸려면 이 파일을 지워야 한다(RUNBOOK에 명시). 토큰은 1년 후 만료되므로 probe가 파일 나이 330일 이상이면 경고한다.
  - Codex는 app-server `account/login/start { type: "chatgptDeviceCode" }`가 주는 `verificationUrl`과 `userCode`를 앱에 보여주고, `account/login/completed` 알림으로 완료를 확인한다(이 머신의 codex-cli 0.153.4 바인딩에서 확인됨). 콜백 포트가 필요 없다.
- 검증 필요(남은 것): `claude setup-token`이 PTY 안에서 URL을 출력하고 코드를 stdin으로 받는지는 step 9가 구현 전에 관찰한다. 실패하면 Claude 앱 로그인은 501과 SSH 안내로 폴백한다. 서버 동작 자체는 파일 폴백으로 보장되므로 영향이 없다.
- 결과: 서버 주인의 API 키를 공유하지 않는다. 비용과 사용량은 각자에게 간다. 문서에 없는 사항 두 가지는 구현 시 실측한다: Agent SDK `interrupt()`의 정확한 중단 의미(안 멈추면 abort 후 `resume`으로 재시작), 같은 cwd에서 여러 세션을 동시에 돌릴 때의 잠금(세션 ID별 파일이라 충돌은 없다고 보되 `continue: true`는 쓰지 않는다).

## ADR-009 정규화 이벤트 모델과 fixture 계약

- 배경: 두 에이전트의 이벤트 형태가 다르고, iOS는 TS 타입을 import할 수 없다.
- 결정: `docs/PROTOCOL.md`의 TimelineItem/Approval/WS 이벤트로 정규화한다. TS는 zod 스키마, Swift는 손으로 쓴 Codable이며 `packages/protocol/fixtures/*.json`을 양쪽이 디코딩하는 테스트로 계약을 지킨다. 프로토콜 변경은 fixture → zod → 서버 → iOS 순서.
- 결과: 클라이언트는 에이전트 종류를 몰라도 그린다. 에이전트별 원본 이벤트는 `payload.raw`에 넣지 않는다(크기와 결합도 때문).

## ADR-010 세션 영속화는 JSONL, 재개는 네이티브 ID

- 결정: agent-host가 `~/.mam/sessions/<id>.json`과 `<id>.events.jsonl`을 쓴다. 프로세스가 죽거나 유휴 종료돼도 앱은 히스토리를 본다. 다음 턴은 Claude `resume: <sessionId>`(항상 명시적 ID, `continue: true` 금지), Codex `thread/resume`로 이어간다. 에이전트 네이티브 트랜스크립트의 가져오기(import)는 Phase 3이며, Claude는 `~/.claude/projects/<cwd의 비영숫자를 -로 치환한 이름>/<session-id>.jsonl`과 SDK `listSessions()`, Codex는 `thread/list`를 쓴다.
- 결과: 세션 수명이 프로세스 수명과 분리된다.

## ADR-011 프로세스 생성은 `sudo -u <user> -H -n`

- 배경: Node `spawn`의 `uid/gid` 옵션은 보조 그룹(initgroups)을 설정하지 않는다. `su -l`은 로그인 셸 rc에 의존한다.
- 결정: root gateway가 `/usr/bin/sudo -u <user> -H -n -- <node> <mamCli> agent-host --socket <path>`로 생성한다. sudo가 HOME/USER/SHELL을 대상 사용자 기준으로 초기화하고 보조 그룹을 채운다. agent-host는 시작 후 `$SHELL -lc 'command -v claude; command -v codex'`로 도구 경로를 해석한다.
- 결과: 개발 모드(비 root)에서는 sudo 없이 같은 사용자로 직접 spawn한다. Keychain이 필요한 작업은 하지 않는다(ADR-008).

## ADR-012 iOS 앱 스택

- 결정(2026-09-10 인터뷰로 확정): 앱 이름 `MacAgent`, 번들 ID `dev.mam.MacAgent`. Swift 6, SwiftUI, 최소 iOS 17(`@Observable`, `NavigationSplitView`). 프로젝트는 XcodeGen `ios/project.yml`로 생성하고 `*.xcodeproj`는 커밋하지 않는다. 네트워킹은 URLSession(`URLSessionWebSocketTask`)만 쓰고 서드파티 네트워킹·상태관리 패키지는 없다. UI 패키지는 둘만 허용한다: `swift-markdown-ui`(2.4.x, 에이전트 메시지의 코드블록·표·목록 렌더링)와 `Highlightr`(2.3.x, 파일 뷰어 하이라이트). 시각 방향은 애플 네이티브(시스템 폰트, SF Symbols, 시스템 색, 표준 컨트롤)이며 이벤트 종류를 아이콘과 색으로 구분하는 데만 의견을 싣는다. 세부는 `docs/IOS.md`. 서명은 `ios/Local.xcconfig`(gitignore)의 `DEVELOPMENT_TEAM`으로 개인 기기 설치.
- 결과: 시뮬레이터(iPhone 17 Pro, iOS 26.2)에서 `xcodebuild test`로 AC를 검증한다. 개발 백엔드는 `bash scripts/dev-smoke.sh --keep`이 띄우는 Fake 어댑터 서버다.

## ADR-013 웹 대시보드는 Vite + React, gateway가 서빙

- 결정: Phase 2에서 `apps/web`을 Vite + React + TS로 만들고 `@mam/protocol`을 import한다. 빌드 산출물을 gateway가 `/`에서 정적 서빙한다. 별도 프로세스나 포트 없음.

## ADR-014 배포는 시뮬레이터와 개인 기기부터

- 결정: Phase 1은 시뮬레이터 + 관리자 본인 iPhone(개발 서명, 7일 재서명) 설치까지다. TestFlight/APNs는 유료 개발자 계정 확보 후 Phase 3.

## ADR-015 세션 모드는 4종 프리셋

- 결정: `ask`, `auto-edit`, `full-auto`, `plan`. 매핑은 `docs/PROTOCOL.md` 4절. `full-auto`는 앱에서 별도 확인 후에만 설정 가능하며 서버는 기본값을 `ask`로 강제한다.
- 보완(2026-09-13 확정, Phase `6-member-controls`): **`full-auto` 는 모든 도구 승인 없음.** Claude 는 `permissionMode: "bypassPermissions"`(프로세스는 항상 `allowDangerouslySkipPermissions: true` 로 띄운다 — SDK 가 bypass 에 이 플래그를 요구하며, 플래그는 허용만 하고 켜지는 않는다) + `canUseTool` 이 `full-auto` 면 승인 아이템 없이 즉시 allow, Codex 는 `approvalPolicy: never` + 그래도 오는 승인 요청을 자동 승인(`user_input` 질문은 예외로 사용자에게 올린다). Fake 어댑터도 같은 규칙이다. 실제 SDK/app-server 로 `echo pong` 한 턴을 돌려 승인 0건·도구 1회 이상을 확인했다. 팀원도 같은 모드 집합을 쓰며 전환 확인 다이얼로그는 앱(팀원 편집기·방의 팀원 시트)이 담당한다(`docs/IOS.md` 10.8).

## ADR-016 사용량·컨텍스트는 어댑터가 관측한 값을 누적, 구독 한도는 관측/조회 혼합

- 배경: 사용자가 폰에서 컨텍스트 사용률, 누적 토큰·비용, 모델·사고 수준, 구독 한도를 보고 싶어 한다. Claude Agent SDK는 `result.usage`(턴별)와 `result.modelUsage[*].contextWindow`, `rate_limit_event`(5시간/주간 창 이용률)를 세션 실행 중에만 준다. Codex app-server는 `thread/tokenUsage/updated`(누적·마지막·컨텍스트 창)와 언제든 호출 가능한 `account/rateLimits/read`, `model/list`를 준다.
- 결정: (1) 세션 누적 사용량은 SessionManager가 어댑터의 `usage` 이벤트(턴별 델타 + 컨텍스트 스냅샷)를 더해 `Session.usage`로 영속화하고 `session.usage` 이벤트로 내보낸다. (2) 구독 한도는 `GET /usage`로 통일하되 Claude는 마지막 관측값(`~/.mam/usage/claude.json`, `live: false`), Codex는 즉시 조회(`live: true`)다. (3) 모델 목록은 `GET /models`로 통일하고 Claude는 라이브 세션에서 `supportedModels()`를 캐시, 없으면 정적 기본 목록. (4) 모델·effort 변경은 `PATCH /sessions/:id`이며 적용 시점은 어댑터가 정한다.
- 결과: 프로토콜은 추가만 있고 기존 클라이언트는 깨지지 않는다. Claude 한도는 턴을 한 번 돌려야 갱신되며 앱은 관측 시각을 표시한다. 비용은 추정치이며 Codex 구독 계정은 `null`.

## ADR-017 에이전트 팀: 팀원은 세션, 방은 별도 스트림, worktree 격리, 서버 커밋, 멘션 라우팅

- 배경: 사용자가 한 프로젝트에 역할(팀장·개발자·기획자·코드 리뷰어)을 나눈 에이전트 여러 명을 꾸리고 채팅방처럼 지시하고 싶어 한다. 에이전트마다 Claude 또는 Codex 를 고를 수 있어야 하고, 여러 에이전트가 같은 저장소를 동시에 고치면 서로의 변경을 덮어쓴다. Codex 의 `workspace-write` 샌드박스는 `.git` 쓰기를 막아 에이전트가 스스로 커밋할 수 없다. Claude Agent SDK 는 system prompt 를 세션 시작 시 한 번 고정한다.
- 결정(2026-09-12 인터뷰로 확정):
  - **팀원은 기존 `Session` 하나다.** 새 실행 모델을 만들지 않고 `Session.team = { teamId, memberId }` 만 덧붙인다. 승인도 기존 `POST /sessions/:id/approvals/:approvalId` 로 응답하고 방에는 카드를 미러링만 한다. 에이전트당 세션 하나를 그룹방·DM 이 공유하며, 답변은 턴이 끝난 뒤 한 번에 게시한다(스트리밍 없음).
  - **방은 세션 WS 와 별도 스트림**(`room.*` 이벤트, `room-ws/`·`room-client/` fixture)이고 **방 seq 는 세션 seq 와 분리**한다. 한 방에 여러 세션의 결과가 섞이므로 세션 seq 로는 순서를 만들 수 없고, iOS 가 `fixtures/ws/` 전체를 엄격한 `ServerEvent` enum 으로 디코드하므로 세션 union 에 방 이벤트를 넣으면 구 클라이언트가 깨진다. 방 이벤트 로그는 `~/.mam/teams/<teamId>/rooms/<roomId>.jsonl` 에 SessionManager 와 같은 방식(링버퍼 + JSONL + `since` 재생)으로 둔다.
  - **라우팅은 멘션 기반.** 그룹방은 `@이름`/`@handle` 로 지정된 팀원에게, 멘션이 없으면 팀장(`isLead`, 정확히 1명)에게 보낸다. DM 방은 그 팀원만 응답하고 다른 멘션은 무시한다. `@all` 은 작성자 제외 전원. 에이전트끼리 `@이름` 으로 부를 수 있으되 사용자 메시지 1건당 연쇄 상한 `maxHops`(기본 6), 동시 실행 상한 `maxConcurrent`(기본 2), 맥락 상한 `contextMaxMessages`(기본 40, 12,000자). 맥락은 `[#전체] @민수(개발자): …` 같은 접두어로 넣는다.
  - **worktree 격리.** 팀원마다 `git worktree` 를 `~/.mam/teams/<teamId>/worktrees/<memberId>` 에 만들고 브랜치는 `mam/<team-slug>/<handle>`. 저장소 **밖**에 두는 이유: 저장소 안(`.worktrees/` 등)에 두면 `git status`·glob·grep 과 Codex `writableRoots` 가 이웃 worktree 를 함께 보고 에이전트가 남의 파일을 고친다. 홈 **안**에 두는 이유: `resolveInsideHome()` 샌드박스와 파일 API 규칙(CRITICAL 3)을 그대로 지킨다.
  - **커밋은 서버가 한다.** 턴 종료 시 worktree 변경을 작성자 `<이름> (mam-team) <handle@mam.local>` 로 커밋하고 ChangeSet("변경 준비됨" 카드)을 올린다. 이유: Codex 샌드박스가 `.git` 쓰기를 막아 에이전트에게 커밋을 맡길 수 없고, 어느 에이전트든 같은 형식의 커밋을 남기게 하려면 서버가 한 곳에서 하는 것이 단순하다. 에이전트 지시문에는 "커밋하지 마라" 를 넣는다.
  - **머지는 사용자가 방에서 승인**한다. 서버가 원본 저장소에서 `git merge --no-ff <branch>` 를 실행하고 브랜치는 유지한다(이력에 팀원 브랜치가 남고, 팀원은 같은 브랜치에서 계속 일한다). 충돌은 abort 후 `conflict` 로 보고한다.
  - 팀은 프로젝트(`cwd`)에 속하고, 팀 템플릿(`TeamTemplate`)은 사용자별 `~/.mam/team-templates.json` 에 저장한다.
- 대안: (a) Claude Agent SDK 의 서브에이전트/`Task` 로 팀을 구성 — Codex 를 섞을 수 없고 승인·타임라인이 하나의 세션에 뭉쳐 폰에서 읽기 어렵다. (b) 같은 저장소에서 여러 세션을 그냥 돌리기 — 변경이 겹치고 누가 무엇을 바꿨는지 추적할 수 없다. (c) 에이전트가 직접 커밋 — Codex 샌드박스가 막고, Claude 만 되는 비대칭이 생긴다.
- 결과: 프로토콜은 추가만 있고 기존 클라이언트는 깨지지 않는다(`Session.team` 은 키 생략). 서버는 `TeamManager`·`Dispatcher`·`RoomStore`·`Worktrees` 모듈이 늘고 root 코드는 변하지 않는다. 프롬프트·모델 변경은 다음 세션부터 적용된다(미결 사항 참고). 사용자 홈에 저장소 크기만큼 worktree 가 늘어난다.

## ADR-018 에이전트 간 대화는 곁방으로 분리하고 턴 입력에서 승인·변경 카드를 뺀다

- 배경: 팀을 돌려 보니 한 팀원에게 보내는 턴 입력(PROTOCOL 6.4 "턴 입력")의 대부분이 그 팀원과 무관했다. Phase `9-side-rooms` 설계 때 관측한 방 로그에서 **맥락 줄의 57%가 그 팀원과 상관없는 내용**(남의 승인 카드 제목 = bash 명령 원문, 남의 변경 카드, 다른 두 에이전트끼리의 왕복)이었고, 모든 대화가 모이는 **팀장은 92%**까지 갔다. 연쇄가 길어지면 `contextMaxMessages`(40)·12,000자 상한을 넘어 **정작 필요한 앞 맥락이 잘려 나간 턴**이 생겼다. 원인은 두 가지다: (1) 에이전트끼리의 대화가 전부 그룹방에서 일어나 모든 팀원의 맥락에 들어간다, (2) 맥락에 **남의** 승인·변경 카드까지 한 줄씩 들어간다.
- 결정(2026-09-14):
  - **에이전트 간 대화는 곁방(`Room.kind = "side"`)으로 자동 분리한다.** 그룹방(또는 다른 곁방)에서 **작성자가 에이전트이고 멘션 대상도 에이전트**면 `{작성자} ∪ {멘션 대상}` 의 곁방을 찾거나 만들어 거기서 디스패치한다. **곁방의 신원은 참가자 집합**이라 같은 조합이면 같은 방을 재사용하고 방은 지우지 않는다. 원본 답변은 그 방에 그대로 두고 같은 본문을 곁방에 트리거로 한 번 복사한다(사람이 보던 기록이 사라지지 않게).
  - **사용자 대화는 옮기지 않는다.** 사용자 메시지는 언제나 그 방(그룹·DM·곁방)에서 처리한다. 참가자가 `settings.sideRoomMaxParticipants`(기본 3, 2~8)를 넘으면 공지·브로드캐스트로 보고 곁방을 만들지 않는다. DM 에는 적용하지 않는다.
  - **그룹방에는 연결 카드만 남긴다**(`RoomMessage.sideRoom`): 열릴 때 한 줄, 연쇄가 끝나면 "대화 N건 · 결론: …" 한 줄. 두 카드 모두 곁방을 가리키므로 사람은 카드에서 들어가 직접 끼어들 수 있다. **변경 카드는 곁방에서 한 작업이라도 그룹방에** 올린다(머지를 한곳에서 본다).
  - **맥락 방은 그룹방 + 자기 DM + 자기가 참가한 곁방**이다. 참가하지 않은 곁방의 대화는 보이지 않는다.
  - **턴 입력에는 그 팀원 자신의 승인·변경 카드만** 한 줄로 넣는다(`isContextRelevant`). 2026-09-15 에 자기 것까지 빼도록 좁혔다(아래 보강). 남의 카드는 방 화면에는 그대로 남고 맥락에서만 빠진다. 홉·동시 실행 상한·중복 제거는 방과 무관하게 그대로다(곁방으로 옮겨도 연쇄 깊이는 이어진다).
- 보강(2026-09-15, Phase `10-room-readability`): **턴 입력에서 승인·변경 카드를 자기 것까지 전부 뺀다**(`isContextRelevant` 가 `approval`·`changes` 를 항상 `false`). 자기가 실행한 명령과 바꾼 파일은 그 팀원 세션 타임라인에 이미 있어 방 맥락에 또 넣을 이유가 없고, 실제 팀 측정에서 그룹방 승인 카드 제목(`npx eslint src 2>&1 | tail -30` 같은 bash 명령 원문)이 렌더 기준 맥락의 20%를 차지했다. `text`(사용자·에이전트)와 `system` 은 그대로 둔다 — 시스템 메시지가 홉 상한 안내·서버 재시작 공지·곁방 연결·머지 충돌 해결 지시를 나른다. 카드는 방 화면·방 로그에 그대로 남는다(사람이 승인·머지해야 한다). 트리거 메시지가 카드일 때는 필터와 무관하게 마지막 줄로 들어간다.
- 대안: (a) 맥락을 요약해 줄인다 — 요약 비용·환각이 생기고 원문이 필요한 코드·경로가 뭉개진다. (b) 상한(`contextMaxMessages`)만 낮춘다 — 무관한 줄이 먼저 들어와 필요한 줄을 밀어내는 문제는 그대로다. (c) 에이전트 간 대화를 금지한다 — ADR-017 의 팀 개념(팀장이 팀원을 부른다)을 잃는다.
- 결과: 프로토콜은 추가만 있고(`kind: "side"`, `participants`, `sideRoom`, `sideRoomMaxParticipants`) 기존 클라이언트는 깨지지 않는다. 재현 가능한 측정은 `packages/server/test/teams/format.test.ts` 의 "맥락 절감 측정" 케이스다 — `scripts/dev-smoke.sh` 25단계와 같은 방 로그에서 곁방에 참가하지 않은 팀원의 턴 입력이 **1,152자(필터 없음) → 533자(2026-09-14 규칙) → 443자(2026-09-15 규칙)**, 즉 필터 없음 대비 **62% 절감**(2026-09-14 규칙 대비 17%)이고, 곁방 대화는 한 줄도 들어가지 않는 대신 연결 카드 요약은 남는다. 대신 방 수가 참가자 조합만큼 늘고(사람이 볼 목록이 길어진다) 그룹방만 읽는 사람은 곁방 카드를 눌러 들어가야 자세한 내용을 본다.

## ADR-019 방 승인 카드의 진실은 세션이다 (시한 없음, 재시작 때 재조정)

- 배경(2026-09-15 실제 팀에서 관측): 방에 미러링된 승인 카드(`RoomMessage.approval`)는 `approval.resolved` 를 **그 세션을 구독 중일 때만** 받아 채운다. 그런데 구독은 턴 동안만 유지되고, 게이트웨이가 재시작하면 `SessionManager.open` 이 모든 세션의 `pendingApprovals` 를 0 으로 되돌린다. 그래서 재시작·팀원 세션 종료 뒤에도 방에는 `resolution: null` 인 노란 "승인 대기" 카드가 영원히 남고 `room.snapshot.pendingApprovals` 에도 계속 들어갔다. 그 카드를 눌러 응답하면 `POST /api/v1/sessions/ses_…/approvals/apr_…` 가 404 `not_found` 를 돌려준다. 사용자는 이것을 "full-auto 로 바꿨는데도 계속 승인을 물어본다" 로 겪었다 — 실제 세션은 `mode: full-auto`, `pendingApprovals: 0` 이었고 모드 변경 **이전**에 생긴 유령 카드가 지워지지 않은 것이었다.
- 결정: **진실은 세션이다.** 서버가 다시 열릴 때(`TeamManager.open`)와 팀원 세션이 닫힐 때(`resetMember`·`removeMember`) 방의 미해결 승인 카드를 `SessionManager` 의 실제 대기 목록과 대조한다(`reconcileApprovals`). 세션이 없거나 그 `approvalId` 가 대기 중이 아니면 `resolution = { optionId: "abort", by: "system", at }` 로 채운다 — `SessionManager.resolvePendingBySystem` 이 이미 쓰는 것과 **같은 규약**이다. 아직 대기 중인 승인은 건드리지 않는다(같은 프로세스에서 사람을 기다리는 승인을 죽이면 에이전트가 영원히 멈춘다). **승인에 시한은 두지 않는다** — 살아 있는 요청은 사람이 답할 때까지 기다린다. 카드는 지우거나 `kind` 를 바꾸지 않고(방 로그는 기록이다) 정리할 때 추가 시스템 메시지도 남기지 않는다(재시작 공지가 이미 있다).
- 대안: (a) 미해결 카드를 무조건 전부 정리 — 살아 있는 승인까지 죽인다. (b) 승인 타임아웃(`by: "timeout"`) — 사람이 폰을 늦게 보는 것이 정상인데 그때마다 턴이 취소된다. (c) 카드를 삭제 — 무슨 일이 있었는지 기록이 사라진다.
- 결과: 프로토콜은 그대로다(`ApprovalResolvedBy` 에 `system` 이 이미 있어 **스키마·fixture 변경 없음**). 유령 카드는 다음 기동에 자동으로 정리되므로 마이그레이션 스크립트가 필요 없다. 클라이언트는 `by: "system"` 으로 채워진 카드를 "취소됨" 으로 그린다. 방 seq 는 계속 `RoomManager` 만 발급한다(CRITICAL 7).

## 미결 사항

| 항목 | 결정 시점 |
|---|---|
| `claude setup-token`을 PTY에서 구동해 URL 출력·코드 입력을 받을 수 있는지 | Phase 0 `auth-login-flow` step |
| Agent SDK `interrupt()`의 실제 중단 동작 | Phase 0 `claude-adapter` step 통합 테스트 |
| 유휴 종료 시간 기본값(현재 30분) | 운영 후 조정 |
| Claude `systemPrompt` 가 세션 시작 시 고정(snapshot)되어 팀원 프롬프트 수정은 다음 세션부터 적용된다. 즉시 반영이 필요하면 `PATCH` 시 자동 `reset` 을 할지 | Phase 3 `team-manager` step 또는 운영 후 |
