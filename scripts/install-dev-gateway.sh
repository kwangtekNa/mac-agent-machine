#!/usr/bin/env bash
# 개발 모드 gateway 를 tailnet IPv4 에 바인딩해 로그인 시 자동 시작하는 LaunchAgent 설치 (dev.mam.dev-gateway).
#   bash scripts/install-dev-gateway.sh [--dry-run | --uninstall | --status] [--port 7777]
#
# 정식 설치(root LaunchDaemon dev.mam.gateway, docs/RUNBOOK.md 1절)와 별개다. 이 스크립트는 사용자 세션(gui/<uid>)에서
# 현재 사용자 권한으로 개발 모드 gateway 만 띄운다. 개발 모드는 접속자를 전부 현재 사용자로 취급하므로
# tailnet 에 다른 사람이 있으면 쓰지 않는다(docs/RUNBOOK.md 8절 보안 노트).
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(pwd -P)"

LABEL="dev.mam.dev-gateway"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_PATH="$HOME/.mam/dev-gateway.log"
CLI="$REPO/packages/server/dist/cli.js"
DOMAIN="gui/$(id -u)"
PORT=7777
MODE="install"

# plist 는 stdout 으로만 나간다(`--dry-run | plutil -lint -`). 안내·경고는 전부 stderr.
log() { echo "==> $*" >&2; }
warn() { echo "경고: $*" >&2; }
die() { echo "install-dev-gateway: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) MODE="dry-run"; shift ;;
    --uninstall) MODE="uninstall"; shift ;;
    --status) MODE="status"; shift ;;
    --port) [ $# -ge 2 ] || die "--port 에 포트 번호가 필요합니다"; PORT="$2"; shift 2 ;;
    -h|--help) sed -n '2,3p' "$0"; exit 0 ;;
    *) echo "알 수 없는 옵션: $1 (사용법: [--dry-run | --uninstall | --status] [--port 7777])" >&2; exit 2 ;;
  esac
done
case "$PORT" in ''|*[!0-9]*) die "포트가 숫자가 아닙니다: $PORT" ;; esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then die "포트 범위(1~65535) 밖입니다: $PORT"; fi

# ---- 도구 찾기 -------------------------------------------------------------

TAILSCALE_BIN=""
find_tailscale() {
  local c
  for c in /Applications/Tailscale.app/Contents/MacOS/Tailscale /opt/homebrew/bin/tailscale /usr/local/bin/tailscale; do
    if [ -x "$c" ]; then printf '%s\n' "$c"; return 0; fi
  done
  c="$(command -v tailscale 2>/dev/null || true)"
  if [ -n "$c" ]; then printf '%s\n' "$c"; return 0; fi
  return 0
}

# `tailscale status --json` 의 BackendState. 못 읽으면 unknown.
backend_state() {
  local state=""
  if [ -n "$TAILSCALE_BIN" ]; then
    state="$("$TAILSCALE_BIN" status --json 2>/dev/null | sed -n 's/.*"BackendState"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1 || true)"
  fi
  printf '%s\n' "${state:-unknown}"
}

# tailnet IPv4 첫 줄. Tailscale 이 꺼져 있어도 마지막으로 받은 주소가 나오는 경우가 있다.
tailnet_ip() {
  local ip=""
  if [ -n "$TAILSCALE_BIN" ]; then
    ip="$("$TAILSCALE_BIN" ip -4 2>/dev/null | head -n 1 | tr -d '[:space:]' || true)"
  fi
  case "$ip" in
    [0-9]*.[0-9]*.[0-9]*.[0-9]*) printf '%s\n' "$ip" ;;
  esac
  return 0
}

