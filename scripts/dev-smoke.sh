#!/usr/bin/env bash
# 개발 모드 gateway + Fake 어댑터로 REST → WS → 승인 응답 → 완료까지 검증한다 (docs/ARCHITECTURE.md 8절).
#
#   bash scripts/dev-smoke.sh            # 빌드 → 서버 기동 → 검증 → 종료
#   bash scripts/dev-smoke.sh --keep     # 검증 후 서버를 유지 (Ctrl-C 로 종료). iOS/웹 개발용
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${MAM_DEV_PORT:-7777}"
KEEP=0
if [ "${1:-}" = "--keep" ]; then
  KEEP=1
fi

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "dev-smoke: 포트 $PORT 이 이미 사용 중입니다 (MAM_DEV_PORT 로 다른 포트를 지정하세요)" >&2
  exit 1
fi

GATEWAY_PID=""
GATEWAY_LOG="$(mktemp -t mam-dev-smoke-gateway.XXXXXX)"
CHILD_PIDFILE="$(mktemp -t mam-dev-smoke-children.XXXXXX)"

cleanup() {
  local status=$?
  # gateway 가 살아있는 동안에만 자기 자식(agent-host)의 pid 를 알 수 있다 — 죽은 뒤에는 고아가 되어 -P 로 못 찾는다.
  if [ -n "$GATEWAY_PID" ]; then
    pgrep -P "$GATEWAY_PID" -f "agent-host --socket" >"$CHILD_PIDFILE" 2>/dev/null || true
  fi
  if [ -n "$GATEWAY_PID" ] && kill -0 "$GATEWAY_PID" 2>/dev/null; then
    kill -TERM "$GATEWAY_PID" 2>/dev/null || true
    waited=0
    while kill -0 "$GATEWAY_PID" 2>/dev/null && [ "$waited" -lt 3 ]; do
      sleep 1
      waited=$((waited + 1))
    done
    if kill -0 "$GATEWAY_PID" 2>/dev/null; then
      kill -KILL "$GATEWAY_PID" 2>/dev/null || true
    fi
  fi
  if [ -s "$CHILD_PIDFILE" ]; then
    while read -r pid; do
      [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && kill -TERM "$pid" 2>/dev/null || true
    done <"$CHILD_PIDFILE"
    sleep 1
    while read -r pid; do
      [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
    done <"$CHILD_PIDFILE"
  fi
  rm -f "$CHILD_PIDFILE"
  if [ "$status" -ne 0 ]; then
    echo "==> gateway 로그 ($GATEWAY_LOG)" >&2
    tail -n 40 "$GATEWAY_LOG" >&2 2>/dev/null || true
  fi
  rm -f "$GATEWAY_LOG"
  exit "$status"
}
trap cleanup EXIT INT TERM

echo "==> npm run build"
npm run build

echo "==> gateway 기동 (dev, MAM_FAKE_AGENT=1, port $PORT)"
MAM_FAKE_AGENT=1 MAM_DEV_PORT="$PORT" node packages/server/dist/cli.js gateway --dev >"$GATEWAY_LOG" 2>&1 &
GATEWAY_PID=$!

echo "==> /healthz 대기 (최대 15초)"
ready=0
for _ in $(seq 1 30); do
  if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
    echo "dev-smoke: gateway 프로세스가 조기 종료됨" >&2
    exit 1
  fi
  if curl -sf -o /dev/null "http://127.0.0.1:$PORT/healthz"; then
    ready=1
    break
  fi
  sleep 0.5
done
if [ "$ready" -ne 1 ]; then
  echo "dev-smoke: /healthz 가 15초 안에 200을 주지 않음" >&2
  exit 1
fi

echo "==> scripts/dev-smoke.mjs"
MAM_DEV_PORT="$PORT" node scripts/dev-smoke.mjs

if [ "$KEEP" -eq 1 ]; then
  echo "==> --keep: gateway 를 유지합니다 (http://127.0.0.1:$PORT). Ctrl-C 로 종료하세요."
  wait "$GATEWAY_PID"
fi
