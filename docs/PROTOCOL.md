# PROTOCOL: agent-host ↔ 클라이언트 계약 (v1)

이 문서는 iOS 앱, 웹 대시보드, 서버가 공유하는 유일한 계약이다. TS 쪽 단일 진실은 `packages/protocol/src/index.ts`의 zod 스키마이고, 예시 JSON은 `packages/protocol/fixtures/`에 있다. Swift는 이 문서와 fixture를 보고 Codable을 손으로 작성하며, fixture 디코딩 테스트로 어긋남을 잡는다.

## 0. 공통

- 기본 경로: `/api/v1`. 모든 요청/응답은 JSON(UTF-8).
- 인증: 클라이언트는 아무것도 보내지 않는다. gateway가 신원을 확정해 `X-MAM-User`를 붙인다. 개발 모드에서는 `MAM_DEV_USER`가 신원이다.
- 헤더: 클라이언트는 `X-MAM-Protocol: 1`을 보낸다. 서버는 지원하지 않는 버전이면 426.
- 오류: `{ "error": { "code": "not_found" | "forbidden" | "invalid_request" | "conflict" | "agent_unavailable" | "internal", "message": "..." } }`와 대응 HTTP 상태.
- ID: `ses_<ulid>`, `itm_<ulid>`, `apr_<ulid>`, `trn_<ulid>`, `flw_<ulid>`. 팀·방(2026-09-12 추가): `team_`, `agt_`(팀원), `room_`, `msg_`, `chg_`(ChangeSet), `tpl_`(템플릿), `dsp_`(디스패치).
- 시각: ISO-8601 UTC 문자열. 경로: 절대 경로. 클라이언트가 `~/`로 시작하는 경로를 보내면 서버가 홈으로 치환한다.
- 알 수 없는 키: 클라이언트는 모르는 키를 거부하지 않고 무시한다(서버가 필드를 추가해도 구 클라이언트가 깨지지 않는다). 단 판별자(`kind`, `type`)가 모르는 값이면 실패한다.
- `null`: 값이 없을 수 있는 필드는 키를 생략하지 않고 `null`을 보낸다. 해당 필드: `Session.model|nativeId|preview`, `agents[].version|account`, `projects[].lastSessionAt`, `fs/list.parent`(홈 루트), `entries[].size|gitStatus`, `git/status.branch`, `TimelineItem.turnId`(턴 밖 아이템, 예: `system`)`|completedAt`, `tool_call.exitCode`, `Approval.detail|diff`. `?`가 붙은 필드는 키 자체가 생략될 수 있다.

## 1. REST

### `GET /me`

```json
{
  "user": "alice",
  "email": "alice@example.com",
  "home": "/Users/alice",
  "workspaceRoot": "/Users/alice/work",
  "agents": [
    { "kind": "claude", "available": true, "version": "2.1.266", "loggedIn": true, "account": "alice@example.com" },
    { "kind": "codex",  "available": true, "version": "0.153.4", "loggedIn": false, "account": null }
  ],
  "server": { "version": "0.1.0", "protocolVersion": 1 }
}
```

### `GET /projects`

워크스페이스 루트 바로 아래 디렉토리와 세션이 있었던 cwd를 합쳐 준다.

```json
{ "projects": [ { "path": "/Users/alice/work/app", "name": "app", "isGitRepo": true, "lastSessionAt": "2026-09-09T10:00:00Z", "sessionCount": 3 } ] }
```

### `GET /sessions?cwd=<path>&status=<status>`

```json
{ "sessions": [ <Session>, ... ] }
```

Session:

```json
{
  "id": "ses_01J8...",
  "agent": "claude",
  "cwd": "/Users/alice/work/app",
  "title": "로그인 버그 수정",
  "mode": "ask",
  "model": "claude-opus-5",
  "effort": "high",
  "status": "idle",
  "nativeId": "7f3c...",
  "createdAt": "2026-09-09T10:00:00Z",
  "updatedAt": "2026-09-09T10:12:00Z",
  "lastSeq": 42,
  "pendingApprovals": 0,
  "preview": "테스트가 통과했습니다.",
  "usage": {
    "inputTokens": 12000,
    "outputTokens": 3400,
    "cacheReadTokens": 90000,
    "cacheWriteTokens": 5000,
    "costUsd": 0.42,
    "turns": 3,
    "context": { "tokens": 42000, "window": 200000, "percent": 21 },
    "updatedAt": "2026-09-09T10:12:00Z"
  }
}
```

- `status`: `starting | idle | running | waiting_approval | error | closed`
- `mode`: `ask | auto-edit | full-auto | plan` (매핑은 4절)
- `model`, `effort`: 어댑터가 보고한 현재 값. 모르면 `null`. `effort`는 `low | medium | high | xhigh | max`(Claude) 또는 Codex의 reasoning effort 문자열.
- `usage`(2026-09-10 추가): 이 세션의 **누적** 토큰과 비용, 현재 컨텍스트 사용량. 첫 턴 전에는 `null`. `costUsd`는 어댑터가 추정값을 주지 않으면 `null`(Codex 구독 계정). `context`는 마지막 턴 기준 컨텍스트 크기(`tokens`)와 모델 컨텍스트 창(`window`), 백분율(`percent`, 정수 0~100). 모르면 `null`. 어댑터별 산출식은 5절.
- `team`(2026-09-12 추가): 팀원 세션이면 `{ "teamId": "team_…", "memberId": "agt_…" }`. 일반 세션은 **키 자체를 생략**한다(`null`을 보내지 않는다). 팀원 세션도 `GET /sessions/:id`, WS, 승인 응답은 일반 세션과 똑같이 쓴다. 6절.

### `POST /sessions`

요청 `{ "agent": "claude" | "codex", "cwd": "...", "title"?: "...", "mode"?: "ask", "model"?: "...", "resumeNativeId"?: "..." }` → 201 + Session. `cwd`는 홈 아래 존재하는 디렉토리여야 한다(400/403).

### `GET /sessions/:id`

`{ "session": <Session>, "items": [ <TimelineItem>, ... ], "truncated": false }` 최근 200개 아이템.

### `PATCH /sessions/:id`

`{ "title"?: "...", "mode"?: "...", "model"?: "...", "effort"?: "..." }` → Session. `model`/`effort`는 `GET /models`가 준 값이어야 하며(400), 적용 시점은 어댑터가 정한다(Claude: 모델은 즉시, effort는 다음 턴에 프로세스를 `resume`으로 재시작해 적용. Codex: 둘 다 다음 `turn/start`).

