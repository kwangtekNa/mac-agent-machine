# RUNBOOK: mac-agent-machine 운영

관리자 관점의 설치·사용자 관리·운영·문제 해결 안내. 경로는 `docs/ARCHITECTURE.md` 4절과 같다.

## 1. 설치

사전 조건: macOS 관리자 계정(sudo 가능), Homebrew, 관리자 본인의 `~/.ssh/authorized_keys`에 공개키 등록(하드닝 후 잠기지 않도록), Tailscale 계정. 소요 시간 약 10분(npm ci 포함).

```bash
git clone <repo> ~/mac-agent-machine
sudo bash ~/mac-agent-machine/scripts/setup-server.sh            # 처음
sudo bash ~/mac-agent-machine/scripts/setup-server.sh --hostname macmini.tail1234.ts.net   # MagicDNS 직접 지정
```

스크립트는 멱등이며 단계마다 `==>` 로그를 낸다: root/SUDO_USER 확인 → brew로 tailscale·node 24 → `brew services start tailscale` + 로그인 URL 안내 → SSH 원격 로그인 + `/etc/ssh/sshd_config.d/mam.conf`(공개키 전용) → `/opt/mam` rsync + `npm ci && npm run build && npm prune --omit=dev` → `/etc/mam/config.json`(`mam config init`) → `tailscale cert`(30일 이상 남으면 건너뜀) → launchd `dev.mam.gateway`, `dev.mam.certrenew` → `mam doctor`.

옵션: `--skip-tailscale-up`(로그인은 나중에), `--skip-ssh-hardening`(authorized_keys가 비어 있을 때), `--from <repo>`.

편의를 위해 `alias mam='sudo /opt/homebrew/bin/node /opt/mam/packages/server/dist/cli.js'` 를 두면 아래 예시를 그대로 쓸 수 있다.

## 2. 사용자 추가

```bash
sudo mam user add alice --email alice@example.com --ssh-key-file ./alice.pub [--full-name "Alice Kim"] [--workspace ~/work]
```

출력 예:

```
계정 alice 생성 (비관리자, /bin/zsh, /Users/alice)
authorized_keys 에 공개키 추가
사용자 alice 생성 완료

다음 단계:
  1. Tailscale: alice@example.com 계정을 tailnet 에 초대하거나 이 노드를 해당 사용자에게 공유하세요 ...
  2. SSH: ssh alice@macmini.tail1234.ts.net  (공개키 전용, 비밀번호 로그인 없음)
  3. Claude 로그인: SSH 세션에서 'claude login' 실행 ...
```

정책: 비관리자 계정, 셸 `/bin/zsh`, 홈 `/Users/<name>`, `~/work`, `~/.mam`(0700), `~/.ssh/authorized_keys`(0600), sudo 없음. 비밀번호는 무작위 32자를 생성해 `sysadminctl`에만 넘기고 어디에도 저장·출력하지 않는다. 비밀번호가 필요해지면 `sudo sysadminctl -resetPasswordFor <name> -newPassword -`로 바꾼다. 같은 명령을 다시 실행하면 계정 생성은 건너뛰고 키·config만 갱신한다(멱등).

`sudo mam user list`는 config 항목별 계정 존재·agent-host 소켓 상태를, `sudo mam user remove <name> [--delete-account --yes]`는 config 제거(계정 삭제 시 홈은 보존)를 수행한다.

## 3. 사용자 온보딩 안내문

