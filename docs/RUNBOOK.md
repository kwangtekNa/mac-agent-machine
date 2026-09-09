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

## 6. 보안 노트

네트워크 경계는 Tailscale이며 gateway는 tailnet IP에만 바인딩한다. 신원은 전송 계층(`tailscale whois`)에서만 오고 클라이언트 헤더는 덮어쓴다. root 코드는 gateway뿐이며 파일·git·에이전트는 사용자 권한 agent-host가 처리한다. 파일 접근은 홈 안으로 제한된다. 서버 코드는 셸 문자열을 실행하지 않는다. 토큰·승인 본문·파일 내용·비밀번호는 로그에 남기지 않는다. SSH는 공개키 전용(`/etc/ssh/sshd_config.d/mam.conf`)이며 방화벽에서 sshd를 tailnet 인터페이스로만 허용하도록 권장한다.
