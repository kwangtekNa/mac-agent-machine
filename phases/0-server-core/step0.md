# Step 0: workspace-setup

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/ARCHITECTURE.md` (3절 저장소 구조, 8절 테스트 전략)
- `/docs/ADR.md` (ADR-005 서버 스택)
- `/.harness.json`, `/.gitignore`

## 작업

이 저장소는 비어 있다. TypeScript 모노레포의 뼈대를 만들고, 이후 step들이 `package.json`을 건드리지 않아도 되도록 런타임 의존성을 전부 미리 설치한다. 이유: 뒤의 step들이 워크트리 병렬 실행될 수 있어서 `package.json`/`package-lock.json` 충돌을 피해야 한다.

### 1. 루트

- `package.json`: `name: "mac-agent-machine"`, `private: true`, `"type": "module"`, `workspaces: ["packages/*", "apps/*"]`, `engines.node: ">=24"`. 스크립트:
  - `build`: 모든 워크스페이스 빌드 (`tsc -b` 프로젝트 레퍼런스 또는 `npm run build --workspaces --if-present`, 둘 중 하나로 통일)
  - `test`: 루트에서 한 번에 모든 패키지의 vitest 실행
  - `typecheck`: 모든 워크스페이스 `tsc --noEmit`
- `tsconfig.base.json`: `strict`, `module: NodeNext`, `moduleResolution: NodeNext`, `target: ES2022`, `declaration: true`, `sourceMap: true`, `skipLibCheck: true`, `esModuleInterop: true`. 각 패키지 `tsconfig.json`이 extends 하고 `rootDir: src`, `outDir: dist`.
- `.node-version` 파일에 `24`.
- vitest 설정: 루트 `npm test` 한 번으로 `packages/*/test/**/*.test.ts`가 전부 돌아야 한다. `@mam/server` 테스트가 `@mam/protocol`을 import할 때 **사전 빌드 없이 소스가 해석**되어야 한다(alias 또는 vitest projects + `resolve.conditions` 등 방법은 재량). 단, 프로덕션 빌드(`dist`)는 `exports`가 `dist/index.js`를 가리켜야 한다.

### 2. `packages/protocol` (`@mam/protocol`)

- `package.json`: `name: "@mam/protocol"`, `version: "0.1.0"`, `type: module`, `exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } }`, 의존성 `zod@^4`.
- `src/index.ts`: 지금은 `export const PROTOCOL_VERSION = 1 as const;` 하나만.
- `test/smoke.test.ts`: `PROTOCOL_VERSION`이 1인지 확인.
- 빈 디렉토리 `fixtures/`에 `.gitkeep`.

### 3. `packages/server` (`@mam/server`)

- `package.json`: `name: "@mam/server"`, `version: "0.1.0"`, `type: module`, `bin: { "mam": "./dist/cli.js" }`, 의존성:
  - 런타임: `@mam/protocol` (workspace, `"*"`), `fastify@^5`, `@fastify/websocket@^11`, `ws@^8`, `zod@^4`, `@anthropic-ai/claude-agent-sdk@0.3.266` (정확히 이 버전으로 고정, 이유: 이 머신의 Claude Code CLI 2.1.266과 짝), `ulid@^3`, `commander@^13`, `node-pty@^1.1`
  - 개발: `typescript@^5.9`, `tsx`, `vitest@^3`, `@types/node@^24`, `@types/ws`
  - Agent SDK의 peer 의존성(`@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `zod`)이 npm에 의해 설치되는지 `npm ls` 로 확인하라. 누락되면 명시적으로 추가한다.
- `src/index.ts`: `export const SERVER_VERSION = "0.1.0";` 와 `@mam/protocol`의 `PROTOCOL_VERSION` re-export.
- `src/cli.ts`: 지금은 `#!/usr/bin/env node` 셔뱅과 `console.log("mam " + SERVER_VERSION)` 만. 이후 step에서 채운다.
- `test/smoke.test.ts`: `@mam/protocol`에서 `PROTOCOL_VERSION`을 import해 1인지 확인 (크로스 패키지 해석 검증).

### 4. `scripts/test.sh` (이미 존재함)

`.harness.json`의 `test_command`가 이 스크립트다. 계획 단계에서 이미 만들어져 있고, `package.json`이 없으면 통과, 있으면 `npm ci`(node_modules 없을 때) → `npm run typecheck --if-present` → `npm run test --if-present` → (`ios/project.yml`이 있으면) iOS 빌드·테스트 순으로 돈다. 모든 세션 종료 시 실행되므로 이 step이 `package.json`을 만드는 순간부터 `typecheck`와 `test` 스크립트가 실제로 존재하고 통과해야 한다. 스크립트 내용은 읽고 필요한 최소 수정만 하되, `--if-present` 가드와 iOS 블록의 조건은 유지한다.

### 5. 설치와 락파일

`npm install`로 `package-lock.json`을 생성해 커밋 대상에 포함시킨다. 이후 step은 `npm ci`를 쓴다. `node_modules/`는 `.gitignore`에 이미 있다.

## Acceptance Criteria

```bash
npm ci
npm run build
npm run typecheck
npm test                          # 두 패키지의 smoke 테스트 통과
bash scripts/test.sh              # 게이트 스크립트 자체가 통과
node packages/server/dist/cli.js  # "mam 0.1.0" 출력
npm ls @anthropic-ai/claude-agent-sdk fastify node-pty >/dev/null   # 의존성 설치 확인
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - `docs/ARCHITECTURE.md` 3절의 디렉토리 구조를 따르는가?
   - `docs/ADR.md` ADR-005 기술 스택(Node 24, ESM, Fastify 5, zod 4, vitest)을 벗어나지 않았는가?
   - `CLAUDE.md` CRITICAL 규칙을 위반하지 않았는가?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- ESLint/Prettier 설정을 추가하지 마라. 이유: 이 phase의 범위 밖이며 게이트 시간을 늘린다. 타입체크가 린트를 대신한다.
- `pnpm`/`yarn`/`bun` 워크스페이스를 쓰지 마라. 이유: 이 머신에는 npm 11만 표준으로 있고 하네스 게이트가 npm을 가정한다.
- `apps/web`, `ios/` 디렉토리를 만들지 마라. 이유: 각각 Phase 2, Phase 1의 산출물이다.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