### `POST /sessions/:id/close`

에이전트 프로세스를 닫고 `status: "closed"`. 이벤트 로그는 남는다. → Session.

### `POST /sessions/:id/approvals/:approvalId`

WS 없이도 응답할 수 있는 REST 경로. 본문은 WS `approval.respond`와 동일. → `{ "ok": true }` 또는 409(이미 처리됨).

### `GET /fs/list?path=<dir>`

```json
{
  "path": "/Users/alice/work/app",
  "parent": "/Users/alice/work",
  "isGitRepo": true,
  "entries": [
    { "name": "src", "path": "/Users/alice/work/app/src", "type": "dir", "size": null, "mtime": "...", "isHidden": false, "gitStatus": null },
    { "name": "index.ts", "path": ".../index.ts", "type": "file", "size": 1240, "mtime": "...", "isHidden": false, "gitStatus": "M" }
  ]
}
```

- `type`: `file | dir | symlink | other`. 정렬은 디렉토리 먼저, 이름순. `node_modules`, `.git` 내부는 목록에서 제외하지 않지만 `gitStatus`는 `git status --porcelain`이 준 값만 채운다(`M`, `A`, `D`, `R`, `?`, `!`, `null`).
- 홈 밖이면 403, 없으면 404.

### `GET /fs/read?path=<file>`

```json
{ "path": "...", "size": 1240, "mtime": "...", "isBinary": false, "encoding": "utf8", "content": "...", "truncated": false, "language": "typescript" }
```

- 텍스트는 1 MiB까지 반환하고 넘으면 `truncated: true`로 앞부분만. 바이너리는 이미지(`png|jpg|jpeg|gif|webp|heic|svg`) 5 MiB까지 `encoding: "base64"`, 그 외 바이너리는 415.
- `language`는 확장자 기반 소문자 식별자(`typescript`, `swift`, `python`, `markdown`, `json`, `shell`, `plaintext` 등).

### `GET /git/status?cwd=<dir>`

```json
{ "isRepo": true, "branch": "main", "ahead": 0, "behind": 2, "entries": [ { "path": "src/index.ts", "index": " ", "worktree": "M" } ] }
```

### `GET /git/diff?cwd=<dir>&path=<file>&staged=false`

`{ "patch": "diff --git a/... " }` unified diff. `path` 생략 시 전체.

### `POST /git/init` (2026-09-13 추가)

폰에서 고른 디렉토리가 git 저장소가 아닐 때(`POST /teams` 가 400 을 돌려줄 때) 그 자리에서 초기화한다. 요청 `{ "cwd": "/Users/alice/work/new-app", "dryRun"?: false }`(`~/` 허용). 초기화 = (없을 때만) 기본 `.gitignore` 생성 → `git init -b main` → `git add -A` → `git commit -m "Initial commit"`. 기존 파일은 전부 첫 커밋에 담긴다(팀원 worktree 가 베이스 브랜치를 체크아웃하므로, 6.5). 커밋할 파일이 없어도 `--allow-empty` 로 첫 커밋을 만든다. 기본 브랜치는 사용자의 git 전역 설정과 무관하게 항상 `main`. `dryRun: true` 면 아무것도 바꾸지 않고 커밋될 파일 수·바이트를 실제 git 으로 정확히 계산해 돌려준다.

```json
{ "initialized": true, "branch": "main", "commit": "9f1c2b3a4d5e6f708192a3b4c5d6e7f8091a2b3c", "files": 12, "bytes": 48213, "createdGitignore": true }
```

| 필드 | 타입 | 설명 |
|---|---|---|
| `initialized` | boolean | 실제로 초기화했으면 true, `dryRun` 이면 false |
| `branch` | string | 항상 `main` |
| `commit` | string \| null | 첫 커밋 sha(40자). `dryRun` 이면 null |
| `files` | int ≥ 0 | 첫 커밋에 담기는(담길) 기존 파일 수. 서버가 만든 `.gitignore` 는 세지 않는다(`dryRun` 과 실제 값이 같다) |
| `bytes` | int ≥ 0 | 그 파일들의 합계 크기 |
| `createdGitignore` | boolean | 기본 `.gitignore` 를 만들었(만들)는지. 이미 있으면 건드리지 않고 false |

- 상태 코드: 초기화 201, `dryRun` 200.
- 오류: 홈 밖 403 `forbidden`; 디렉토리가 아니거나 없음 400 `invalid_request`; 이미 저장소이거나 상위 디렉토리에 저장소가 있음 409 `conflict`(메시지에 어느 경로가 저장소인지. 중첩 저장소는 팀 worktree·머지를 깨뜨리므로 허용하지 않는다).
- 커밋 작성자: 사용자의 `user.name`/`user.email` 이 비어 있으면 그 커밋에만 `MacAgent <mam@mam.local>` 을 쓴다(전역 설정은 바꾸지 않는다). 기본 `.gitignore` 내용은 RUNBOOK "팀 운영" 절.

### `POST /fs/mkdir` (2026-09-10 추가)

요청 `{ "path": "/Users/alice/work/new-app" }` 또는 `~/work/new-app`. 홈 아래여야 하고(403) 부모 디렉토리는 함께 만든다. 이미 있으면 409 `conflict`. 이름에 제어 문자가 있거나 빈 세그먼트면 400. → 201 `{ "entry": <FsEntry> }`.

### `GET /usage` (2026-09-10 추가)

에이전트별 구독 사용 한도. Codex는 호출 시점에 조회(`live: true`), Claude는 세션 실행 중 관측된 마지막 값(`live: false`, `observedAt`이 관측 시각).

```json
{
  "agents": [
    {
      "kind": "claude", "plan": "max", "live": false, "observedAt": "2026-09-10T03:40:00Z",
      "limits": [
        { "id": "five_hour", "label": "5시간", "usedPercent": 42, "windowMinutes": 300, "resetsAt": "2026-09-10T06:00:00Z", "status": "ok" },
        { "id": "seven_day", "label": "주간", "usedPercent": 81, "windowMinutes": 10080, "resetsAt": "2026-09-14T00:00:00Z", "status": "warning" }
      ]
    },
    {
      "kind": "codex", "plan": "plus", "live": true, "observedAt": "2026-09-10T04:10:00Z",
      "limits": [
        { "id": "primary", "label": "5시간", "usedPercent": 12, "windowMinutes": 300, "resetsAt": "...", "status": "ok" },
        { "id": "secondary", "label": "주간", "usedPercent": 35, "windowMinutes": 10080, "resetsAt": "...", "status": "ok" }
      ]
    }
  ]
}
```

