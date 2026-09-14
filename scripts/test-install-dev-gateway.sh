#!/usr/bin/env bash
# scripts/install-dev-gateway.sh 의 --dry-run 경로 단위 검사 (scripts/test.sh 게이트에서 돌린다).
# 실제 설치(launchctl bootstrap/kickstart)는 7777 을 점유하므로 테스트하지 않는다.
set -euo pipefail
cd "$(dirname "$0")/.."

SCRIPT="scripts/install-dev-gateway.sh"
fails=0
ok() { echo "  ok  $*"; }
bad() { echo "  FAIL  $*" >&2; fails=$((fails + 1)); }

contains() { # contains <haystack> <needle> <설명>
  if printf '%s' "$1" | grep -qF -- "$2"; then ok "$3"; else bad "$3 — '$2' 가 출력에 없습니다"; fi
}
excludes() { # excludes <haystack> <needle> <설명>
  if printf '%s' "$1" | grep -qF -- "$2"; then bad "$3 — '$2' 가 출력에 있습니다"; else ok "$3"; fi
}

echo "test-install-dev-gateway: $SCRIPT --dry-run"

# 1. stdout 은 plist 하나뿐이고 plutil 을 통과한다(안내·경고는 stderr 로만 나가야 한다).
out="$(bash "$SCRIPT" --dry-run 2>/dev/null)"
if printf '%s\n' "$out" | plutil -lint - >/dev/null 2>&1; then ok "stdout 이 유효한 plist"; else bad "stdout 이 plutil -lint 를 통과하지 못했습니다"; fi

# 2. 개발 모드 gateway 를 tailnet 에만 바인딩해 띄우는 plist 인가.
contains "$out" "<string>dev.mam.dev-gateway</string>" "Label dev.mam.dev-gateway"
contains "$out" "MAM_DEV_BIND" "EnvironmentVariables 에 MAM_DEV_BIND"
contains "$out" "<string>tailscale</string>" "MAM_DEV_BIND=tailscale"
contains "$out" "<string>gateway</string>" "ProgramArguments 에 gateway"
contains "$out" "<string>--dev</string>" "ProgramArguments 에 --dev"
contains "$out" "packages/server/dist/cli.js" "ProgramArguments 에 cli.js 절대 경로"
excludes "$out" "0.0.0.0" "0.0.0.0 바인딩 없음"
# CRITICAL 4: 셸 문자열로 명령을 만들지 않는다.
excludes "$out" "<string>/bin/sh</string>" "sh 로 감싸지 않음"
excludes "$out" "<string>-c</string>" "-c 셸 문자열 없음"

# 3. --port 가 MAM_DEV_PORT 에 반영된다.
out_port="$(bash "$SCRIPT" --dry-run --port 8123 2>/dev/null)"
contains "$out_port" "<string>8123</string>" "--port 8123 → MAM_DEV_PORT"

# 4. --dry-run 은 launchctl 을 부르지 않는다(설치는 사용자가 한다).
trace="$(mktemp -t mam-dev-gateway-trace)"
bash -x "$SCRIPT" --dry-run >/dev/null 2>"$trace" || true
if grep -Eq '^\++ launchctl' "$trace"; then bad "--dry-run 이 launchctl 을 실행했습니다"; else ok "--dry-run 이 launchctl 을 실행하지 않음"; fi
rm -f "$trace"

# 5. 알 수 없는 옵션은 exit 2.
code=0
bash "$SCRIPT" --nope >/dev/null 2>&1 || code=$?
if [ "$code" -eq 2 ]; then ok "알 수 없는 옵션 → exit 2"; else bad "알 수 없는 옵션의 exit code 가 $code 입니다(기대 2)"; fi

if [ "$fails" -ne 0 ]; then
  echo "test-install-dev-gateway: 실패 $fails 건" >&2
  exit 1
fi
echo "test-install-dev-gateway: OK"
