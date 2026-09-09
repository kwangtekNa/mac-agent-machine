# 로그인 플로우 (PROTOCOL 1절, ADR-008)

## `claude setup-token` 관찰 기록 (2026-09-09, claude 2.1.266, node-pty 1.1.0, macOS arm64)

관찰 방법: `node-pty` 로 `claude setup-token` 을 띄우고(`cols: 200, rows: 50`, env 에서 `CLAUDECODE`·`CLAUDE_CODE_ENTRYPOINT` 제거) 10초 동안 출력을 모은 뒤 kill. 이미 `claude login` 된 계정 상태에서 실행.

1. **URL 출력**: 약 6초 뒤 `Browser didn't open? Use the url below to sign in (c to copy)` 다음 줄에 출력된다.
   형태: `https://claude.com/cai/oauth/authorize?code=true&client_id=…&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=…&code_challenge_method=S256&state=…` (약 330자).
   200열에서는 URL 이 두 줄로 **줄바꿈**된다(`user%3` / `Ainference`). 그래서 구현은 `cols: 400` 을 쓰고, `extractUrl()` 이 빈 줄 없이 이어지는 다음 줄을 이어 붙인다. URL 은 그 뒤 빈 줄(`\n\n`)이 와야 확정된 것으로 본다(pty 청크가 중간에서 끊길 수 있음).
2. **코드 입력 프롬프트**: `Paste code here if prompted >` 가 URL 바로 아래 함께 출력된다. 브라우저 인증 후 표시되는 코드를 이 프롬프트에 붙여넣고 Enter(`\r`) 한다.
3. **성공 시 토큰**: 이 관찰에서는 OAuth 를 완료하지 않아 **실측하지 못했다**. 공식 문서와 접두어 관례에 따라 `sk-ant-oat01-` 로 시작하는 URL-safe base64 문자열을 찾는다(`TOKEN_RE`). 실제 완료 화면은 RUNBOOK 의 수동 확인 절차로 검증한다. 접두어가 다르면 `TOKEN_RE` 만 고치면 된다.
4. **이미 로그인된 상태**: 그대로 동작한다(별도 경고 없이 새 OAuth 플로우를 시작).
5. **출력 형식 주의**: Ink 는 단어 사이 공백 대신 `ESC[nG`(커서 열 이동) 를 쓴다. ANSI 를 그냥 지우면 `Pastecodehere` 처럼 붙어 버리므로 `cleanTerminalOutput()` 이 `ESC[nG` 를 공백으로 바꾼 뒤 나머지 시퀀스를 제거한다. 줄 끝은 `\r\r\n`.
6. **오류 문구**: 실측하지 못했다. 코드 제출 이후 출력에서 `invalid|expired|error|failed` 단어가 포함된 줄을 오류로 본다.
7. **SDK 번들 실행파일**: `@anthropic-ai/claude-agent-sdk` 패키지에는 `cli.js`/`vendor` 가 없다(`sdk.mjs`, `manifest.json` 등만 있음). 따라서 폴백 없이 `MAM_CLAUDE_BIN` → `resolveBinary('claude')` 만 쓰고, 없으면 501 + SSH 안내.

## node-pty 주의

`node-pty@1.1.0` 의 `prebuilds/darwin-arm64/spawn-helper` 가 npm 설치 후 `0644` 라서 `pty.spawn` 이 `posix_spawnp failed` 로 실패한다. `startClaudeLogin()` 이 실행 전에 실행 비트가 없으면 `chmod 0755` 를 시도하고(권한 없으면 경고만), `scripts/setup-server.sh` 도 `npm ci` 뒤에 같은 chmod 를 한다.

## 보안

- 토큰은 `~/.mam/secrets/claude-oauth-token`(디렉토리 0700, 파일 0600)에만 쓴다. 로그에는 "URL 검출"/"토큰 저장 완료" 같은 이벤트만 남기고 출력 버퍼·코드·토큰은 남기지 않는다.
- 출력 버퍼는 64KiB 로 제한하며 토큰 검출·플로우 종료 시 즉시 비운다.
- 플로우는 에이전트당 1개, 15분 TTL(`FlowRegistry`), 전체 10분 타임아웃.
