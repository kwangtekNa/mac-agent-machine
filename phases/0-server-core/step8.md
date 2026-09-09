# Step 8: cli-and-install

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/PRD.md` (3절 핵심 시나리오 1~3, F1, F12)
- `/docs/ARCHITECTURE.md` (2.1, 4절 런타임 경로, 5절 설정, 6절 보안 모델의 SSH)
- `/docs/ADR.md` (ADR-001, 002, 004, 011)
- `/packages/server/src/cli.ts`, `/packages/server/src/config.ts`, `/packages/server/src/gateway/*.ts` (step 7)
- `/packages/server/src/agent-host/server.ts` (step 4), `/packages/server/src/agents/*/adapter.ts`의 `probe()` (step 5, 6)
- `/scripts/test.sh`

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

관리자용 CLI(`mam user ...`, `mam doctor`, `mam config init`), launchd plist, 서버 1회 설치 스크립트, 운영 문서를 만든다. 이 step의 코드는 대부분 root로 실행되지만 **하네스 세션은 root가 아니므로** 모든 시스템 명령은 주입 가능한 `exec` 인터페이스 뒤에 두고 테스트는 가짜로 한다.

### 사용자 계정 정책 (결정 사항)

- 비관리자 계정. 셸 `/bin/zsh`. 홈 `/Users/<name>`.
- 비밀번호는 무작위 32자를 생성해 `sysadminctl`에 넘기고 **어디에도 저장하거나 출력하지 않는다.** SSH는 공개키 전용이라 비밀번호는 쓰이지 않는다. 사용자가 비밀번호가 필요해지면 관리자가 `sysadminctl -resetPasswordFor`로 바꾼다.
- 워크스페이스 `~/work`(config `workspaceRoot`), `~/.mam` 0700, `~/.ssh/authorized_keys` 0600.
- sudo 권한 없음.

### 1. 관리자 모듈 `packages/server/src/admin/`

```ts
export interface Exec { (bin: string, args: string[], opts?: { input?: string }): Promise<{ code: number; stdout: string; stderr: string }> }
export interface AdminDeps { exec: Exec; fs?: typeof import('node:fs/promises'); configPath: string; logger? }

