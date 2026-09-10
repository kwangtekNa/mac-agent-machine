#!/usr/bin/env bash
# 하네스 Stop 게이트 (.harness.json test_command). 모든 세션 종료 시 실행된다.
# 아직 없는 구성 요소는 건너뛰고, 있는 것은 전부 검사한다.
set -euo pipefail
cd "$(dirname "$0")/.."

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
