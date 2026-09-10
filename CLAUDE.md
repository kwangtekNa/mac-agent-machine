# mac-agent-machine

Mac 한 대를 여러 사용자의 에이전트 코딩 서버로 만드는 프로젝트. Tailscale 사설망 안에서 SSH, iOS 앱, 웹 대시보드로 접속해 각자 macOS 계정 권한으로 Claude Code와 Codex를 돌린다.

## 문서

- `docs/PRD.md` 요구사항과 범위
- `docs/ARCHITECTURE.md` 프로세스 구조, 저장소 구조, 런타임 경로, 보안 모델
- `docs/PROTOCOL.md` REST/WS 계약과 TimelineItem 모델. iOS와 서버가 공유하는 유일한 계약
- `docs/ADR.md` 기술 결정과 근거
- `docs/IOS.md` iOS 앱 구조, 내비게이션, 디자인 시스템, 상태 흐름. `ios/` 아래 작업의 기준
- `docs/RUNBOOK.md` 설치·사용자 추가·운영

## 기술 스택

| 영역 | 선택 |
|---|---|
| 서버 | TypeScript, Node 24, ESM, npm workspaces, Fastify 5, `ws`(`@fastify/websocket`), zod 4, vitest |
| Claude | `@anthropic-ai/claude-agent-sdk` (스트리밍 입력 모드, `canUseTool`) |
| Codex | `codex app-server` 자식 프로세스, 줄 단위 JSON-RPC over stdio |
| iOS | Swift 6, SwiftUI, iOS 17+, XcodeGen(`ios/project.yml`), URLSession만 사용. SwiftPM은 `swift-markdown-ui`와 `Highlightr` 둘만 허용. 서명은 `ios/Local.xcconfig`(gitignore) |
| 웹 (Phase 2) | Vite, React, TypeScript, `@mam/protocol` 재사용 |
| 네트워크 | Tailscale(whois 신원, `tailscale cert` TLS), sshd 공개키 전용 |
| 데몬 | launchd LaunchDaemon `dev.mam.gateway`, 사용자 프로세스는 gateway가 `sudo -u`로 생성 |

## 자주 쓰는 명령

```bash
npm ci                                   # 루트에서 전체 워크스페이스 설치
npm run build --workspaces --if-present  # TS 빌드
npm test --workspaces --if-present       # TS 테스트
bash scripts/test.sh                     # 전체 게이트 (TS + iOS). MAM_TEST_SKIP_IOS=1 로 iOS 생략
npm run dev -w @mam/server -- gateway --dev   # 개발 모드 gateway (http://127.0.0.1:7777)
bash scripts/dev-smoke.sh --keep         # iOS/웹 개발용 Fake 어댑터 백엔드 (http://127.0.0.1:7777), Ctrl-C 로 종료
cd ios && xcodegen generate && xcodebuild test -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro'
```

## CRITICAL 규칙

1. **신원은 전송 계층에서만 온다.** 클라이언트가 보낸 헤더/바디의 사용자 정보를 신원으로 쓰지 마라. gateway가 whois로 확정하고 `X-MAM-User`를 덮어쓴다. agent-host는 그 값이 자기 프로세스 사용자와 같은지 확인한다.
2. **root 코드는 최소.** `src/gateway/` 밖의 코드는 root 권한을 가정하지 마라. gateway는 사용자 파일을 읽거나 에이전트를 직접 실행하지 않는다.
3. **파일 접근은 홈 안에서만.** `src/fs/sandbox.ts`의 `resolveInsideHome()`을 거치지 않은 경로로 파일시스템을 건드리지 마라. realpath 해석 후 홈 접두어를 검사한다.
4. **셸 문자열 실행 금지.** 자식 프로세스는 항상 `spawn(bin, [args])`로 띄운다. `exec`/`shell: true`/템플릿 문자열로 명령을 만들지 마라. 로그인 셸로 도구 경로를 찾는 고정 명령(`$SHELL -lc 'command -v claude'`)만 예외이며 사용자 입력이 섞이지 않는다.
5. **프로토콜 변경은 fixture부터.** `docs/PROTOCOL.md`와 `packages/protocol/fixtures/`를 먼저 고치고 zod 스키마, 서버, iOS 순으로 맞춘다. fixture 없이 이벤트 타입을 추가하지 마라.
6. **비밀값 로그 금지.** 토큰, 승인 요청 본문, 파일 내용을 로그에 남기지 마라.
7. **이벤트 seq는 SessionManager만 발급한다.** 어댑터는 seq를 만들지 않는다.
8. **Swift 파일을 추가하면 `xcodegen generate`를 다시 실행한다.** `*.xcodeproj`는 생성물이며 커밋하지 않는다. 소스 목록은 `project.yml`의 디렉토리 기반 자동 수집을 쓴다.

## 컨벤션

- TS: ESM(`"type": "module"`), `moduleResolution: NodeNext`, 상대 import에 `.js` 확장자. 파일명 kebab-case, 타입 PascalCase. 테스트는 `packages/*/test/**/*.test.ts`.
- 오류 응답은 `{ error: { code, message } }` 하나로 통일한다(`docs/PROTOCOL.md` 0절).
- Swift: Swift 6 strict concurrency, `@Observable` 모델, `async/await` URLSession. 뷰는 `Features/<기능>/` 아래, 재사용 컴포넌트는 `Shared/`.
- 커밋은 하네스 executor가 수행한다. 세션은 `git commit`을 하지 않는다.

## 하네스

- `phases/` 아래 step 파일 기준으로 `python3 scripts/execute.py <phase>`가 headless 세션을 돌린다.
- `.harness.json`의 `test_command`는 `bash scripts/test.sh`. Stop 훅이 이 게이트를 통과해야 세션이 끝난다.
- 통합 테스트(`MAM_IT_CLAUDE=1`, `MAM_IT_CODEX=1`)는 게이트에서 실행하지 않는다.
