# Step 0: xcodegen-project

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/IOS.md` (2절 기술 결정, 3절 디렉토리, 8절 테스트 전략)
- `/docs/ADR.md` (ADR-012)
- `/scripts/test.sh` (iOS 블록이 이미 있다. 이 step에서 그 블록이 실제로 동작하게 만든다)
- `/packages/protocol/fixtures/` (테스트 번들에 폴더 참조로 넣을 대상)
- `/.gitignore` (`ios/*.xcodeproj/`, `ios/Local.xcconfig`가 이미 무시 대상)

## 작업

XcodeGen으로 생성되는 iOS 프로젝트 뼈대를 만든다. 빈 앱과 테스트 타깃이 iPhone 17 Pro 시뮬레이터에서 빌드·테스트되고, 하네스 게이트(`scripts/test.sh`)의 iOS 블록이 통과하는 것이 목표다. 기능 코드는 넣지 않는다.

### 1. 도구

`xcodegen`이 없으면 `brew install xcodegen`으로 설치한다(이 머신에는 Homebrew가 `/opt/homebrew`에 있다). 버전을 summary에 적어라.

### 2. `ios/project.yml`

- `name: MacAgent`
- `options`: `bundleIdPrefix: dev.mam`, `deploymentTarget: { iOS: "17.0" }`, `xcodeVersion: "26.2"`, `createIntermediateGroups: true`, `generateEmptySchemes: false`
- `configFiles`: Debug와 Release 모두 `Local.xcconfig`
- `settings.base`: `SWIFT_VERSION: "6.0"`, `SWIFT_STRICT_CONCURRENCY: complete`, `IPHONEOS_DEPLOYMENT_TARGET: "17.0"`, `TARGETED_DEVICE_FAMILY: "1,2"`, `CODE_SIGN_STYLE: Automatic`, `ENABLE_USER_SCRIPT_SANDBOXING: "YES"`, `SWIFT_EMIT_LOC_STRINGS: "YES"`
- `packages`:
  - `MarkdownUI`: `url: https://github.com/gonzalezreal/swift-markdown-ui`, `from: "2.4.1"`
  - `Highlightr`: `url: https://github.com/raspu/Highlightr`, `from: "2.3.0"`
- `targets.MacAgent`: `type: application`, `platform: iOS`, `sources: [MacAgent]`, `dependencies`: 두 패키지의 product(`MarkdownUI`, `Highlightr`), `settings.base.PRODUCT_BUNDLE_IDENTIFIER: dev.mam.MacAgent`, `info.path: MacAgent/Info.plist`와 `info.properties`: `CFBundleDisplayName: MacAgent`, `UILaunchScreen: {}`, `UISupportedInterfaceOrientations` iPhone 세로·iPad 전체, `NSAppTransportSecurity: { NSAllowsLocalNetworking: true }`(개발 서버 `http://127.0.0.1:7777` 허용. 임의 HTTP 허용(`NSAllowsArbitraryLoads`)은 금지), `ITSAppUsesNonExemptEncryption: false`
- `targets.MacAgentTests`: `type: bundle.unit-test`, `platform: iOS`, `sources`: `MacAgentTests`와 **폴더 참조** `{ path: ../packages/protocol/fixtures, type: folder, buildPhase: resources }`(테스트 번들 안에 `fixtures/` 디렉토리로 복사된다), `dependencies: [target: MacAgent]`
- `schemes.MacAgent`: build `MacAgent: all`, `run.config: Debug`, `test`: `config: Debug`, `targets: [MacAgentTests]`, `gatherCoverageData: false`

### 3. 서명 설정

- `ios/Local.xcconfig.example`(커밋): 주석 한 줄과 `DEVELOPMENT_TEAM = ` (빈 값. 시뮬레이터 빌드는 팀 없이도 된다).
- `ios/Local.xcconfig`(gitignore, 이 머신 전용): `DEVELOPMENT_TEAM = Z2XN5A7534`. 이 값은 이 Mac의 "Apple Development" 인증서 OU(팀 ID)다. 실기기 설치 때 쓰인다.
- `scripts/test.sh`의 iOS 블록 앞에 `[ -f ios/Local.xcconfig ] || cp ios/Local.xcconfig.example ios/Local.xcconfig`를 추가해 클린 체크아웃에서도 generate가 되게 한다.

### 4. 소스 뼈대

- `ios/MacAgent/App/MacAgentApp.swift`: `@main struct MacAgentApp: App` → `RootView()`.
- `ios/MacAgent/App/RootView.swift`: `NavigationStack { ContentUnavailableView("서버에 연결", systemImage: "network", description: Text("설정에서 Mac 서버 주소를 입력하세요")) }`. step 3이 교체한다.
- `ios/MacAgent/Resources/Assets.xcassets`: `AppIcon.appiconset`(빈 iOS 단일 1024 슬롯, 이미지는 step 8), `AccentColor.colorset`(시스템 기본 파랑 그대로, 값 미지정).
- `ios/MacAgent/Resources/Localizable.xcstrings`: 빈 카탈로그(`{"sourceLanguage":"ko","strings":{},"version":"1.0"}`).
- `ios/MacAgentTests/SmokeTests.swift`: (a) `Bundle(for: Self.self).url(forResource: "fixtures", withExtension: nil)`이 존재하고 그 아래 `rest/me.json`을 읽을 수 있다, (b) `import MarkdownUI`와 `import Highlightr`가 컴파일된다(각각 타입 하나를 참조하는 사소한 assert), (c) `PROTOCOL_VERSION` 상수는 아직 없으므로 만들지 않는다.

### 5. 게이트와 문서

- `scripts/test.sh` iOS 블록을 실제로 실행해 통과시킨다. 첫 실행은 SwiftPM 해석과 시뮬레이터 부팅으로 수 분 걸릴 수 있다. `-quiet`를 유지하되 실패 시 원인이 보이도록 `xcodebuild` 종료 코드가 그대로 전파되어야 한다.
- `README.md`의 디렉토리 표 `ios/` 행과 문서 목록에 `docs/IOS.md`를 추가한다.

## Acceptance Criteria

```bash
xcodegen --version
cd ios && xcodegen generate --quiet && xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet build test && cd ..
git check-ignore -q ios/Local.xcconfig && git check-ignore -q ios/MacAgent.xcodeproj && echo "ignored OK"
grep -q "dev.mam.MacAgent" ios/project.yml && grep -q "swift-markdown-ui" ios/project.yml && grep -q "Highlightr" ios/project.yml
test -f ios/Local.xcconfig.example
bash scripts/test.sh            # TS + iOS 전체 게이트
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - `docs/IOS.md` 3절의 디렉토리 구조를 따르는가?
   - `docs/ADR.md` ADR-012의 스택(패키지 두 개만, URLSession만)을 벗어나지 않았는가?
   - `CLAUDE.md` CRITICAL 8(`xcodeproj` 미커밋, 디렉토리 기반 소스 수집)을 지켰는가?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- `*.xcodeproj`, `Package.resolved` 외의 생성물을 커밋 대상에 남기지 마라. `Package.resolved`(`ios/MacAgent.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`)는 xcodeproj 안에 있어 어차피 무시된다. 버전 고정은 `project.yml`의 `from:`으로 충분하다.
- `NSAllowsArbitraryLoads`를 켜지 마라. 이유: 프로덕션은 HTTPS(tailscale cert)다. 로컬 개발만 `NSAllowsLocalNetworking`으로 연다.
- MarkdownUI·Highlightr 외의 SwiftPM 패키지를 추가하지 마라(ADR-012).
- 기능 화면·모델 코드를 미리 만들지 마라. 이유: step 1 이후의 범위다.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