# 로그인 셸의 `command -v <name>`. name 은 이 파일 안의 리터럴(node/codex/claude)뿐이라 사용자 입력이 섞이지 않는다
# (CLAUDE.md CRITICAL 4 의 "도구 경로를 찾는 고정 명령" 예외). 5초를 넘기면 포기하고 빈 값을 준다.
shell_which() {
  local name="$1" tmp pid watcher line out=""
  tmp="$(mktemp -t mam-dev-gateway-which)"
  zsh -ic "command -v $name" >"$tmp" 2>/dev/null </dev/null &
  pid=$!
  ( sleep 5; kill -9 "$pid" ) >/dev/null 2>&1 &
  watcher=$!
  wait "$pid" >/dev/null 2>&1 || true
  kill "$watcher" >/dev/null 2>&1 || true
  wait "$watcher" >/dev/null 2>&1 || true
  # 대화형 셸 rc 가 먼저 뭔가를 출력할 수 있으므로 마지막으로 나온 실행 가능한 절대 경로를 쓴다.
  while IFS= read -r line; do
    case "$line" in /*) if [ -x "$line" ]; then out="$line"; fi ;; esac
  done <"$tmp"
  rm -f "$tmp"
  printf '%s\n' "$out"
}

NODE_BIN=""
CODEX_BIN=""
CLAUDE_BIN=""
HWP5HTML_BIN=""
PATH_VALUE=""

resolve_bins() {
  local c
  NODE_BIN="$(command -v node 2>/dev/null || true)"
  case "$NODE_BIN" in /*) ;; *) NODE_BIN="" ;; esac
  if [ -z "$NODE_BIN" ]; then NODE_BIN="$(shell_which node)"; fi
  if [ -z "$NODE_BIN" ]; then
    for c in /opt/homebrew/bin/node /usr/local/bin/node; do
      if [ -x "$c" ]; then NODE_BIN="$c"; break; fi
    done
  fi
  [ -n "$NODE_BIN" ] || die "node 를 찾지 못했습니다. node 24 이상을 설치한 뒤 다시 실행하세요"
  # LaunchAgent 는 로그인 셸을 거치지 않아 nvm 이 잡히지 않는다. 어댑터가 쓰는 CLI 경로를 plist 에 박아 둔다.
  CODEX_BIN="$(shell_which codex)"
  CLAUDE_BIN="$(shell_which claude)"
  [ -n "$CODEX_BIN" ] || warn "codex 를 찾지 못했습니다. MAM_CODEX_BIN 없이 설치합니다(Codex 세션은 못 씁니다)"
  [ -n "$CLAUDE_BIN" ] || warn "claude 를 찾지 못했습니다. MAM_CLAUDE_BIN 없이 설치합니다(Claude 세션은 못 씁니다)"
  # 한글(HWP) 변환기도 같은 이유로 경로를 박아 둔다(docs/RUNBOOK.md 9절). 없으면 그냥 빼고 설치한다(HWPX 는 변환기 없이 열린다).
  HWP5HTML_BIN="${MAM_HWP5HTML_BIN:-$(shell_which hwp5html)}"
  PATH_VALUE="$(dirname "$NODE_BIN"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
}

# ---- plist -----------------------------------------------------------------

esc() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

env_dict() {
  printf '    <key>MAM_DEV_BIND</key>\n    <string>tailscale</string>\n'
  printf '    <key>MAM_DEV_PORT</key>\n    <string>%s</string>\n' "$PORT"
  if [ -n "$CODEX_BIN" ]; then printf '    <key>MAM_CODEX_BIN</key>\n    <string>%s</string>\n' "$(esc "$CODEX_BIN")"; fi
  if [ -n "$CLAUDE_BIN" ]; then printf '    <key>MAM_CLAUDE_BIN</key>\n    <string>%s</string>\n' "$(esc "$CLAUDE_BIN")"; fi
  if [ -n "$HWP5HTML_BIN" ]; then printf '    <key>MAM_HWP5HTML_BIN</key>\n    <string>%s</string>\n' "$(esc "$HWP5HTML_BIN")"; fi
  printf '    <key>HOME</key>\n    <string>%s</string>\n' "$(esc "$HOME")"
  printf '    <key>PATH</key>\n    <string>%s</string>' "$(esc "$PATH_VALUE")"
}

# ProgramArguments 는 절대 경로 + 인자 배열이다. 셸 문자열(`sh -c ...`)을 쓰지 않는다(CLAUDE.md CRITICAL 4).
generate_plist() {
  cat <<XML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(esc "$LABEL")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(esc "$NODE_BIN")</string>
    <string>$(esc "$CLI")</string>
    <string>gateway</string>
    <string>--dev</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(esc "$REPO")</string>
  <key>EnvironmentVariables</key>
  <dict>
$(env_dict)
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>$(esc "$LOG_PATH")</string>
  <key>StandardErrorPath</key>
  <string>$(esc "$LOG_PATH")</string>
</dict>
</plist>
XML
}

# ---- 전제 확인 -------------------------------------------------------------

# $1 = 1 이면 빠진 전제에서 중단(설치), 0 이면 경고만(--dry-run/--status).
preflight() {
  local strict="$1" state
  if [ ! -f "$CLI" ]; then
    if [ "$strict" = "1" ]; then
      die "빌드 산출물이 없습니다: $CLI — 먼저 'npm run build --workspaces --if-present' 를 실행하세요"
    fi
    warn "빌드 산출물이 없습니다: $CLI (설치 전에 'npm run build --workspaces --if-present' 가 필요합니다)"
  fi
  TAILSCALE_BIN="$(find_tailscale)"
  if [ -z "$TAILSCALE_BIN" ]; then
    if [ "$strict" = "1" ]; then
      die "Tailscale 을 찾지 못했습니다. App Store 의 Tailscale 앱 또는 'brew install tailscale' 로 설치한 뒤 로그인하세요"
    fi
    warn "Tailscale 을 찾지 못했습니다(설치 시에는 필요합니다)"
    return 0
  fi
  state="$(backend_state)"
  if [ "$state" != "Running" ]; then
    warn "Tailscale 이 연결 상태가 아닙니다(BackendState=$state). 메뉴 막대 Tailscale 에서 로그인하거나 '$TAILSCALE_BIN up' 을 실행하세요. gateway 는 KeepAlive 로 10초마다 다시 시도합니다"
  fi
}

port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

wait_port_free() {
  local port="$1" secs="$2" i=0
  while [ "$i" -lt "$((secs * 2))" ]; do
    if ! port_busy "$port"; then return 0; fi
    sleep 0.5
    i=$((i + 1))
  done
  return 1
}

wait_healthz() {
  local url="$1" secs="$2" i=0
  while [ "$i" -lt "$((secs * 2))" ]; do
    if curl -sf -o /dev/null --max-time 2 "$url"; then return 0; fi
    sleep 0.5
    i=$((i + 1))
  done
  return 1
}

agent_loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

# ---- 모드별 동작 -----------------------------------------------------------

do_dry_run() {
  preflight 0
  resolve_bins
  generate_plist
  log "--dry-run: 아무것도 설치하지 않았습니다 (설치는 옵션 없이 실행). plist 자리: $PLIST"
}

do_install() {
  preflight 1
  resolve_bins
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.mam"

  if agent_loaded; then
    log "기존 $LABEL 내리기"
    launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
    wait_port_free "$PORT" 5 || true
  fi
  if port_busy "$PORT"; then
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2 || true
    die "포트 $PORT 을 이미 쓰는 프로세스가 있습니다(위 목록). 손으로 띄운 gateway 나 dev-smoke 를 먼저 끄거나 --port 로 다른 포트를 지정하세요"
  fi

  generate_plist >"$PLIST"
  plutil -lint "$PLIST" >/dev/null || die "생성한 plist 가 올바르지 않습니다: $PLIST"
  log "plist 작성: $PLIST"
  launchctl bootstrap "$DOMAIN" "$PLIST"
  launchctl kickstart -k "$DOMAIN/$LABEL"
  log "LaunchAgent 등록 완료 (로그인할 때마다 자동 시작, 로그: $LOG_PATH)"

  local ip url
  ip="$(tailnet_ip)"
  if [ -z "$ip" ]; then
    warn "tailnet IPv4 를 얻지 못했습니다. Tailscale 에 로그인하면 gateway 가 자동으로 다시 시도합니다 (상태 확인: bash scripts/install-dev-gateway.sh --status)"
    return 0
  fi
  url="http://$ip:$PORT"
  if wait_healthz "$url/healthz" 5; then
    log "gateway 응답 확인: $url/healthz"
  else
    warn "5초 안에 $url/healthz 가 응답하지 않았습니다. 로그를 확인하세요: $LOG_PATH"
  fi
  log "MacAgent 앱에 넣을 서버 주소:"
  echo "$url"
}

do_uninstall() {
  if agent_loaded; then
    log "launchctl bootout $DOMAIN/$LABEL"
    launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  else
    log "$LABEL 은(는) 로드되어 있지 않습니다"
  fi
  if [ -f "$PLIST" ]; then
    rm -f "$PLIST"
    log "삭제: $PLIST"
  else
    log "plist 가 없습니다: $PLIST"
  fi
  log "제거 완료 (로그 $LOG_PATH 는 남겨 둡니다)"
}

do_status() {
  preflight 0
  if [ -f "$PLIST" ]; then log "plist: $PLIST"; else warn "plist 가 없습니다: $PLIST (설치: 옵션 없이 실행)"; fi
  if agent_loaded; then
    launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E '^[[:space:]]*(state|pid|last exit code|program) =' | sed 's/^[[:space:]]*/  /' >&2 || true
  else
    warn "$LABEL 이 로드되어 있지 않습니다"
  fi
  log "로그: $LOG_PATH"

  local ip url
  ip="$(tailnet_ip)"
  if [ -z "$ip" ]; then
    warn "tailnet IPv4 를 얻지 못했습니다. Tailscale 로그인 상태를 확인하세요"
    return 0
  fi
  url="http://$ip:$PORT"
  if wait_healthz "$url/healthz" 2; then
    log "healthz OK — MacAgent 앱 서버 주소:"
    echo "$url"
  else
    warn "$url/healthz 가 응답하지 않습니다 (로그: $LOG_PATH)"
  fi
}

case "$MODE" in
  dry-run) do_dry_run ;;
  install) do_install ;;
  uninstall) do_uninstall ;;
  status) do_status ;;
esac