1. Tailscale 앱을 설치하고 초대받은 tailnet에 로그인(또는 공유된 노드 수락).
2. `ssh <name>@<hostname>` 으로 접속(공개키 전용).
3. Claude 로그인: SSH 세션에서 `claude login`이면 충분하다. Keychain이 잠긴 SSH 세션에서는 Claude Code가 자격증명을 `~/.claude/.credentials.json`에 자동 저장하며 서버가 이를 그대로 읽는다(ADR-008). 대안으로 앱에서 로그인하는 흐름(`claude setup-token`)이 있다. 앱 로그인이 만드는 `~/.mam/secrets/claude-oauth-token`은 `/login` 자격증명보다 우선하므로 계정을 바꾸려면 이 파일을 지워야 한다. 이 토큰은 1년 후 만료된다.
4. Codex 로그인: SSH에서 `codex login`(출력된 URL을 브라우저에서 열기) 또는 앱의 device code 흐름.
5. MacAgent 앱에 `https://<hostname>`을 입력한다. 로그인 화면은 없다. 접속 기기의 Tailscale 신원으로 자동 매핑된다.
6. 앱에서 사용 한도 보기: 설정 > 구독 사용 한도(또는 세션 정보 시트의 "구독 한도"). Codex 는 열 때마다 즉시 조회되지만, Claude 한도는 세션을 한 번 돌려야(턴을 보내야) 관측값이 갱신되며 카드에 "마지막 관측 HH:mm" 이 표시된다.


### iPhone에 설치 (개발 빌드, TestFlight 는 Phase 6)

1. `ios/Local.xcconfig` 를 만들고(`cp ios/Local.xcconfig.example ios/Local.xcconfig`) `DEVELOPMENT_TEAM` 에 Apple Developer 팀 ID를 적는다. 무료 Apple ID 도 된다.
2. `cd ios && xcodegen generate && open MacAgent.xcodeproj` 로 Xcode 를 연다.
3. iPhone 을 USB 로 연결하고 iPhone 의 설정 > 개인정보 보호 및 보안 > 개발자 모드를 켠다(재시동).
4. Xcode 상단에서 연결한 iPhone 을 선택하고 실행(⌘R)한다. 처음 한 번 Xcode 가 프로비저닝 프로파일을 만든다.
5. iPhone 에서 앱이 열리지 않으면 설정 > 일반 > VPN 및 기기 관리에서 개발자 앱을 신뢰한다.
6. 무료 계정의 프로파일은 7일 뒤 만료되므로 7일마다 Xcode 에서 다시 실행(재설치)한다. 유료 계정은 1년.
7. iPhone 에 App Store 의 Tailscale 앱을 설치하고 같은 tailnet 에 로그인한다.
8. MacAgent 앱 첫 화면에 `https://<MagicDNS 호스트 이름>` 을 입력한다(`tailscale cert` 로 만든 인증서를 gateway 가 쓴다). 로그인 화면은 없다.

개발 서버로 확인하려면 시뮬레이터에서 `bash scripts/dev-smoke.sh --keep` 을 띄우고 앱의 "개발 서버(127.0.0.1:7777)에 연결" 버튼을 누른다.

### 앱 로그인 플로우 수동 확인 (step 9, 사람이 브라우저로 끝낸다)

개발 모드에서 확인한다. `MAM_FAKE_AGENT` 없이 gateway 를 띄우고 다른 터미널에서:

```bash
npm run dev -w @mam/server -- gateway --dev
curl -s -X POST -H 'X-MAM-Protocol: 1' http://127.0.0.1:7777/api/v1/auth/claude/login
# → {"flowId":"flw_...","url":"https://claude.com/cai/oauth/authorize?...","instructions":"...","needsCode":true}
# 폰/브라우저에서 url 을 열어 로그인하고 표시되는 코드를 복사한 뒤:
curl -s -X POST -H 'X-MAM-Protocol: 1' -H 'Content-Type: application/json' \
  -d '{"code":"<붙여넣은 코드>"}' http://127.0.0.1:7777/api/v1/auth/claude/login/<flowId>/code
curl -s -H 'X-MAM-Protocol: 1' http://127.0.0.1:7777/api/v1/auth/claude/login/<flowId>
# → {"status":"done","message":"로그인 완료"} 이면 ~/.mam/secrets/claude-oauth-token(0600) 이 생겼고 GET /api/v1/me 의 claude.loggedIn 이 true 다.
```

Codex 는 `POST /api/v1/auth/codex/login` 이 `{ url, instructions: "링크를 열고 코드 XXXX-XXXX 를 입력하세요", needsCode: false }` 를 주며, 브라우저에서 코드를 입력하면 상태가 `done` 이 된다. 코드 제출 엔드포인트는 쓰지 않는다.