- `status`: `usedPercent < 80` → `ok`, `80 이상` → `warning`, `100 이상` 또는 어댑터가 거부 상태를 보고하면 `exceeded`.
- 관측값이 전혀 없으면 `limits: []`, `observedAt: null`. `plan`은 모르면 `null`. `windowMinutes`, `resetsAt`은 모르면 `null`.

### `GET /models?agent=claude|codex` (2026-09-10 추가)

```json
{ "models": [ { "id": "claude-opus-5", "displayName": "Opus 5", "description": "가장 뛰어난 모델", "isDefault": true, "efforts": ["low", "medium", "high", "xhigh", "max"], "defaultEffort": "high" } ] }
```

`efforts`가 빈 배열이면 그 모델은 effort 조절을 지원하지 않는다. `description`, `defaultEffort`는 모르면 `null`.

### `GET /net/ports` (2026-09-13 추가)

이 agent-host 를 실행하는 **사용자 소유 프로세스**가 TCP 로 LISTEN 중인 포트 목록. 앱이 "미리보기"에서 Mac 주소로 열어 볼 포트를 고르는 데 쓴다.

```json
{
  "ports": [
    { "port": 3000, "pid": 4821, "process": "node", "address": "*" },
    { "port": 5173, "pid": 4899, "process": "node", "address": "127.0.0.1" },
    { "port": 8080, "pid": 5120, "process": "python3", "address": "*" }
  ]
}
```

| 필드 | 타입 | 설명 |
|---|---|---|
| `port` | int 1~65535 | LISTEN 중인 TCP 포트 |
| `pid` | int | 그 포트를 연 프로세스 ID |
| `process` | string | 프로세스 이름(`lsof` 의 command) |
| `address` | string | 바인딩 주소. `*`(모든 인터페이스), `0.0.0.0`, `127.0.0.1`, `::1` 등 |

- 목록은 `lsof -nP -iTCP -sTCP:LISTEN` 을 그 사용자 권한으로 돌려 얻는다. `lsof` 는 자기 프로세스만 보여 주므로 다른 사용자의 포트는 들어오지 않는다.
- gateway 자신의 포트(개발 모드 기본 7777, `MAM_DEV_PORT`)와 agent-host 의 유닉스 소켓은 제외한다(유닉스 소켓은 애초에 TCP 목록에 없다).
- 같은 포트가 IPv4·IPv6 로 두 번 나오면 한 항목으로 합치고 `address` 는 `*` 를 우선한다. 정렬은 `port` 오름차순.
- `lsof` 가 없거나 실패·타임아웃(5초)이면 500 이 아니라 `{ "ports": [] }` 를 주고 서버가 경고 로그를 남긴다.
- 보안: 이 목록은 폰이 **Mac 주소로 그 포트를 직접 열어 보려는** 용도이며 서버는 프록시하거나 터널링하지 않는다. `address` 가 `127.0.0.1`/`::1` 인 서버는 loopback 에만 바인딩돼 있어 폰에서 열리지 않을 수 있고, 앱은 그 사실을 `address` 로 구분한다.

### 로그인 플로우

- `POST /auth/:agent/login` → `{ "flowId": "flw_...", "url": "https://...", "instructions": "브라우저에서 열고 코드를 붙여넣으세요", "needsCode": true }`
- `POST /auth/:agent/login/:flowId/code` 본문 `{ "code": "..." }` → `{ "ok": true }`
- `GET /auth/:agent/login/:flowId` → `{ "status": "pending" | "done" | "error", "message": "..." }`
- 어댑터별 구현은 ADR-008 참고. 지원하지 않는 에이전트는 501과 SSH 안내 메시지를 준다.

## 2. WebSocket

`GET /api/v1/sessions/:id/ws?since=<seq>` → 101.

모든 서버 이벤트의 공통 필드: `{ "type": "...", "seq": 43, "sessionId": "ses_...", "ts": "..." }`. `seq`는 세션 내 단조 증가. `session.snapshot`과 `pong`은 `seq: 0`.

### 서버 → 클라이언트

| type | 추가 필드 | 설명 |
|---|---|---|
| `session.snapshot` | `session`, `items[]`, `pendingApprovals[]`, `replayFrom`, `truncated` | 접속 직후 1회. `since`보다 뒤의 아이템을 담는다. 버퍼를 넘어섰으면 `truncated: true`와 최근 200개 |
| `item.started` | `item` | 새 TimelineItem (status `running` 또는 `completed`) |
| `item.delta` | `itemId`, `field`: `text | output | patch`, `delta` | 스트리밍 텍스트 조각. 클라이언트는 해당 필드에 append |
| `item.completed` | `item` | 최종 아이템 전체. 델타로 만든 내용을 이것으로 대체한다 |
| `approval.requested` | `approval` | 승인 요청. 세션 상태는 `waiting_approval` |
| `approval.resolved` | `approvalId`, `optionId`, `by`: `client | timeout | system` | 승인 처리 완료 |
| `session.status` | `status`, `mode`, `reason`? | 상태 변화 |
| `session.usage` | `usage` (Session.usage 와 같은 객체) | 누적 사용량·컨텍스트 갱신(2026-09-10 추가). 턴 종료 시, Codex는 턴 중에도 |
| `turn.completed` | `turnId`, `durationMs`, `usage`: `{ inputTokens, outputTokens, cacheReadTokens? }`, `costUsd`?, `stopReason` | 턴 종료 |
| `error` | `message`, `recoverable` | 세션 오류 |
| `pong` | | ping 응답 |

### 클라이언트 → 서버

| type | 필드 | 설명 |
|---|---|---|
| `turn.start` | `text`, `attachments`?: `[{ "kind": "image", "mediaType": "image/png", "base64": "..." }]` | 사용자 메시지 전송. `running` 중이면 큐에 넣지 않고 409 성격의 `error`를 돌려준다 |
| `turn.interrupt` | | 현재 턴 중단 |
| `approval.respond` | `approvalId`, `optionId`, `inputs`?: `{ [fieldId]: string }`, `message`?: `string` | 승인 응답. `message`는 거절 사유로 에이전트에 전달 |
| `session.setMode` | `mode` | 모드 변경 |
| `ping` | | |

## 3. TimelineItem

