# PROTOCOL: agent-host ↔ 클라이언트 계약 (v1)

이 문서는 iOS 앱, 웹 대시보드, 서버가 공유하는 유일한 계약이다. TS 쪽 단일 진실은 `packages/protocol/src/index.ts`의 zod 스키마이고, 예시 JSON은 `packages/protocol/fixtures/`에 있다. Swift는 이 문서와 fixture를 보고 Codable을 손으로 작성하며, fixture 디코딩 테스트로 어긋남을 잡는다.

## 0. 공통

- 기본 경로: `/api/v1`. 모든 요청/응답은 JSON(UTF-8).
- 인증: 클라이언트는 아무것도 보내지 않는다. gateway가 신원을 확정해 `X-MAM-User`를 붙인다. 개발 모드에서는 `MAM_DEV_USER`가 신원이다.
- 헤더: 클라이언트는 `X-MAM-Protocol: 1`을 보낸다. 서버는 지원하지 않는 버전이면 426.
- 오류: `{ "error": { "code": "not_found" | "forbidden" | "invalid_request" | "conflict" | "agent_unavailable" | "internal", "message": "..." } }`와 대응 HTTP 상태.
- ID: `ses_<ulid>`, `itm_<ulid>`, `apr_<ulid>`, `trn_<ulid>`, `flw_<ulid>`.
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
  "model": null,
  "status": "idle",
  "nativeId": "7f3c...",
  "createdAt": "2026-09-09T10:00:00Z",
  "updatedAt": "2026-09-09T10:12:00Z",
  "lastSeq": 42,
  "pendingApprovals": 0,
  "preview": "테스트가 통과했습니다."
}
```

- `status`: `starting | idle | running | waiting_approval | error | closed`
- `mode`: `ask | auto-edit | full-auto | plan` (매핑은 4절)

### `POST /sessions`

요청 `{ "agent": "claude" | "codex", "cwd": "...", "title"?: "...", "mode"?: "ask", "model"?: "...", "resumeNativeId"?: "..." }` → 201 + Session. `cwd`는 홈 아래 존재하는 디렉토리여야 한다(400/403).

### `GET /sessions/:id`

`{ "session": <Session>, "items": [ <TimelineItem>, ... ], "truncated": false }` 최근 200개 아이템.

### `PATCH /sessions/:id`

`{ "title"?: "...", "mode"?: "..." }` → Session.

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

`full-auto`는 앱에서 별도 확인 후에만 설정할 수 있다.

## 5. 어댑터 매핑 요약

Claude Agent SDK → TimelineItem:

- `assistant` 메시지의 `text` 블록 → `assistant_message` (partial 메시지 `stream_event`의 `content_block_delta` → `item.delta`)
- `thinking` 블록 → `reasoning`
- `tool_use` 블록 → `tool_call` (Bash → `bash`, Read → `read`, Write → `write`, Edit/MultiEdit → `edit`, Glob → `glob`, Grep → `grep`, WebFetch/WebSearch → `web`, `mcp__*` → `mcp`, Task/Agent → `task`, 그 외 → `other`). 대응 `user` 메시지의 `tool_result` → 같은 아이템의 `output`, `status`
- Edit/Write/MultiEdit 완료 시 → 추가로 `file_change` 아이템(패치는 `tool_use.input`의 old/new 문자열로 생성)
- `canUseTool` → `approval` (kind: Bash → `command`, Edit/Write → `file_change`, 나머지 → `permission`). `options`: `allow`, `allow_session`(suggestions가 있을 때만), `deny`
- `result` → `turn_summary` + `turn.completed`
- `system/init` → `session.status` (`idle`), `compact_boundary` → `system`

Codex app-server → TimelineItem:

- `item/started`, `item/completed`의 item 타입: `agentMessage` → `assistant_message`, `reasoning` → `reasoning`, `commandExecution` → `tool_call(bash)`, `fileChange` → `file_change`, `mcpToolCall` → `tool_call(mcp)`, `webSearch` → `tool_call(web)`, `plan` → `plan`, `userMessage` → `user_message`
- `item/agentMessage/delta`, `item/commandExecution/outputDelta`, `item/reasoning/*Delta`, `item/fileChange/patchUpdated` → `item.delta`
- `item/commandExecution/requestApproval` → `approval(command)`, `item/fileChange/requestApproval` → `approval(file_change)`, `item/permissions/requestApproval` → `approval(permission)`, `item/tool/requestUserInput` → `approval(user_input)`. 응답은 v2 타입을 따른다. 명령/파일 변경은 `{ decision }`이며 `allow` → `accept`, `allow_session` → `acceptForSession`, `deny` → `decline`, `abort` → `cancel`. 권한 요청은 `{ permissions, scope }`(허용 시 요청된 프로필 그대로, `scope`는 `allow` → 턴, `allow_session` → 세션), 사용자 입력은 `{ answers: { [questionId]: { answers: [...] } } }`
- `account/login/start { type: "chatgptDeviceCode" }` → `{ loginId, verificationUrl, userCode }`, 완료는 `account/login/completed` 알림. 로그인 플로우(1절)의 Codex 구현은 이것을 쓴다
- `turn/completed` → `turn_summary` + `turn.completed`, `thread/tokenUsage/updated` → usage 누적
- `turn/started` → `session.status(running)`, `error` 알림 → `error`