- 바이너리가 없으면 501 `agent_unavailable` 과 SSH 안내가 온다. 플로우는 에이전트당 1개, 15분 뒤 만료, 10분 안에 끝나지 않으면 `error`.
- 성공 화면의 토큰 접두어(`sk-ant-oat01-`)는 아직 실측 전이다. `status` 가 `done` 으로 안 바뀌면 `packages/server/src/agent-host/auth/README.md` 의 관찰 기록과 `TOKEN_RE` 를 확인한다.
- 계정을 바꾸려면 `~/.mam/secrets/claude-oauth-token` 을 삭제한다(이 파일이 `/login` 자격증명보다 우선한다).

## 4. 운영

- 로그: gateway `/var/log/mam/gateway.log`, 인증서 갱신 `/var/log/mam/certrenew.log`, 사용자별 agent-host `~<user>/.mam/agent-host.log`.
- 재시작: `sudo launchctl kickstart -k system/dev.mam.gateway`.
- 진단: `sudo mam doctor` (`--json`). fail이 하나라도 있으면 exit 1.
- 업그레이드: 저장소를 pull 한 뒤 `setup-server.sh`를 다시 실행한다. config는 유지되고(`--force` 없이는 그대로), 인증서는 30일 이상 남았으면 재발급하지 않는다.
- 인증서: `dev.mam.certrenew`가 매주 일요일 04:00에 `scripts/renew-cert.sh`로 재발급하고 gateway를 재시작한다. 수동: `sudo bash /opt/mam/scripts/renew-cert.sh /opt/homebrew/bin/tailscale <hostname>`.
- `/var/run/mam`은 재부팅 시 비워지며 gateway가 시작할 때 다시 만든다(supervisor).

## 5. 문제 해결

| 증상 | 확인 |
|---|---|
| 403 `unknown tailnet identity` | 접속 기기가 tailnet에 있는지, 태그 노드가 아닌지. `tailscale whois <ip>` |
| 403 `no account mapped for <email>` | `sudo mam user list`로 config users[] 이메일(소문자) 확인 |
| 502/503 `agent_unavailable` | `~<user>/.mam/agent-host.log`, `/var/log/mam/gateway.log`의 `[agent-host:<user>]` 줄. 503은 크래시 백오프 중 |
| 인증서 만료·경고 | `sudo mam doctor`의 `tls` 항목, `renew-cert.sh` 수동 실행 |
| tailscale 재로그인 | `sudo tailscale up` 후 `mam doctor`의 `tailscale`, `tailscale.dns` 확인 |
| Claude "로그인 필요" | 사용자 홈의 `~/.claude/.credentials.json` 존재 여부와 `~/.mam/secrets/claude-oauth-token`(앱 로그인, 우선 적용, 330일 이상이면 경고) 확인 |
| gateway가 안 뜸 | `sudo launchctl print system/dev.mam.gateway`, `/var/log/mam/gateway.log` |

## 6. 팀 운영 (Phase 3, `docs/PROTOCOL.md` 6절)

한 프로젝트(git 저장소)에 역할별 에이전트 팀을 꾸리고 방에서 지시한다. 팀원은 각자 `~/.mam/teams/<teamId>/worktrees/<memberId>/` 의 git worktree(브랜치 `mam/<팀-slug>/<handle>`)에서 일하고, 커밋은 서버가, 머지는 사용자가 한다.