```json
{ "id": "itm_...", "seq": 12, "turnId": "trn_...", "kind": "tool_call", "status": "running", "createdAt": "...", "completedAt": null, "payload": { ... } }
```

- `status`: `running | completed | failed | cancelled`
- `kind`와 `payload`:

| kind | payload |
|---|---|
| `user_message` | `{ "text": "...", "attachments": [...] }` |
| `assistant_message` | `{ "text": "...", "phase": "commentary" | "final" }` 마크다운 |
| `reasoning` | `{ "text": "..." }` 사고 요약. 기본 접힘 |
| `tool_call` | `{ "tool": "bash" | "read" | "write" | "edit" | "glob" | "grep" | "web" | "mcp" | "task" | "other", "name": "Bash", "title": "npm test", "input": { ... }, "output": "...", "exitCode": 0, "truncated": false }` |
| `file_change` | `{ "files": [ { "path": "src/a.ts", "kind": "add" | "modify" | "delete" | "rename", "additions": 10, "deletions": 2 } ], "patch": "diff --git ..." }` |
| `plan` | `{ "steps": [ { "text": "...", "status": "pending" | "in_progress" | "completed" } ] }` |
| `approval` | `<Approval>` (아래) + `"resolution"?: { "optionId": "...", "by": "...", "at": "..." }` |
| `turn_summary` | `{ "durationMs": 1234, "usage": {...}, "costUsd"?: 0.12, "stopReason": "end_turn" }` |
| `error` | `{ "message": "...", "recoverable": true }` |
| `system` | `{ "text": "컨텍스트가 압축되었습니다" }` |

Approval:

```json
{
  "approvalId": "apr_...",
  "itemId": "itm_...",
  "kind": "command" | "file_change" | "permission" | "user_input" | "other",
  "title": "npm test 실행",
  "prompt": "Claude wants to run: npm test",
  "detail": "cwd: /Users/alice/work/app\n$ npm test",
  "diff": null,
  "options": [
    { "id": "allow", "label": "허용", "style": "primary" },
    { "id": "allow_session", "label": "이 세션에서 항상 허용", "style": "secondary" },
    { "id": "deny", "label": "거절", "style": "destructive" }
  ],
  "inputFields": [],
  "requestedAt": "..."
}
```

- `options[].id`는 어댑터가 정한다. 공통 값: `allow`, `allow_session`, `deny`, `abort`. `user_input`은 `inputFields: [{ "id", "label", "type": "text" | "secret" | "choice", "choices"? }]`와 `options: [{ "id": "submit" }, { "id": "cancel" }]`.
- `file_change`는 `diff`에 unified diff를 담는다.

## 4. 모드 매핑

| mode | Claude `permissionMode` | Codex `approvalPolicy` / `sandbox` |
|---|---|---|
| `ask` | `default` | `untrusted` / `workspace-write` |
| `auto-edit` | `acceptEdits` | `on-request` / `workspace-write` |
| `full-auto` | `bypassPermissions` | `never` / `danger-full-access` |
| `plan` | `plan` | `on-request` / `read-only` |

Codex의 `approvalPolicy`는 v2 `AskForApproval`(`untrusted | on-request | never | granular`), `sandbox`는 `SandboxMode`(`read-only | workspace-write | danger-full-access`)다. `thread/start`와 `turn/start` 양쪽에 같은 값을 넣는다.

Claude 어댑터는 `permissionMode`와 무관하게 SDK 옵션 `allowDangerouslySkipPermissions: true`로 프로세스를 띄운다. SDK가 `bypassPermissions`(와 런타임 `setPermissionMode("bypassPermissions")`)에 이 플래그를 요구하기 때문이며, 플래그는 bypass를 **허용**만 하고 켜지는 않는다. 실제 bypass 여부는 세션 `mode`가 정한다.

`full-auto`는 앱에서 별도 확인 후에만 설정할 수 있고, 설정되면 **모든 도구를 승인 없이 실행한다**(어댑터가 승인 요청을 만들지 않는다. Codex의 사용자 입력 요청(`user_input`)만 예외로 그대로 올라온다). 2026-09-13 실제 어댑터로 확인, ADR-015.

## 5. 어댑터 매핑 요약

Claude Agent SDK → TimelineItem:

