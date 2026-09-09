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
  (cd ios && xcodegen generate --quiet && xcodebuild test -scheme MacAgent \
     -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet)
fi

echo "test.sh: OK"