- **팀 만들기**: `POST /api/v1/teams { cwd, name, members[] }`. `cwd` 는 홈 안의 git 저장소여야 하고 현재 브랜치가 머지 대상(`baseBranch`)이 된다. 팀장(`isLead`)은 정확히 1명. 그룹방(`#전체`)과 팀원별 DM 방이 생기고, 세션은 첫 메시지 때 시작된다. 멘션 없는 그룹방 메시지는 팀장이, `@이름`/`@handle` 이 있으면 그 팀원이 받는다. 자주 쓰는 구성은 `POST /api/v1/team-templates` 로 저장해 `templateId` 로 재사용한다.
- **폰에서 저장소 초기화**(2026-09-13, `POST /api/v1/git/init`): 고른 디렉토리가 git 저장소가 아니면 팀 생성이 400 으로 막히므로 앱이 그 자리에서 초기화를 제안한다. 서버는 `.gitignore` 가 없을 때만 기본 파일을 만들고(`.DS_Store`, `node_modules/`, `dist/`, `build/`, `.build/`, `DerivedData/`, `xcuserdata/`, `__pycache__/`, `.venv/`, `*.log`, `.env`, `.env.*`; 첫 줄 주석 "MacAgent 기본 .gitignore — 필요에 맞게 고치세요"), `git init -b main` → `git add -A` → `git commit -m "Initial commit"` 을 실행한다. 기존 `.gitignore` 는 절대 덮어쓰지 않는다. 첫 커밋 정책: 기존 파일을 전부 담는다(팀원 worktree 가 `main` 을 체크아웃하므로 커밋되지 않은 파일은 에이전트에게 보이지 않는다). 파일이 하나도 없어도 빈 커밋을 만든다. 기본 브랜치는 사용자의 `init.defaultBranch` 설정과 무관하게 항상 `main` 이고, `user.name`/`user.email` 이 없으면 그 커밋에만 `MacAgent <mam@mam.local>` 을 작성자로 쓴다(전역 git 설정은 바꾸지 않는다). 이미 저장소이거나 상위 디렉토리가 저장소면 409 로 거절한다(중첩 저장소 방지). `dryRun: true` 로 먼저 부르면 아무것도 바꾸지 않고 커밋될 파일 수·바이트를 미리 볼 수 있다.
- **머지 승인**: 팀원 턴이 끝나면 서버가 worktree 변경을 커밋하고 그룹방에 "변경 준비됨"(`kind: changes`, `status: ready`) 카드를 올린다. 사용자가 `POST /api/v1/teams/:id/changes/:changeId/merge` 를 부르면 원본 저장소에서 `git merge --no-ff` 가 실행되고 브랜치는 남는다. 원본 저장소에 커밋되지 않은 변경이 있거나 현재 브랜치가 `baseBranch` 가 아니면 409 가 나므로 먼저 커밋/stash 하거나 브랜치를 되돌린다. 필요 없는 변경은 `.../dismiss`.
- **충돌 시 흐름**: 머지가 충돌하면 서버가 `merge --abort` 로 원본을 깨끗하게 되돌리고 카드가 `conflict` 가 된다. 그 팀원 worktree 에만 충돌 마커를 남기고 DM 방에 시스템 메시지와 함께 해결 턴이 디스패치된다. 팀원이 파일을 정리하면 턴 종료 시 머지 커밋이 만들어지고 새 `ready` 카드가 올라오니 다시 머지를 승인한다. 턴 전 `baseBranch` 최신화가 충돌해도 같은 방식(안내문이 턴 앞에 붙는다)이다.
- **팀·팀원 삭제**: `DELETE /api/v1/teams/:id` 는 worktree 에 커밋되지 않은 변경이 있으면 409 로 거절한다. 그 변경이 필요 없으면 `?keepWorktrees=true` 로 등록만 해제한 뒤 `~/.mam/teams/<teamId>/worktrees/` 를 직접 살펴보고 `git -C <repo> worktree remove <경로>` 로 정리한다(팀원 하나는 `?keepWorktree=true`). 브랜치는 삭제해도 남는다.
- **한도 걸림 시 재개**: 팀원 턴이 구독 사용 한도(rate limit) 오류로 끝나면 그룹방에 "구독 사용 한도에 걸려 팀 작업을 멈췄습니다" 가 올라오고 팀 디스패치가 멈춘다. 한도가 풀린 뒤 방에 메시지를 보내면 다시 시작한다. 실행 중 턴을 전부 끊으려면 `POST /api/v1/teams/:id/stop`.
- **권한·모델·사고 수준**: 팀원 편집기(새 팀 시트·팀 설정)와 방 툴바의 팀원 시트에서 바꾼다(`docs/IOS.md` 10.8). `full-auto` 는 확인 다이얼로그 뒤에만 켜지고, 켜면 그 팀원은 승인 없이 명령을 실행하고 파일을 고친다(ADR-015).
- **프롬프트·모델 수정**: `PATCH /api/v1/teams/:id/members/:memberId` 의 `prompt`·`model` 은 다음 세션부터 적용된다(Claude Agent SDK 가 system prompt 를 세션 시작 시 고정). 바로 반영하려면 앱의 "기억 초기화" 버튼(`POST .../members/:memberId/reset`)으로 세션을 새로 연다. worktree 와 브랜치는 유지된다. `mode`·`effort` 는 즉시 적용.
- **앱에서 팀 만들기·방·머지**(Phase 4, `docs/IOS.md` 10절): 폰에서는 세션 홈의 `+` → "새 팀" 으로 이름·git 저장소·팀원(역할 프리셋, Claude/Codex, 팀장 1명)을 정하고 "팀 만들기" 를 누르면 방 목록(`#전체` + 팀원별 DM)이 열린다. `#전체` 에서 `@이름` 을 치면 제안 칩이 뜨고, 멘션 없이 보내면 팀장에게 간다. 팀원이 권한을 요청하면 방 하단 배너(작성자 캡션 포함)에서 허용·거절하고, 답변 아래 "도구 N회 · 파일 N개 변경 · N초" 작업 요약을 탭하면 그 팀원의 타임라인이 열린다. 턴이 끝나 "변경 준비됨" 카드가 오면 "<base>에 병합" → 확인으로 원본 저장소에 머지되고 카드가 "병합됨 · <해시>" 로 바뀐다. 팀 설정(툴바)에서 팀원 편집·기억 초기화·작업 전부 중단·팀 삭제(409 면 "worktree 남기고 삭제")를 한다. 팀원 worktree 에는 `node_modules` 같은 의존성이 없어 에이전트가 테스트·빌드를 못 돌리므로, 필요하면 사용자가 그 worktree 디렉토리(`~/.mam/teams/<teamId>/worktrees/<memberId>/`)에서 직접 설치한다.
- **worktree 의존성**: worktree 는 `git worktree add` 로 만든 깨끗한 체크아웃이라 `node_modules` 같은 설치물이 없다. 테스트·빌드가 필요하면 사용자가 그 worktree 디렉토리에서 직접 설치한다(자동 설치는 후속 과제).
- **재시작**: agent-host 가 다시 뜨면 진행 중이던 턴은 취소되고 그룹방에 안내가 올라온다. `merging` 이던 카드는 git 을 대조해 `merged` 또는 `ready` 로, 브랜치가 바뀐 `ready` 카드는 `stale` 로 정리된다.
- **개발 확인**: `bash scripts/dev-smoke.sh` 의 15~21단계가 Fake 어댑터로 팀 생성 → 방 WS → 멘션 디스패치 → 변경 카드 → DM → 팀원 제어(full-auto 는 승인 카드 없음) → 머지 → 삭제를 통과한다. 실제 CLI 는 `MAM_IT_CLAUDE=1`/`MAM_IT_CODEX=1 npx vitest run --root packages/server test/teams/integration.test.ts`(비용 수 센트).