- `assistant` 메시지의 `text` 블록 → `assistant_message` (partial 메시지 `stream_event`의 `content_block_delta` → `item.delta`)
- `thinking` 블록 → `reasoning`
- `tool_use` 블록 → `tool_call` (Bash → `bash`, Read → `read`, Write → `write`, Edit/MultiEdit → `edit`, Glob → `glob`, Grep → `grep`, WebFetch/WebSearch → `web`, `mcp__*` → `mcp`, Task/Agent → `task`, 그 외 → `other`). 대응 `user` 메시지의 `tool_result` → 같은 아이템의 `output`, `status`
- Edit/Write/MultiEdit 완료 시 → 추가로 `file_change` 아이템(패치는 `tool_use.input`의 old/new 문자열로 생성)
- `canUseTool` → `approval` (kind: Bash → `command`, Edit/Write → `file_change`, 나머지 → `permission`). `options`: `allow`, `allow_session`(suggestions가 있을 때만), `deny`
- `result` → `turn_summary` + `turn.completed`
- `system/init` → `session.status` (`idle`), `compact_boundary` → `system`
- 사용량(2026-09-10 추가): `result.usage`(이번 턴의 메인 루프)에서 토큰 델타 = `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`. 비용 델타 = `result.total_cost_usd`(프로세스 누적)에서 직전 값을 뺀 것. 컨텍스트 `tokens` = 이번 턴의 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`, `window` = `result.modelUsage[*].contextWindow` 중 최댓값. 구독 한도는 `rate_limit_event`(`rate_limit_info.rateLimitType`(`five_hour | seven_day | …`), `utilization`, `resetsAt`, `status`)를 관측해 사용자별로 저장한다. 모델 목록은 `Query.supportedModels()`(`value`, `displayName`, `description`, `supportedEffortLevels`). 모델 변경은 `Query.setModel()`, effort는 `Options.effort`로 프로세스 재시작(`resume`) 시 적용
- `system/init.model` → `Session.model`

Codex app-server → TimelineItem:

- `item/started`, `item/completed`의 item 타입: `agentMessage` → `assistant_message`, `reasoning` → `reasoning`, `commandExecution` → `tool_call(bash)`, `fileChange` → `file_change`, `mcpToolCall` → `tool_call(mcp)`, `webSearch` → `tool_call(web)`, `plan` → `plan`, `userMessage` → `user_message`
- `item/agentMessage/delta`, `item/commandExecution/outputDelta`, `item/reasoning/*Delta`, `item/fileChange/patchUpdated` → `item.delta`
- `item/commandExecution/requestApproval` → `approval(command)`, `item/fileChange/requestApproval` → `approval(file_change)`, `item/permissions/requestApproval` → `approval(permission)`, `item/tool/requestUserInput` → `approval(user_input)`. 응답은 v2 타입을 따른다. 명령/파일 변경은 `{ decision }`이며 `allow` → `accept`, `allow_session` → `acceptForSession`, `deny` → `decline`, `abort` → `cancel`. 권한 요청은 `{ permissions, scope }`(허용 시 요청된 프로필 그대로, `scope`는 `allow` → 턴, `allow_session` → 세션), 사용자 입력은 `{ answers: { [questionId]: { answers: [...] } } }`
- `account/login/start { type: "chatgptDeviceCode" }` → `{ loginId, verificationUrl, userCode }`, 완료는 `account/login/completed` 알림. 로그인 플로우(1절)의 Codex 구현은 이것을 쓴다
- `turn/completed` → `turn_summary` + `turn.completed`, `thread/tokenUsage/updated` → usage 누적
- `turn/started` → `session.status(running)`, `error` 알림 → `error`
- 사용량(2026-09-10 추가): `thread/tokenUsage/updated { tokenUsage: { total, last, modelContextWindow } }`. 토큰 델타는 `total`의 이전 관측치 대비 증가분(`inputTokens`, `outputTokens`, `cachedInputTokens`, `cacheWriteInputTokens`), 컨텍스트 `tokens` = `last.totalTokens`, `window` = `modelContextWindow`. 비용은 `null`(구독). 구독 한도는 `account/rateLimits/read` → `rateLimits.primary/secondary { usedPercent, windowDurationMins, resetsAt(epoch 초) }`와 `account/rateLimits/updated` 알림. `plan`은 `account/read`의 `account.planType`. 모델 목록은 `model/list`(`hidden` 제외; `id`, `displayName`, `description`, `isDefault`, `supportedReasoningEfforts[].reasoningEffort`, `defaultReasoningEffort`). 모델·effort 변경은 다음 `turn/start`의 `model`, `effort`
- `thread/start` 응답의 모델 → `Session.model`

## 6. 팀과 방 (2026-09-12 추가)

사용자는 한 프로젝트(git 저장소 `cwd`)에 **에이전트 팀**을 꾸린다. 팀원은 이름·이모지·역할·에이전트 종류·모드를 가진 **기존 `Session` 하나**이며 자기 git worktree 에서 일한다. 대화는 **방**에서 한다: 그룹방 하나(`#전체`)와 팀원별 DM 방. 사용자가 방에 글을 쓰면 서버가 `@멘션`으로 팀원을 골라 그 세션에 턴을 보내고, 턴이 끝나면 답변을 방에 게시한다(스트리밍 없음). 턴 종료 시 서버가 worktree 변경을 커밋하고 "변경 준비됨" 카드를 올리며, 사용자가 방에서 머지를 승인한다. 팀은 프로젝트(`cwd`)에 속하고 템플릿은 사용자별로 저장된다. 근거는 ADR-017.

방 이벤트는 세션 WS 와 **별도 스트림**이다(`room-ws/`·`room-client/` fixture). 세션 `ServerEvent`/`ClientMessage` 에 방 이벤트를 넣지 않는다.

### 6.1 모델

TS 는 `packages/protocol/src/teams.ts`, `room-ws.ts`. 예시는 `fixtures/rest/team*.json`, `room*.json`, `changes.json`, `merge-result.json`.

**RolePreset** (`GET /team-roles`)

| 필드 | 타입 | 설명 |
|---|---|---|
| `id` | `developer \| planner \| team-lead \| code-reviewer \| custom` | RoleId |
| `label` | string | 한국어 표시명(`개발자`, `기획자`, `팀장`, `코드 리뷰어`, `커스텀`) |
| `emoji` | string | 기본 이모지 |
| `prompt` | string | 기본 역할 지시문. `MemberInput.prompt` 를 생략하면 복사된다. `custom` 은 `""` |

**TeamMember**

| 필드 | 타입 | 설명 |
|---|---|---|
| `id` | `agt_<ulid>` | |
| `name` | string 1~40 | 표시 이름. 정규화(공백 제거·소문자·NFKC)한 값이 팀 안에서 유일해야 한다 |
| `handle` | `^[a-z0-9][a-z0-9-]{0,31}$` | `@멘션`·브랜치·커밋 작성자에 쓰는 ASCII 핸들. 팀 안에서 유일 |
| `role` | RoleId | |
| `roleLabel` | string | 표시용 역할명. 프리셋 label 또는 `custom` 의 사용자 입력 |
| `emoji` | string | |
| `agent` | `claude \| codex` | |
| `prompt` | string | 역할 지시문(프리셋 또는 사용자 입력). 서버가 팀 컨텍스트 지시를 덧붙여 세션 system prompt 로 쓴다 |
| `mode` | SessionMode | 기본 `auto-edit` |
| `model`, `effort` | string \| null | `PATCH /sessions/:id` 와 같은 의미. 모르면 `null` |
| `sessionId` | `ses_<ulid>` \| null | 팀원의 세션. 첫 디스패치 전·`reset` 직후는 `null` |
| `branch` | string | `mam/<team-slug>/<handle>` (6.5) |
| `worktreePath` | string | `~/.mam/teams/<teamId>/worktrees/<memberId>` 의 절대 경로 |
| `isLead` | boolean | 팀장. 팀에 정확히 1명 |
| `state` | `idle \| queued \| running \| waiting_approval \| error` | 디스패처가 관리하는 상태 |
| `createdAt`, `updatedAt` | ISO-8601 | |

**TeamSettings**: `{ "maxHops": 6, "maxConcurrent": 2, "contextMaxMessages": 40 }`. `maxHops` 정수 0~50(기본 6), `maxConcurrent` 1~8(기본 2), `contextMaxMessages` 1~500(기본 40, 12,000자 상한과 함께 적용. 6.4).

**Team**

| 필드 | 타입 | 설명 |
|---|---|---|
| `id` | `team_<ulid>` | |
| `name` | string 1~60 | |
| `cwd` | string | 프로젝트 저장소 루트(절대 경로, 홈 안) |
| `baseBranch` | string | 팀 생성 시점 `cwd` 의 현재 브랜치. 머지 대상 |
| `settings` | TeamSettings | |
| `members` | TeamMember[] | |
| `rooms` | Room[] | 그룹방 1 + 팀원별 DM 방 |
| `createdAt`, `updatedAt` | ISO-8601 | |

**Room**

| 필드 | 타입 | 설명 |
|---|---|---|
| `id` | `room_<ulid>` | |
| `teamId` | `team_<ulid>` | |
| `kind` | `group \| dm` | |
| `memberId` | `agt_<ulid>` \| null | DM 상대. 그룹방은 `null` |
| `name` | string | 그룹방 `전체`, DM 은 팀원 이름 |
| `lastSeq` | int ≥ 0 | 방 이벤트 로그의 마지막 seq(6.3) |
| `lastMessageAt` | ISO-8601 \| null | 메시지가 없으면 `null` |

**RoomAuthor**: `{ "kind": "user" }` \| `{ "kind": "agent", "memberId": "agt_…" }` \| `{ "kind": "system" }`. 모르는 `kind` 는 실패(0절).

**WorkSummary** (에이전트 답변에 붙는 턴 요약)

| 필드 | 타입 | 설명 |
|---|---|---|
| `sessionId`, `turnId` | `ses_`, `trn_` | 답변을 만든 턴 |
| `toolCalls` | int ≥ 0 | 턴 안의 `tool_call` 아이템 수 |
| `filesChanged` | string[] | worktree 기준 상대 경로 |
| `durationMs` | int ≥ 0 | |
| `usage` | Usage | `turn.completed` 와 같은 객체 |
| `costUsd`? | number | 어댑터가 주지 않으면 키 생략(Codex) |

**RoomMessage**

| 필드 | 타입 | 설명 |
|---|---|---|
| `id` | `msg_<ulid>` | |
| `roomId` | `room_<ulid>` | |
| `seq` | int ≥ 1 | 이 메시지를 게시한 `room.message` 이벤트의 seq. 갱신돼도 바뀌지 않는다 |
| `author` | RoomAuthor | |
| `kind` | `text \| approval \| changes \| system` | |
| `text` | string | `text` 는 본문(마크다운). `approval` 은 승인 제목, `changes` 는 한 줄 요약, `system` 은 안내문 |
| `mentions` | `agt_<ulid>[]` | 본문에서 해석된 멘션(6.4). `@all` 은 펼쳐서 넣는다 |
| `hop` | int ≥ 0 | 연쇄 깊이. 사용자 0, 그 멘션으로 실행된 턴의 결과 1, 그 결과의 멘션으로 실행된 턴 2 … |
| `dispatchId` | `dsp_<ulid>` \| null | 이 메시지를 만든 디스패치. 사용자·시스템 메시지는 `null` |
| `createdAt` | ISO-8601 | |
| `work` | WorkSummary \| null | `kind: "text"` 이고 작성자가 에이전트일 때만 값. 그 외 `null` |
| `approval` | `{ memberId, sessionId, approval: Approval, resolution: ApprovalResolution \| null }` \| null | `kind: "approval"` 일 때만 값. 3절 `Approval` 을 그대로 미러링. 응답 전 `resolution: null` |
| `changes` | ChangeSet \| null | `kind: "changes"` 일 때만 값 |

**ChangeSet**

| 필드 | 타입 | 설명 |
|---|---|---|
| `id` | `chg_<ulid>` | |
| `teamId`, `memberId`, `sessionId`, `turnId` | | 변경을 만든 팀원과 턴 |
| `branch`, `baseBranch` | string | 팀원 브랜치와 머지 대상 |
| `commit` | string | 팀원 브랜치 HEAD(40자 hex) |
| `files` | FileChangeEntry[] | 3절 `file_change.files[]` 와 같은 모양(`path`, `kind`, `additions`, `deletions`) |
| `commits` | int ≥ 1 | `baseBranch` 대비 앞선 커밋 수 |
| `status` | `ready \| merging \| merged \| conflict \| dismissed \| stale` | `stale` 은 같은 팀원의 더 새로운 ChangeSet 이 생겨 대체된 것 |
| `conflictFiles` | string[] | `conflict` 일 때 충돌 파일. 그 외 `[]` |
| `messageId` | `msg_<ulid>` | 이 ChangeSet 을 담은 방 메시지(그룹방, `kind: "changes"`) |
| `createdAt`, `updatedAt` | ISO-8601 | |

**MergeResult**: `{ "change": ChangeSet, "mergeCommit": string | null }`. `merged` 면 `--no-ff` 머지 커밋, `conflict` 면 `null`.

**DispatchState** (팀 전체)

```json
{
  "running": [ { "dispatchId": "dsp_…", "memberId": "agt_…", "roomId": "room_…", "sessionId": "ses_…", "turnId": "trn_…", "hop": 1 } ],
  "queued":  [ { "dispatchId": "dsp_…", "memberId": "agt_…", "roomId": "room_…", "hop": 1, "enqueuedAt": "…" } ]
}
```

`running[].turnId` 는 어댑터가 턴 ID 를 보고하기 전 `null`.

**TeamTemplate**: `{ "id": "tpl_<ulid>", "name": string 1~60, "settings": TeamSettings, "members": TeamTemplateMember[], "createdAt", "updatedAt" }`. `TeamTemplateMember` 는 `TeamMember` 에서 런타임 필드를 뺀 `{ name, handle, role, roleLabel, emoji, agent, prompt, mode, model, effort, isLead }`.

### 6.2 REST

`MemberInput`: `{ "name", "role", "roleLabel"?, "agent", "emoji"?, "prompt"?, "mode"? (기본 auto-edit), "model"?, "effort"?, "handle"?, "isLead"? }`. `roleLabel`·`emoji`·`prompt` 를 생략하면 프리셋 값을 복사한다(`custom` 은 `roleLabel` 필수 → 400). `handle` 을 생략하면 이름에서 만든다(로마자·숫자만 남기고, 없으면 `agent-<n>`). 정규화한 이름 또는 handle 이 팀 안에서 겹치면 409 `conflict`.

| 메서드/경로 | 요청 → 응답 |
|---|---|
| `GET /team-roles` | → `{ roles: RolePreset[] }` |
| `GET /teams?cwd=` | → `{ teams: Team[] }` (cwd 생략 시 전체) |
| `POST /teams` | `{ cwd, name, members: MemberInput[], settings?, templateId? }` → 201 `Team` |
| `GET /teams/:id` | → `{ team, dispatch: DispatchState, changes: ChangeSet[] }` |
| `PATCH /teams/:id` | `{ name?, settings? }` → `Team` |
| `DELETE /teams/:id?keepWorktrees=true` | → `{ ok: true }` |
| `POST /teams/:id/members` | `MemberInput` → 201 `Team` |
| `PATCH /teams/:id/members/:memberId` | `{ name?, emoji?, prompt?, mode?, model?, effort? }` → `Team` |
| `DELETE /teams/:id/members/:memberId?keepWorktree=true` | → `Team` |
| `POST /teams/:id/members/:memberId/reset` | → `Team` (기억 초기화: 새 세션, 같은 worktree) |
| `POST /teams/:id/stop` | → `DispatchState` |
| `GET /teams/:id/rooms/:roomId?limit=` | → `{ room, messages: RoomMessage[], truncated }` (기본 최근 200) |
| `POST /teams/:id/rooms/:roomId/messages` | `{ text, attachments? }` → 201 `{ message: RoomMessage, dispatches: string[] }` |
| `GET /teams/:id/changes` | → `{ changes: ChangeSet[] }` |
| `POST /teams/:id/changes/:changeId/merge` | → `MergeResult` |
| `POST /teams/:id/changes/:changeId/dismiss` | → `ChangeSet` |
| `GET /team-templates` · `POST /team-templates` · `PATCH /team-templates/:id` · `DELETE /team-templates/:id` | `{ templates: TeamTemplate[] }` / `TeamTemplate` / `TeamTemplate` / `{ ok: true }` |

- `POST /teams`: `cwd` 가 홈 밖이면 403, git 저장소가 아니거나 detached HEAD 면 400 `invalid_request`. `isLead` 가 0명 또는 2명 이상이면 400 `invalid_request`(1명이면 그대로, `members` 가 1명이고 `isLead` 생략이면 그 사람이 팀장). `settings` 는 부분 지정 가능하며 빠진 값은 기본값. `templateId` 를 주면 템플릿의 `settings`·`members` 를 기본으로 깔고 본문이 덮어쓴다. 생성 시 팀원마다 브랜치·worktree 를 만들고(6.5) 그룹방과 DM 방을 만든다. 세션은 첫 디스패치 때 만든다(`sessionId: null`).
- `PATCH /teams/:id/members/:memberId`: `name`·`emoji`·`mode`·`effort` 는 즉시 적용(`mode`·`effort` 는 세션 `PATCH` 와 같은 규칙). **`prompt`·`model` 은 `appliesAt: "next_session"`** — Claude Agent SDK 가 system prompt 를 세션 시작 시 고정하므로 `reset` 하거나 세션이 다시 열릴 때부터 적용된다. 응답 `Team` 에는 새 값이 바로 보인다. 이름을 바꿔도 `handle`·브랜치는 바뀌지 않는다. 이름이 겹치면 409.
- `DELETE /teams/:id`, `DELETE /teams/:id/members/:memberId`: 실행 중 턴을 중단하고 세션을 닫는다. worktree 에 커밋되지 않은 변경이 있으면 409 `conflict`(`keepWorktrees=true`/`keepWorktree=true` 면 worktree 와 브랜치를 남기고 등록만 해제). 방 로그는 팀 삭제 시 함께 지운다.
- `POST /teams/:id/members/:memberId/reset`: 세션을 닫고 `sessionId: null`, `state: idle`. 다음 디스패치가 새 세션을 만든다. worktree 와 브랜치는 그대로.
- `POST /teams/:id/stop`: 실행 중 턴 전부 `interrupt`, 대기열 비움. → 비워진 `DispatchState`.
- `POST /teams/:id/rooms/:roomId/messages`: 6.4 규칙으로 디스패치를 만든다. `dispatches` 는 만들어진 디스패치 ID(실행·대기 포함). `attachments` 는 디스패치되는 턴에만 전달되고 RoomMessage 에는 남지 않는다. 방이 없으면 404.
- `POST /teams/:id/changes/:changeId/merge`: `status` 가 `ready` 가 아니면 409 `conflict`. 성공 시 `merged` + `mergeCommit`, 충돌 시 200 과 `status: "conflict"`, `conflictFiles`, `mergeCommit: null`(머지는 되돌린다). 6.5.
- `POST /teams/:id/changes/:changeId/dismiss`: `ready`·`conflict` → `dismissed`. 브랜치는 남는다. 그 외 상태면 409.
- 템플릿: `POST /team-templates` 본문 `{ name, settings?, members: TeamTemplateMember[] }`, `PATCH` 는 같은 필드 전부 선택. 팀장 규칙(정확히 1명)은 템플릿에도 적용(400).

### 6.3 방 WebSocket

`GET /api/v1/teams/:teamId/rooms/:roomId/ws?since=<seq>` → 101. 방이 없으면 close code **4004**. 세션 WS 와 같은 규칙: 접속 직후 `room.snapshot`(seq 0) → `since` 이후 이벤트 재생 → 라이브. `ping`/`pong`.

모든 서버 이벤트의 공통 필드: `{ "type": "...", "seq": 7, "roomId": "room_…", "teamId": "team_…", "ts": "..." }`. `seq` 는 **방 내** 단조 증가(세션 seq 와 별개, ADR-017). `room.message`, `room.message.updated`, `room.status`, `room.error` 가 seq 를 소비한다. `room.snapshot` 과 `pong` 은 `seq: 0`.

서버 → 클라이언트:

| type | 추가 필드 | 설명 |
|---|---|---|
| `room.snapshot` | `room`, `messages[]`, `pendingApprovals[]`, `dispatch`, `members[]`, `replayFrom`, `truncated` | 접속 직후 1회. `messages` 는 `since` 뒤의 메시지(갱신 반영된 현재 상태). `pendingApprovals` 는 이 방에 미러링된 승인 중 `resolution: null` 인 것(`RoomMessage.approval` 과 같은 객체). `members[]` 는 `{ memberId, state, sessionId }`. 버퍼를 넘었으면 `truncated: true` 와 최근 200개 |
| `room.message` | `message` | 새 RoomMessage(사용자·에이전트·시스템·승인 카드·변경 카드) |
| `room.message.updated` | `message` | 기존 메시지 갱신(승인 `resolution`, ChangeSet `status`). 이벤트는 새 seq, `message.seq` 는 원래 값. 클라이언트는 `message.id` 로 교체 |
| `room.status` | `dispatch`, `members[]` | 디스패치·팀원 상태 변화(턴 시작/종료, 대기열 변화, 승인 대기) |
| `room.error` | `message`, `recoverable` | 방 수준 오류(멘션 대상 없음, 세션 시작 실패, 홉 상한 등) |
| `pong` | | ping 응답 |

클라이언트 → 서버:

| type | 필드 | 설명 |
|---|---|---|
| `room.send` | `text`, `attachments`? | `POST .../messages` 와 같은 본문·규칙. 결과는 `room.message` 로 온다 |
| `room.interrupt` | `memberId`? | 그 팀원의 실행 중 턴 중단. 생략하면 팀 전체(`POST /teams/:id/stop`) |
| `ping` | | |

승인 응답은 방 WS 로 보내지 않는다. 카드의 `approval.sessionId`·`approval.approvalId` 로 **기존** `POST /sessions/:id/approvals/:approvalId` 를 호출한다(세션 WS `approval.respond` 도 가능). 처리되면 `room.message.updated` 로 `resolution` 이 채워진다.

### 6.4 디스패치 규칙

- **멘션 문법**: 본문의 `@<handle>` 또는 `@<이름>`(정규화 비교, 뒤에 공백·문장부호·끝). `@all` 은 작성자를 제외한 전원. 모르는 대상은 무시하고 `room.error`(recoverable) 로 알린다. 해석 결과가 `mentions` 다.
- **그룹방 라우팅**: 멘션된 팀원 각각에게 디스패치 1건. 멘션이 없으면 팀장(`isLead`) 1건. 에이전트 답변의 멘션도 같은 규칙으로 디스패치한다(에이전트 간 호출). 자기 자신 멘션은 무시.
- **DM 방**: 그 팀원에게만 디스패치하고, 본문의 다른 멘션은 **무시**한다(`mentions` 에도 넣지 않는다). DM 에서 에이전트 답변의 멘션도 디스패치하지 않는다.
- **홉**: 사용자 메시지 `hop: 0`. 디스패치의 hop = 원인 메시지의 hop + 1 이고 답변 메시지가 그 hop 을 갖는다. `hop > settings.maxHops` 가 되는 멘션은 디스패치하지 않고 시스템 메시지(`"홉 상한(6)에 도달해 @민수 호출을 건너뛰었습니다"`)를 올린다. 새 사용자 메시지는 연쇄를 0 부터 다시 시작한다.
- **동시 실행**: 팀 전체 `running` 은 `settings.maxConcurrent` 이하. 넘치면 `queued`(FIFO). 팀원은 세션이 하나라 **같은 팀원에게 온 디스패치는 그 팀원의 턴이 끝날 때까지 대기**한다(상한과 무관). 팀원 `state` 는 `idle → queued → running → (waiting_approval ⇄ running) → idle`, 실패 시 `error`.
- **턴 입력**: 팀원 세션에 보내는 턴 텍스트는 (1) 방 맥락, (2) 이번 메시지 순이다. 맥락은 그 방의 최근 메시지를 `contextMaxMessages`(기본 40)개, 합쳐서 12,000자 이내로 잘라(오래된 것부터 버림) 한 줄씩 접두어를 붙인다: 사용자 `[#전체] 사용자: …` / `[DM] 사용자: …`, 에이전트 `[#전체] @민수(개발자): …`(`@handle(roleLabel)`), 시스템 `[#전체] 시스템: …`. 승인·변경 카드는 `text` 한 줄로 넣는다. 팀원이 이미 본 메시지(자기 세션에 전달된 것)는 다시 넣지 않는다.
- **답변 게시**: 턴이 끝나면 그 턴의 마지막 `assistant_message`(`phase: final`, 없으면 마지막 `assistant_message`)의 텍스트를 `kind: "text"` 메시지로 디스패치가 시작된 방에 게시하고 `work` 를 채운다. 스트리밍은 없다. 턴이 `error` 로 끝나면 시스템 메시지로 알리고 팀원 `state: error`.
- **승인 미러링**: 팀원 세션의 `approval.requested` 는 디스패치가 시작된 방에 `kind: "approval"` 메시지로 미러링하고 `approval.resolved` 때 `room.message.updated`. 응답은 6.3 대로 기존 세션 API.

### 6.5 worktree·커밋·머지

- 팀 생성·팀원 추가 시 `git worktree add -b mam/<team-slug>/<handle> ~/.mam/teams/<teamId>/worktrees/<memberId> <baseBranch>`. `<team-slug>` 는 팀 이름을 `[a-z0-9-]` 로 정규화한 값(영숫자가 없으면 `team-<id 끝 8자>`). 브랜치가 이미 있으면 재사용한다. worktree 는 저장소 밖·홈 안에 둔다(ADR-017).
- 팀원 세션의 `cwd` 는 그 worktree 다. 세션의 `git/status`·`fs` API 도 worktree 경로로 쓴다.
- **턴 종료 시 서버가 커밋**한다: worktree 에 변경(추적·비추적 포함, `.gitignore` 준수)이 있으면 `git add -A && git commit` 을 작성자 `<이름> (mam-team) <handle@mam.local>`, 메시지 첫 줄 `<이름>: <원인 메시지 앞 72자>` 로 만든다. 그 다음 `ChangeSet`(`status: ready`) 을 만들고 그룹방에 `kind: "changes"` 카드를 올린다. 같은 팀원의 이전 `ready` ChangeSet 은 `stale` 로 바꾸고 `room.message.updated`. 변경이 없으면 카드를 올리지 않는다.
- **머지**는 `POST /teams/:id/changes/:changeId/merge`. 서버가 `cwd`(원본 저장소)에서 `git merge --no-ff <branch>` 를 실행한다. `cwd` 의 현재 브랜치가 `baseBranch` 가 아니거나 작업 트리가 더러우면 409. 충돌이면 `git merge --abort` 후 `status: conflict`, `conflictFiles`. 성공하면 `merged`, `mergeCommit`. **브랜치는 유지**하고 팀원은 같은 브랜치에서 계속 일한다(다음 턴 전에 서버가 `baseBranch` 를 팀원 브랜치에 머지해 최신화한다. 충돌 시 시스템 메시지로 알리고 사용자가 정리한다).
- 팀·팀원 삭제 시 `git worktree remove` 와 브랜치 삭제. `keepWorktree(s)=true` 면 둘 다 남긴다. 커밋되지 않은 변경이 있으면 409.
