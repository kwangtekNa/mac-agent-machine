#!/usr/bin/env bash
# 하네스 Stop 게이트 (.harness.json test_command). 모든 세션 종료 시 실행된다.
# 아직 없는 구성 요소는 건너뛰고, 있는 것은 전부 검사한다.
set -euo pipefail
cd "$(dirname "$0")/.."

# 동시 실행 방지: 하네스 step 세션의 게이트와 대화형 세션의 Stop 훅이 동시에 돌면
# xcodegen/xcodebuild 가 같은 ios/MacAgent.xcodeproj 와 DerivedData 를 놓고 충돌한다.
# 먼저 잡은 쪽이 끝날 때까지(최대 480초) 기다린 뒤 실행한다. 죽은 프로세스의 잠금은 회수한다.
LOCK_DIR="/tmp/mam-test-gate.lock"
release_lock() { rm -f "$LOCK_DIR/pid" 2>/dev/null; rmdir "$LOCK_DIR" 2>/dev/null; }
waited=0
while ! mkdir "$LOCK_DIR" 2>/dev/null; do
  holder=$(cat "$LOCK_DIR/pid" 2>/dev/null || echo "")
  if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
    release_lock; continue
  fi
  if [ "$waited" -ge 480 ]; then
    echo "test.sh: 다른 게이트(pid ${holder:-?})가 480초 넘게 잠금을 잡고 있어 그대로 진행합니다" >&2
    release_lock; continue
  fi
  [ "$waited" -eq 0 ] && echo "test.sh: 다른 게이트(pid ${holder:-?}) 종료 대기 중…"
  sleep 2; waited=$((waited+2))
done
echo "$$" > "$LOCK_DIR/pid"
trap release_lock EXIT

if [ ! -f package.json ]; then
  echo "test.sh: package.json 이 아직 없음 — 검사할 대상 없음"
  exit 0
fi

if [ ! -d node_modules ]; then
  echo "==> npm ci"
  npm ci
fi

echo "==> typecheck"
npm run typecheck --if-present

echo "==> unit tests"
npm run test --if-present

echo "==> install-dev-gateway.sh (--dry-run 단위 검사)"
bash scripts/test-install-dev-gateway.sh

if [ -f ios/project.yml ] && [ "${MAM_TEST_SKIP_IOS:-0}" != "1" ]; then
  echo "==> iOS build + test"
  # 클린 체크아웃에도 서명 xcconfig 가 있어야 generate 가 된다(팀 ID 비어 있어도 시뮬레이터 빌드는 가능).
  [ -f ios/Local.xcconfig ] || cp ios/Local.xcconfig.example ios/Local.xcconfig
  # xcodebuild 가 갓 부팅된 시뮬레이터에 앱을 설치하려다 "Application failed preflight checks (Busy)" 로
  # 실패하는 경합을 피하려고 부팅 완료를 먼저 기다린다(-b: 꺼져 있으면 부팅). 실패해도 xcodebuild 가 다시 시도한다.
  xcrun simctl bootstatus 'iPhone 17 Pro' -b >/dev/null 2>&1 || true
  # -quiet 는 유지하되 xcodebuild 종료 코드는 그대로 전파된다(set -e + 서브셸).
  (cd ios && xcodegen generate --quiet && xcodebuild test -scheme MacAgent \
     -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet)
fi

echo "test.sh: OK"