// users.ts
export async function addUser(deps: AdminDeps, opts: { name: string; email: string; fullName?: string; sshKey?: string; workspace?: string }): Promise<{ created: boolean; nextSteps: string[] }>;
export async function listUsers(deps: AdminDeps): Promise<Array<{ macUser: string; email: string; accountExists: boolean; socketAlive: boolean }>>;
export async function removeUser(deps: AdminDeps, opts: { name: string; deleteAccount?: boolean; yes?: boolean }): Promise<void>;
// doctor.ts
export async function runDoctor(deps: AdminDeps & { config?: Config }): Promise<{ checks: Array<{ name: string; status: 'ok'|'warn'|'fail'; detail: string }>; ok: boolean }>;
// config-init.ts
export async function initConfig(deps: AdminDeps, opts: { hostname?: string; port?: number; force?: boolean }): Promise<string>;
```

`addUser` 순서(멱등): 계정 존재 확인(`dscl . -read /Users/<name>`) → 없으면 `sysadminctl -addUser <name> -fullName <fullName> -password <random> -home /Users/<name> -shell /bin/zsh` → 홈 없으면 `createhomedir -c -u <name>` → `authorized_keys` 추가(중복 방지) → `~/work`, `~/.mam` 생성 → 소유권 `chown -R <name>:staff` 해당 경로만 → `/var/run/mam/<name>` 0700 소유 사용자 → config `users[]`에 항목 추가/갱신(원자적 쓰기, 이메일 소문자) → `nextSteps`(Tailscale 초대/공유, `ssh <name>@<hostname>`, 로그인 방법 안내). 이름은 `^[a-z_][a-z0-9_-]{0,30}$`만 허용, 이메일은 zod email.

`runDoctor` 검사 항목(각각 독립 함수로): root 여부, config 파싱, tailscale 바이너리·`tailscale status --json`의 `BackendState === 'Running'`·IPv4·`Self.DNSName`이 `config.hostname`과 일치, TLS 파일 존재와 만료(`openssl x509 -enddate -noout -in <cert>` 파싱, 14일 미만이면 warn), `paths.node`/`paths.mamCli` 존재, sshd 활성(`launchctl print system/com.openssh.sshd`), `/etc/ssh/sshd_config.d/mam.conf` 존재, `/var/run/mam` 권한, 사용자별: 계정·홈·워크스페이스·소켓 디렉토리, 에이전트 probe(`sudo -u <u> -H -n -- <node> <mamCli> agent-host --probe`; 이를 위해 `agent-host --probe` 플래그를 추가: 어댑터 probe 결과 JSON을 stdout에 출력하고 종료), gateway launchd 로드(`launchctl print system/dev.mam.gateway`). 결과를 표로 출력하고 fail이 하나라도 있으면 exit 1.

### 2. CLI 서브커맨드 (`src/cli.ts` + `src/cli/*.ts`)

- `mam user add <name> --email <email> [--ssh-key <pubkey> | --ssh-key-file <path>] [--full-name <n>] [--workspace <dir>] [--config <path>]`
- `mam user list [--config]`, `mam user remove <name> [--delete-account] [--yes]`
- `mam doctor [--config] [--json]`
- `mam config init [--hostname <h>] [--port <p>] [--force] [--config]`
- `mam agent-host --probe` (위)
- 실제 `Exec` 구현은 `spawn` 기반, `src/admin/exec.ts`. root 필요 명령은 `process.getuid() !== 0`이면 친절한 오류로 종료.

### 3. launchd 템플릿 `scripts/launchd/`

- `dev.mam.gateway.plist.tmpl`: `Label dev.mam.gateway`, `ProgramArguments [__NODE__, __MAM_CLI__, gateway, --config, /etc/mam/config.json]`, `RunAtLoad`, `KeepAlive`, `StandardOutPath /var/log/mam/gateway.log`, `StandardErrorPath` 동일, `EnvironmentVariables.PATH /opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`.
- `dev.mam.certrenew.plist.tmpl`: 주 1회(`StartCalendarInterval` 일요일 04:00) `__TAILSCALE__ cert --cert-file /etc/mam/tls/cert.pem --key-file /etc/mam/tls/key.pem __HOSTNAME__` 후 `launchctl kickstart -k system/dev.mam.gateway`를 실행하는 `scripts/renew-cert.sh`.
- `packages/server/src/admin/plist.ts`에 `renderPlist(template, vars)`를 두고 테스트에서 `plutil -lint -`로 검증.

### 4. 설치 스크립트 `scripts/setup-server.sh`

`sudo bash scripts/setup-server.sh [--from <repo-dir>] [--hostname <magicdns>] [--skip-tailscale-up] [--skip-ssh-hardening]`. `set -euo pipefail`. 멱등. 단계마다 `==> ...` 로그.

1. root 확인, `SUDO_USER` 확인(brew는 root로 못 돌리므로 `sudo -u "$SUDO_USER" brew ...`).
2. Homebrew 존재 확인(없으면 안내 후 종료). `tailscale`, `node`(24 이상) 없으면 설치.
3. `sudo brew services start tailscale`(시스템 데몬). `tailscale status --json`으로 상태 확인. `BackendState`가 `NeedsLogin`이면 `tailscale up`을 실행해 로그인 URL을 출력하고 로그인 완료까지 대기(`--skip-tailscale-up`이면 안내만).
4. SSH: `systemsetup -setremotelogin on`. `/etc/ssh/sshd_config.d/mam.conf`에 `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `PermitRootLogin no`, `ChallengeResponseAuthentication no` 기록 후 `launchctl kickstart -k system/com.openssh.sshd`. **하드닝 전에** `SUDO_USER`의 `~/.ssh/authorized_keys`가 비어 있으면 경고하고 `--skip-ssh-hardening` 없이는 중단한다(관리자가 잠기는 사고 방지).
5. 배포: `rsync -a --delete --exclude node_modules --exclude .git --exclude phases --exclude ios --exclude .worktrees --exclude apps <repo>/ /opt/mam/` → `cd /opt/mam && npm ci && npm run build && npm prune --omit=dev`.
6. `mkdir -p /etc/mam/tls /var/log/mam /var/run/mam`(권한 `/var/run/mam` 0755 root). `node /opt/mam/packages/server/dist/cli.js config init --hostname <h>`(hostname 미지정 시 `tailscale status --json`의 `Self.DNSName`에서 끝 점 제거).
7. `tailscale cert --cert-file /etc/mam/tls/cert.pem --key-file /etc/mam/tls/key.pem <hostname>` (이미 있고 30일 이상 남았으면 건너뜀). 권한 0600.
8. plist 렌더링 → `/Library/LaunchDaemons/`(0644 root) → `launchctl bootout system/<label>` 무시 → `launchctl bootstrap system <plist>`.
9. `node /opt/mam/packages/server/dist/cli.js doctor`.

`/var/run`은 재부팅 시 비워지므로 gateway 시작 시 `/var/run/mam`을 스스로 만들도록 step 7 코드가 되어 있는지 확인하고, 없으면 supervisor에 추가한다.

### 5. 문서 `docs/RUNBOOK.md`

관리자 관점으로: 설치(사전 조건, 명령, 소요 시간), 사용자 추가(`sudo mam user add …` 예시와 출력), 사용자 온보딩 안내문(Tailscale 가입/노드 공유, `ssh`, Claude 로그인: SSH에서 `claude login`이면 충분하다 — Keychain이 잠긴 SSH 세션에서는 Claude Code가 자격증명을 `~/.claude/.credentials.json`에 자동 저장하며 서버가 이를 그대로 읽는다(ADR-008). 앱에서 로그인하는 대안 흐름(step 9)과, 앱 로그인으로 만들어진 `~/.mam/secrets/claude-oauth-token`이 `/login` 자격증명보다 우선하므로 계정을 바꾸려면 이 파일을 지우라는 안내, 토큰 1년 만료. `codex login`은 SSH에서 URL을 열거나 앱의 device code 흐름), 운영(로그 경로, `launchctl kickstart -k system/dev.mam.gateway`, `mam doctor`, 업그레이드 = `setup-server.sh` 재실행), 문제 해결(403 → whois·매핑, 502/503 → agent-host 로그 `~/.mam/agent-host.log`, 인증서 만료, tailscale 재로그인, Claude "로그인 필요" → `~/.claude/.credentials.json` 존재 여부와 토큰 파일 확인), 보안 노트(이 문서 6절 요약).

### 6. 테스트 (`packages/server/test/admin/`, `test/cli/`)

- `addUser`: 가짜 exec 호출 기록으로 `sysadminctl` 인자(비밀번호가 로그·stdout에 안 나옴), 이미 존재하면 생성 건너뜀, authorized_keys 중복 방지, config 갱신 원자성, 잘못된 이름 거부.
- `runDoctor`: 가짜 exec로 ok/warn/fail 조합, 만료 임박 인증서 warn.
- `renderPlist` + `plutil -lint`.
- `bash -n scripts/setup-server.sh scripts/renew-cert.sh`.
- CLI 파싱: `--help`가 모든 서브커맨드를 나열, root 아닐 때 `user add`가 exit 1과 메시지.

## Acceptance Criteria

```bash
npm ci
npm run typecheck
npm test
bash -n scripts/setup-server.sh && bash -n scripts/renew-cert.sh
node packages/server/dist/cli.js --help | grep -E "user|doctor|config|gateway|agent-host"
node packages/server/dist/cli.js doctor --config /nonexistent.json; test $? -eq 1        # 크래시 없이 fail 종료
node packages/server/dist/cli.js agent-host --probe | node -e 'JSON.parse(require("fs").readFileSync(0,"utf8"))'
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 런타임 경로가 `docs/ARCHITECTURE.md` 4절과 일치하는가?
   - 셸 문자열 실행이 없고 모든 시스템 명령이 `Exec` 인터페이스를 거치는가(CRITICAL 4)?
   - 비밀번호·토큰이 로그에 남지 않는가(CRITICAL 6)?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- 이 머신에서 `setup-server.sh`, `sysadminctl`, `systemsetup`, `launchctl bootstrap`, `sudo`를 실제로 실행하지 마라. 이유: 개발 머신의 시스템 상태를 바꾼다. 실행은 관리자가 대상 서버에서 한다.
- 새 macOS 계정에 admin 권한을 주지 마라(`-admin` 금지).
- 비밀번호를 파일·로그·stdout에 남기지 마라.
- `rm -rf`를 스크립트에 쓰지 마라. 이유: 하네스 가드가 차단하고 설치 스크립트에 필요하지도 않다. 정리는 `rsync --delete`와 대상 지정 `rm -f`만.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
