#!/usr/bin/env bash
# mac-agent-machine 서버 1회 설치 (멱등). 대상 Mac 에서 관리자가 실행한다:
#   sudo bash scripts/setup-server.sh [--from <repo-dir>] [--hostname <magicdns>] [--skip-tailscale-up] [--skip-ssh-hardening]
set -euo pipefail
FROM_DIR="$(cd "$(dirname "$0")/.." && pwd)"; HOSTNAME_OPT=""; SKIP_TS_UP=0; SKIP_SSH=0
while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM_DIR="$2"; shift 2 ;;
    --hostname) HOSTNAME_OPT="$2"; shift 2 ;;
    --skip-tailscale-up) SKIP_TS_UP=1; shift ;;
    --skip-ssh-hardening) SKIP_SSH=1; shift ;;
    -h|--help) sed -n '2,3p' "$0"; exit 0 ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 2 ;;
  esac
done
INSTALL_DIR=/opt/mam; CLI="$INSTALL_DIR/packages/server/dist/cli.js"; CONFIG=/etc/mam/config.json
TLS_DIR=/etc/mam/tls; SSHD_CONF=/etc/ssh/sshd_config.d/mam.conf; LAUNCHD_DIR=/Library/LaunchDaemons
log() { echo "==> $*"; }
json_field() { "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(String(process.argv[1].split(".").reduce((o,k)=>o&&o[k],j)||"").replace(/\.$/,""))}catch{console.log("")}})' "$1"; }

# 1. root / SUDO_USER
if [ "$(id -u)" -ne 0 ]; then echo "root 로 실행하세요: sudo bash $0" >&2; exit 1; fi
if [ -z "${SUDO_USER:-}" ] || [ "$SUDO_USER" = "root" ]; then echo "SUDO_USER 가 없습니다. 관리자 계정에서 sudo 로 실행하세요 (brew 는 root 로 실행할 수 없습니다)" >&2; exit 1; fi
ADMIN_HOME="$(dscl . -read "/Users/$SUDO_USER" NFSHomeDirectory | awk '{print $2}')"
log "root 확인, 관리자 $SUDO_USER ($ADMIN_HOME)"

# 2. Homebrew, tailscale, node 24
BREW=""; for c in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$c" ] && BREW="$c" && break; done
[ -n "$BREW" ] || { echo "Homebrew 가 없습니다. https://brew.sh 안내대로 $SUDO_USER 계정에서 설치한 뒤 다시 실행하세요" >&2; exit 1; }
brew_user() { sudo -u "$SUDO_USER" -H "$BREW" "$@"; }
BREW_PREFIX="$("$BREW" --prefix)"; TAILSCALE="$BREW_PREFIX/bin/tailscale"; NODE_BIN="$BREW_PREFIX/bin/node"
[ -x "$TAILSCALE" ] || { log "tailscale 설치"; brew_user install tailscale; }
node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ ! -x "$NODE_BIN" ] || [ "$(node_major "$NODE_BIN")" -lt 24 ]; then log "node 설치"; brew_user install node; fi
[ "$(node_major "$NODE_BIN")" -ge 24 ] || { echo "node 24 이상이 필요합니다: $NODE_BIN" >&2; exit 1; }
log "tailscale=$TAILSCALE node=$NODE_BIN ($("$NODE_BIN" --version))"

# 3. tailscaled 시스템 데몬 + 로그인
log "tailscale 시스템 데몬 시작"; "$BREW" services start tailscale >/dev/null 2>&1 || true
for _ in $(seq 1 20); do "$TAILSCALE" status --json >/dev/null 2>&1 && break; sleep 1; done
backend_state() { "$TAILSCALE" status --json 2>/dev/null | json_field BackendState; }
if [ "$(backend_state)" != "Running" ]; then
  if [ "$SKIP_TS_UP" = "1" ]; then log "tailscale BackendState=$(backend_state) — 건너뜀. 나중에 'sudo tailscale up' 으로 로그인하세요"
  else
    log "tailscale 로그인 필요. 아래 URL 을 브라우저에서 열어 로그인하세요"; "$TAILSCALE" up
    for _ in $(seq 1 120); do [ "$(backend_state)" = "Running" ] && break; sleep 2; done
    [ "$(backend_state)" = "Running" ] || { echo "tailscale 로그인이 완료되지 않았습니다" >&2; exit 1; }
  fi
fi
log "tailscale BackendState=$(backend_state)"