## 7. 보안 노트

네트워크 경계는 Tailscale이며 gateway는 tailnet IP에만 바인딩한다. 신원은 전송 계층(`tailscale whois`)에서만 오고 클라이언트 헤더는 덮어쓴다. root 코드는 gateway뿐이며 파일·git·에이전트는 사용자 권한 agent-host가 처리한다. 파일 접근은 홈 안으로 제한된다. 서버 코드는 셸 문자열을 실행하지 않는다. 토큰·승인 본문·파일 내용·비밀번호는 로그에 남기지 않는다. SSH는 공개키 전용(`/etc/ssh/sshd_config.d/mam.conf`)이며 방화벽에서 sshd를 tailnet 인터페이스로만 허용하도록 권장한다.

## 8. 원격 접속 (Tailscale + 개발 gateway)

내 Mac 한 대를 나 혼자 쓰는 경우의 간이 경로다. 정식 설치(1절, root LaunchDaemon `dev.mam.gateway` + TLS + whois 신원)와는 별개이며 서로 건드리지 않는다. 개발 모드 gateway 를 tailnet IPv4 에만 바인딩해 **로그인할 때마다 자동 시작**하는 LaunchAgent(`dev.mam.dev-gateway`)를 걸어 두면, 카페든 회사든 네트워크가 바뀌어도 폰에서 항상 같은 주소(`http://100.x.y.z:7777`)로 붙는다.

