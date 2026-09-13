# Step 0: net-ports-server

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md` (CRITICAL 4, 5, 6)
- `/docs/PROTOCOL.md` 0절, 1절(`GET /usage (2026-09-10 추가)` 등의 표기), `/docs/ARCHITECTURE.md` 6 보안 모델
- `/packages/protocol/src/rest.ts`, `index.ts`, `/packages/protocol/test/fixtures.test.ts`(`ADDED_2026_09_13`)
- `/ios/MacAgentTests/ProtocolFixturesTests.swift` (파일 수 71)
- `/packages/server/src/agent-host/routes/usage.ts` (간단한 GET 라우트 예), `app.ts`, `http.ts`
- `/packages/server/src/git/status.ts` (`runGit` 의 spawn 패턴 — 같은 방식으로 `lsof` 를 돌린다)
- `/packages/server/test/agent-host/rest.test.ts`

이전 phase 에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 배경

에이전트가 Mac 에서 띄운 개발 서버(예: `localhost:3000`)를 폰에서 열어 보고 싶다. 앱은 메시지 속 `localhost` 링크를 Mac 주소로 바꿔 열고, "미리보기" 버튼으로 **지금 열린 포트 목록** 을 보여준다. 이 step 은 그 목록을 주는 서버 API 다.

## 작업

### 1. `docs/PROTOCOL.md` 1절 — `### GET /net/ports (2026-09-13 추가)`

응답 `NetPortsResponse { ports: NetPort[] }`, `NetPort { port: int 1~65535, pid: int, process: string, address: string }`:

- 이 agent-host 를 실행하는 **사용자 소유 프로세스** 가 TCP 로 LISTEN 중인 포트만. `address` 는 바인딩 주소(`127.0.0.1`, `*`, `::1`, `0.0.0.0`).
- gateway 자신의 포트(개발 모드 7777 등)와 agent-host 유닉스 소켓은 제외한다. 같은 포트가 IPv4·IPv6 로 두 번 나오면 하나로 합친다(`address` 는 `*` 우선).
- 정렬은 포트 오름차순. `lsof` 가 없거나 실패하면 빈 배열(500 이 아니다)과 경고 로그.
- 보안 노트: 목록은 폰이 Mac 주소로 그 포트를 열어 보려는 용도이며, 서버는 프록시하지 않는다(`127.0.0.1` 에만 바인딩된 서버는 폰에서 안 열릴 수 있음을 응답 필드 `address` 로 알 수 있다).

### 2. zod + fixture

`NetPortSchema`, `NetPortsResponseSchema`(`rest.ts`), `fixtures/rest/net-ports.json`(포트 3개: `3000 node *`, `5173 node 127.0.0.1`, `8080 python3 *`), `fixtures.test.ts` 테이블 + `ADDED_2026_09_13` 에 추가, iOS 테이블에 `JSONValue` 임시 등록 + 파일 수 71 → 72(iOS step 1 이 실제 타입으로 바꾼다).

### 3. `src/net/ports.ts`

```ts
export interface ListeningPort { port: number; pid: number; process: string; address: string }
/** `lsof -nP -iTCP -sTCP:LISTEN -F pcn` 출력을 파싱한다(순수 함수, 테스트용). */
export function parseLsofListen(output: string): ListeningPort[];
/** spawn("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"]) — 현재 사용자 프로세스만 나온다(lsof 는 기본적으로 본인 것만 볼 수 있다). */
export async function listListeningPorts(opts?: { exclude?: number[]; timeoutMs?: number }): Promise<ListeningPort[]>;
```

- `-F pcn` 은 `p<pid>`, `c<command>`, `n<addr:port>` 줄을 낸다. `n` 의 `*:3000`, `127.0.0.1:5173`, `[::1]:5173` 을 파싱한다.
- 제외 포트는 라우트가 넘긴다(agent-host 가 아는 gateway 포트: 개발 모드면 `MAM_DEV_PORT`/7777; 모르면 빈 배열).
- 타임아웃 5초, 실패 시 빈 배열.

### 4. 라우트 `routes/net.ts` — `registerNetRoutes(app, host)` + `app.ts` 등록

`GET /net/ports` → `send(host, reply, NetPortsResponseSchema, { ports })`.

### 5. 테스트 (먼저 쓴다)

- `test/net/ports.test.ts`: `parseLsofListen` 표 기반(여러 pid, IPv4/IPv6 중복 합치기, `*` 우선, 정렬, 빈 출력, 깨진 줄 무시); `listListeningPorts` 는 테스트가 `node:net` 으로 임시 서버를 `127.0.0.1:0` 에 띄운 뒤 그 포트가 목록에 있는지, `exclude` 가 빠지는지(`lsof` 가 없는 환경이면 skip 처리).
- `test/agent-host/rest.test.ts` 확장: `GET /net/ports` 200, 스키마 통과, 테스트가 띄운 임시 포트 포함, 앱 자신의 포트는 제외.

## Acceptance Criteria

```bash
npm ci
npm run typecheck
npm test
test -f packages/server/src/net/ports.ts
test -f packages/protocol/fixtures/rest/net-ports.json
grep -q "GET /net/ports" docs/PROTOCOL.md
grep -q "net-ports.json" ios/MacAgentTests/ProtocolFixturesTests.swift
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - `lsof` 를 `spawn` 인자 배열로만 부르는가(CRITICAL 4)? 사용자 입력이 섞이지 않는가?
   - 다른 사용자의 프로세스가 노출되지 않는가(agent-host 는 사용자 권한으로 돈다)?
   - fixture → zod → 문서 → iOS 테이블(72)이 맞는가(CRITICAL 5)?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- 서버에서 포트를 프록시하거나 터널링하지 마라. 이유: 이 step 은 목록만 준다. 폰은 Tailscale/LAN 으로 Mac 주소에 직접 붙는다.
- `sudo`·root 권한을 쓰지 마라. 이유: 사용자 프로세스만 보여야 한다(CRITICAL 2).
- iOS 를 수정하지 마라(테이블 등록 제외).
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