# 4. SSH: 원격 로그인 + 공개키 전용 하드닝 (관리자 잠김 방지)
AUTH_KEYS="$ADMIN_HOME/.ssh/authorized_keys"
if [ ! -s "$AUTH_KEYS" ] && [ "$SKIP_SSH" != "1" ]; then
  echo "경고: $AUTH_KEYS 가 비어 있습니다. 비밀번호 로그인을 끄면 $SUDO_USER 가 SSH 로 접속할 수 없게 됩니다. 먼저 공개키를 등록하거나 --skip-ssh-hardening 으로 실행하세요." >&2; exit 1
fi
log "SSH 원격 로그인 켜기"; systemsetup -setremotelogin on >/dev/null 2>&1 || true
if [ "$SKIP_SSH" = "1" ]; then log "SSH 하드닝 건너뜀"
else
  mkdir -p "$(dirname "$SSHD_CONF")"
  printf '%s\n' "# mac-agent-machine: 공개키 인증만 허용 (setup-server.sh)" "PasswordAuthentication no" "KbdInteractiveAuthentication no" "ChallengeResponseAuthentication no" "PermitRootLogin no" > "$SSHD_CONF"
  chmod 0644 "$SSHD_CONF"
  grep -q 'sshd_config.d' /etc/ssh/sshd_config || echo "Include /etc/ssh/sshd_config.d/*" >> /etc/ssh/sshd_config
  launchctl kickstart -k system/com.openssh.sshd || true
  log "sshd 하드닝 적용: $SSHD_CONF"
fi

# 5. 배포
log "배포: $FROM_DIR → $INSTALL_DIR"; mkdir -p "$INSTALL_DIR"
rsync -a --delete --exclude node_modules --exclude .git --exclude phases --exclude ios --exclude .worktrees --exclude apps "$FROM_DIR/" "$INSTALL_DIR/"
(cd "$INSTALL_DIR" && export PATH="$BREW_PREFIX/bin:$PATH" && npm ci --no-audit --no-fund && npm run build && npm prune --omit=dev)
[ -f "$CLI" ] || { echo "빌드 산출물이 없습니다: $CLI" >&2; exit 1; }

# 6. 디렉토리 + config
mkdir -p "$TLS_DIR" /var/log/mam /var/run/mam; chmod 0755 /var/run/mam; chown root:wheel /var/run/mam
[ -n "$HOSTNAME_OPT" ] || HOSTNAME_OPT="$("$TAILSCALE" status --json | json_field Self.DNSName)"
[ -n "$HOSTNAME_OPT" ] || { echo "MagicDNS 호스트명을 얻지 못했습니다. --hostname 으로 지정하세요" >&2; exit 1; }
log "config init (hostname=$HOSTNAME_OPT)"; "$NODE_BIN" "$CLI" config init --hostname "$HOSTNAME_OPT" --config "$CONFIG"

# 7. TLS (30일 이상 남았으면 건너뜀)
CERT="$TLS_DIR/cert.pem"; KEY="$TLS_DIR/key.pem"
if [ -f "$CERT" ] && [ -f "$KEY" ] && openssl x509 -checkend $((30*86400)) -noout -in "$CERT" >/dev/null 2>&1; then log "TLS 인증서가 30일 이상 남아 있어 건너뜀"
else log "tailscale cert $HOSTNAME_OPT"; "$TAILSCALE" cert --cert-file "$CERT" --key-file "$KEY" "$HOSTNAME_OPT"; fi
chmod 0600 "$CERT" "$KEY"

# 8. launchd
render() { sed -e "s|__NODE__|$NODE_BIN|g" -e "s|__MAM_CLI__|$CLI|g" -e "s|__TAILSCALE__|$TAILSCALE|g" -e "s|__HOSTNAME__|$HOSTNAME_OPT|g" -e "s|__RENEW_SCRIPT__|$INSTALL_DIR/scripts/renew-cert.sh|g" "$1" > "$2"; plutil -lint -s "$2"; chown root:wheel "$2"; chmod 0644 "$2"; }
chmod +x "$INSTALL_DIR/scripts/renew-cert.sh"
for label in dev.mam.gateway dev.mam.certrenew; do
  PLIST="$LAUNCHD_DIR/$label.plist"; log "launchd $label"
  render "$INSTALL_DIR/scripts/launchd/$label.plist.tmpl" "$PLIST"
  launchctl bootout "system/$label" >/dev/null 2>&1 || true
  launchctl bootstrap system "$PLIST"
done

# 9. doctor
log "doctor"; "$NODE_BIN" "$CLI" doctor --config "$CONFIG" || { echo "doctor 에 실패 항목이 있습니다" >&2; exit 1; }
log "설치 완료: https://$HOSTNAME_OPT  (사용자 추가: sudo $NODE_BIN $CLI user add <name> --email <email> --ssh-key-file <pub>)"