1. **Mac: Tailscale 로그인.** 메뉴 막대의 Tailscale 앱에서 로그인하거나 `tailscale up` 을 실행한다. 주소는 `tailscale ip -4` 로 확인한다(`100.` 으로 시작하는 IPv4).
2. **Mac: 빌드 + LaunchAgent 설치.**

   ```bash
   npm run build --workspaces --if-present && bash scripts/install-dev-gateway.sh
   ```

   스크립트는 `node`·`codex`·`claude` 의 절대 경로를 로그인 셸에서 찾아 `~/Library/LaunchAgents/dev.mam.dev-gateway.plist` 를 만들고(`MAM_DEV_BIND=tailscale`, `MAM_DEV_PORT=7777`, `KeepAlive`), `launchctl bootstrap gui/<uid>` 로 등록한 뒤 `http://<tailnet ip>:7777/healthz` 를 확인하고 앱에 넣을 주소를 출력한다. 포트를 바꾸려면 `--port 8777`. 손으로 띄운 gateway 나 `dev-smoke.sh --keep` 가 같은 포트를 잡고 있으면 설치하지 않고 멈춘다(먼저 끄면 된다). 제거는 `--uninstall`, 설치하지 않고 plist 만 보려면 `--dry-run`.
3. **폰: Tailscale 연결.** App Store 의 Tailscale 앱을 설치해 같은 계정으로 로그인하고 연결(VPN)을 켠다.
4. **폰: 앱 서버 주소.** MacAgent 앱 첫 화면에 `http://<tailnet ip>:7777` 을 입력한다. 로그인 화면은 없다.

문제 해결:

| 증상 | 확인 |
|---|---|
| 폰에서 안 붙음 | `bash scripts/install-dev-gateway.sh --status` (plist·launchd 상태·healthz·주소를 한 번에 보여준다) |
| gateway 가 안 뜸 | 로그 `~/.mam/dev-gateway.log`. Tailscale 이 꺼져 있으면 tailnet IP 가 없어 바인딩에 실패하고, `KeepAlive` 가 10초(`ThrottleInterval`)마다 다시 시도한다. Tailscale 을 켜면 그대로 붙는다 |
| Claude/Codex 세션이 "사용할 수 없음" | LaunchAgent 는 로그인 셸을 거치지 않아 nvm 경로가 잡히지 않는다. 스크립트가 `MAM_CLAUDE_BIN`/`MAM_CODEX_BIN` 을 plist 에 박아 두므로, 설치 뒤에 CLI 를 새로 깔았다면 스크립트를 다시 실행한다 |
| 회사 VPN 과 같이 쓸 때 | VPN 이 `100.64.0.0/10`(tailnet 대역) 라우팅을 가로채지 않는지 확인한다. Tailscale 앱의 "Use Tailscale subnets" 설정과 VPN 클라이언트의 split tunnel 설정을 본다 |
| 포트를 이미 쓰는 프로세스 | `lsof -nP -iTCP:7777 -sTCP:LISTEN`. `dev-smoke.sh --keep` 를 띄워 두었다면 끄거나 `--port` 로 다른 포트를 쓴다 |

보안 노트: 개발 모드 gateway 는 TLS 없이 tailnet IP 의 7777 에 뜨고 **접속자를 전부 현재 사용자(설치한 본인)로 취급한다**(`--dev` 는 whois 대신 고정 신원, ADR-004). tailnet 에 다른 사람(또는 공유받은 노드)이 있으면 그 사람도 내 계정 권한으로 파일과 에이전트를 쓸 수 있으므로 이 경로를 쓰지 말고 1절의 정식 설치를 쓴다. 바인딩은 항상 tailnet IPv4 하나뿐이며 `0.0.0.0` 이나 LAN IP 로 설치하지 않는다.
