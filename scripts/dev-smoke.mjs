#!/usr/bin/env node
// 개발 모드 gateway(scripts/dev-smoke.sh 가 기동)에 대해 REST → WS → 승인 응답 → 완료를 검증한다.
// docs/PROTOCOL.md 2절의 WS 이벤트 순서를 그대로 따라간다. 실패하면 단계와 받은 이벤트를 출력하고 exit 1.
// 11~14단계는 2026-09-10 추가분(PROTOCOL.md: /fs/mkdir, Session.usage + session.usage, /usage, /models, PATCH model).
// 15~21단계는 2026-09-12 추가분(PROTOCOL.md 6절: 팀 생성 → 방 WS → 멘션 디스패치 → 변경 카드 → DM → 팀원 제어 → 머지 → 삭제).
// 19단계는 2026-09-13 추가분(PROTOCOL.md 6.2 PATCH members: mode full-auto 는 승인 없는 턴, effort·model 반영).
// 22단계는 2026-09-13 추가분(PROTOCOL.md 1절 POST /git/init: dryRun → 초기화 → 그 디렉토리로 팀 생성 → 삭제 → 다시 409).
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import WebSocket from "ws";

/** `--keep`(dev-smoke.sh --keep 가 전달): 임시 cwd 와 그 안의 git 저장소를 남기고 `MAM_UI_TEST_REPO=<repo>` 한 줄을 출력한다(iOS TeamRoomUITests 용). 팀·worktree 는 그대로 정리한다. */
const KEEP = process.argv.includes("--keep");
const PORT = Number(process.env.MAM_DEV_PORT ?? 7777);
const BASE = `http://127.0.0.1:${PORT}`;
const WS_BASE = `ws://127.0.0.1:${PORT}`;
const PROTOCOL_HEADERS = { "X-MAM-Protocol": "1" };

let step = "startup";
const log = [];
const openSockets = new Set();

function note(line) {
  log.push(line);
}

async function api(method, pathAndQuery, body) {
  const headers = { ...PROTOCOL_HEADERS };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE}${pathAndQuery}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: res.status, json };
}

class EventStream {
  constructor(ws) {
    this.ws = ws;
    this.events = [];
    this.waiters = [];
    ws.on("message", (data) => {
      let event;
      try {
        event = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.events.push(event);
      note(`ws <- ${event.type} seq=${event.seq}`);
      for (const waiter of [...this.waiters]) {
        if (waiter.predicate(event)) {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          waiter.resolve(event);
        }
      }
    });
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  waitFor(predicate, timeoutMs, description) {
    const already = this.events.find(predicate);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== resolveWrapped);
        reject(new Error(`${description} 을(를) ${timeoutMs}ms 안에 받지 못함`));
      }, timeoutMs);
      const resolveWrapped = (event) => {
        clearTimeout(timer);
        resolve(event);
      };
      this.waiters.push({ predicate, resolve: resolveWrapped });
    });
  }

  close() {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: PROTOCOL_HEADERS });
    openSockets.add(ws);
    ws.once("close", () => openSockets.delete(ws));
    ws.once("open", () => resolve(new EventStream(ws)));
    ws.once("error", reject);
  });
}

/** PROTOCOL.md 2절: seq 는 세션 내 단조 증가. snapshot/pong 은 seq:0 이라 제외한다. */
function assertMonotonicSeq(events) {
  let last = 0;
  for (const event of events) {
    if (event.seq === 0) continue;
    assert.ok(event.seq > last, `seq 가 단조 증가하지 않음: ${event.type} seq=${event.seq} (이전 ${last})`);
    last = event.seq;
  }
}

async function main() {
  const user = userInfo().username;

  step = "1. GET /api/v1/me";
  const me = await api("GET", "/api/v1/me");
  assert.equal(me.status, 200, `status ${me.status}: ${JSON.stringify(me.json)}`);
  assert.equal(me.json.user, user, `user ${me.json.user} !== ${user}`);
  assert.equal(me.json.agents.length, 2, `agents.length ${me.json.agents.length} !== 2`);
  note(`1. /me OK (user=${me.json.user}, agents=${me.json.agents.map((a) => a.kind).join(",")})`);

  step = "2. 임시 cwd 생성";
  const cwd = path.join(homedir(), ".mam", "smoke", String(Date.now()));
  await mkdir(cwd, { recursive: true });
  note(`2. tmp cwd: ${cwd}`);
  let uiTestRepo = null;

  try {
    step = "3. POST /api/v1/sessions";
    const created = await api("POST", "/api/v1/sessions", { agent: "claude", cwd });
    assert.equal(created.status, 201, `status ${created.status}: ${JSON.stringify(created.json)}`);
    assert.ok(["starting", "idle"].includes(created.json.status), `status ${created.json.status}`);
    const sessionId = created.json.id;
    note(`3. session ${sessionId} created (status=${created.json.status})`);

    step = "4. GET /api/v1/fs/list";
    const listCwd = await api("GET", `/api/v1/fs/list?path=${encodeURIComponent(cwd)}`);
    assert.equal(listCwd.status, 200, `fs/list(cwd) status ${listCwd.status}`);
    const listEtc = await api("GET", "/api/v1/fs/list?path=/etc");
    assert.equal(listEtc.status, 403, `fs/list(/etc) status ${listEtc.status}`);
    note("4. fs/list OK (200 for cwd, 403 for /etc)");

    step = "5. WS 접속 → session.snapshot";
    const wsUrl = `${WS_BASE}/api/v1/sessions/${sessionId}/ws`;
    const stream1 = await connect(wsUrl);
    const snapshot = await stream1.waitFor((e) => e.type === "session.snapshot", 5000, "session.snapshot");
    assert.equal(snapshot.sessionId, sessionId, "snapshot.sessionId mismatch");
    note("5. WS snapshot received");

    step = "6. turn.start → item.delta + approval.requested(command)";
    stream1.send({ type: "turn.start", text: "hello" });
    await stream1.waitFor((e) => e.type === "item.delta", 30_000, "item.delta");
    const approvalReq = await stream1.waitFor((e) => e.type === "approval.requested", 30_000, "approval.requested");
    assert.equal(approvalReq.approval.kind, "command", `approval.kind ${approvalReq.approval.kind}`);
    assertMonotonicSeq(stream1.events);
    note(`6. item.delta + approval.requested(kind=command, id=${approvalReq.approval.approvalId}) OK`);

    step = "7. approval.respond → resolved/completed/turn.completed/idle";
    stream1.send({ type: "approval.respond", approvalId: approvalReq.approval.approvalId, optionId: "allow" });
    await stream1.waitFor((e) => e.type === "approval.resolved", 30_000, "approval.resolved");
    await stream1.waitFor((e) => e.type === "item.completed" && e.item.kind === "tool_call", 30_000, "item.completed(tool_call)");
    await stream1.waitFor((e) => e.type === "turn.completed", 30_000, "turn.completed");
    await stream1.waitFor((e) => e.type === "session.status" && e.status === "idle", 30_000, "session.status(idle)");
    assertMonotonicSeq(stream1.events);
    note("7. approval resolved → tool_call completed → turn.completed → status idle OK");

    step = "8. since=<중간 seq> 로 재접속 → 스냅샷 재생";
    const assistantCompleted = stream1.events.find((e) => e.type === "item.completed" && e.item.kind === "assistant_message");
    assert.ok(assistantCompleted, "assistant_message item.completed 이벤트를 못 찾음");
    const sinceSeq = assistantCompleted.seq;
    const stream2 = await connect(`${wsUrl}?since=${sinceSeq}`);
    const snapshot2 = await stream2.waitFor((e) => e.type === "session.snapshot", 5000, "session.snapshot(since)");
    assert.equal(snapshot2.replayFrom, sinceSeq, `replayFrom ${snapshot2.replayFrom} !== ${sinceSeq}`);
    assert.ok(snapshot2.items.length > 0, "since 이후 재생 아이템이 없음");
    assert.ok(
      snapshot2.items.every((item) => item.seq > sinceSeq),
      "재생 아이템에 since 이하 seq 가 섞여 있음",
    );
    assert.ok(
      snapshot2.items.some((item) => item.kind === "tool_call" && item.status === "completed"),
      "재생 아이템에 완료된 tool_call 이 없음",
    );
    // 스냅샷 뒤에는 since 이후의 원본 이벤트(item.started/approval.requested/...)가 seq 순서 그대로 이어진다(agent-host/ws.ts: 큐 flush).
    await stream2.waitFor((e) => e.type === "turn.completed", 5000, "turn.completed(replay)");
    assertMonotonicSeq(stream2.events);
    await stream2.close();
    note(`8. since=${sinceSeq} 재접속: 스냅샷(${snapshot2.items.length}개 아이템) + 재생 이벤트 이어짐 OK`);

    step = "9. GET /api/v1/sessions/:id → approval.resolution";
    const detail = await api("GET", `/api/v1/sessions/${sessionId}`);
    assert.equal(detail.status, 200, `session detail status ${detail.status}`);
    const approvalItem = detail.json.items.find((item) => item.kind === "approval");
    assert.ok(approvalItem, "approval 아이템을 못 찾음");
    assert.ok(approvalItem.payload.resolution, "approval.resolution 이 없음");
    assert.equal(approvalItem.payload.resolution.optionId, "allow", `resolution.optionId ${approvalItem.payload.resolution.optionId}`);
    note("9. session detail 에 승인 아이템의 resolution 확인 OK");

    step = "10. POST /api/v1/sessions/:id/close";
    const closed = await api("POST", `/api/v1/sessions/${sessionId}/close`);
    assert.equal(closed.status, 200, `close status ${closed.status}`);
    assert.equal(closed.json.status, "closed", `close status field ${closed.json.status}`);
    await stream1.close();
    note("10. session closed OK");

    step = "11. POST /api/v1/fs/mkdir → 201, 다시 → 409";
    const subDir = path.join(cwd, "sub");
    const made = await api("POST", "/api/v1/fs/mkdir", { path: subDir });
    assert.equal(made.status, 201, `mkdir status ${made.status}: ${JSON.stringify(made.json)}`);
    assert.equal(made.json.entry.type, "dir", `entry.type ${made.json.entry.type}`);
    assert.equal(made.json.entry.path, subDir, `entry.path ${made.json.entry.path} !== ${subDir}`);
    const again = await api("POST", "/api/v1/fs/mkdir", { path: subDir });
    assert.equal(again.status, 409, `mkdir(again) status ${again.status}: ${JSON.stringify(again.json)}`);
    assert.equal(again.json.error.code, "conflict", `mkdir(again) error.code ${again.json.error.code}`);
    note("11. fs/mkdir OK (201 then 409 conflict)");

    step = "12. 턴 완료 후 Session.usage + session.usage 이벤트";
    // session.usage 는 turn.completed → session.status(idle) 뒤에 온다(첫 관측은 즉시 발행). 이미 받았으면 바로 통과.
    const usageEvent = await stream1.waitFor((e) => e.type === "session.usage", 5000, "session.usage");
    assert.equal(usageEvent.sessionId, sessionId, "session.usage.sessionId mismatch");
    assert.equal(usageEvent.usage.turns, 1, `session.usage.usage.turns ${usageEvent.usage.turns} !== 1`);
    const afterTurn = await api("GET", `/api/v1/sessions/${sessionId}`);
    assert.equal(afterTurn.status, 200, `session detail status ${afterTurn.status}`);
    const usage = afterTurn.json.session.usage;
    assert.ok(usage, "session.usage 가 null 임");
    assert.equal(usage.turns, 1, `usage.turns ${usage.turns} !== 1`);
    assert.ok(usage.context, "usage.context 가 null 임");
    assert.ok(
      Number.isInteger(usage.context.percent) && usage.context.percent >= 0 && usage.context.percent <= 100,
      `usage.context.percent ${usage.context.percent} 가 0~100 정수가 아님`,
    );
    assert.ok(usage.inputTokens > 0 && usage.outputTokens > 0, `누적 토큰이 비어 있음: ${JSON.stringify(usage)}`);
    note(`12. usage OK (turns=${usage.turns}, context ${usage.context.tokens}/${usage.context.window} = ${usage.context.percent}%, session.usage seq=${usageEvent.seq})`);

    step = "13. GET /api/v1/usage, GET /api/v1/models?agent=claude";
    const limits = await api("GET", "/api/v1/usage");
    assert.equal(limits.status, 200, `usage status ${limits.status}: ${JSON.stringify(limits.json)}`);
    assert.equal(limits.json.agents.length, 2, `usage.agents.length ${limits.json.agents.length} !== 2`);
    for (const agent of limits.json.agents) {
      for (const limit of agent.limits) {
        assert.ok(["ok", "warning", "exceeded"].includes(limit.status), `limit.status ${limit.status}`);
        assert.ok(limit.usedPercent >= 0, `limit.usedPercent ${limit.usedPercent}`);
      }
    }
    const models = await api("GET", "/api/v1/models?agent=claude");
    assert.equal(models.status, 200, `models status ${models.status}: ${JSON.stringify(models.json)}`);
    assert.ok(models.json.models.length >= 1, `models.length ${models.json.models.length} < 1`);
    assert.ok(models.json.models.every((m) => typeof m.id === "string" && Array.isArray(m.efforts)), "model 항목 형태가 다름");
    note(`13. /usage (agents=${limits.json.agents.map((a) => `${a.kind}:${a.limits.length}`).join(",")}) + /models (${models.json.models.map((m) => m.id).join(",")}) OK`);

    step = "14. PATCH /api/v1/sessions/:id { model } → 200, 잘못된 모델 → 400";
    // 닫힌 세션은 409 라 새 세션에서 검증한다(PROTOCOL.md: model 은 GET /models 가 준 값이어야 한다).
    const patchCandidate = models.json.models.find((m) => m.id !== (afterTurn.json.session.model ?? "")) ?? models.json.models[0];
    const second = await api("POST", "/api/v1/sessions", { agent: "claude", cwd });
    assert.equal(second.status, 201, `second session status ${second.status}: ${JSON.stringify(second.json)}`);
    try {
      const patched = await api("PATCH", `/api/v1/sessions/${second.json.id}`, { model: patchCandidate.id });
      assert.equal(patched.status, 200, `patch status ${patched.status}: ${JSON.stringify(patched.json)}`);
      assert.equal(patched.json.model, patchCandidate.id, `patched.model ${patched.json.model} !== ${patchCandidate.id}`);
      const bad = await api("PATCH", `/api/v1/sessions/${second.json.id}`, { model: "no-such-model" });
      assert.equal(bad.status, 400, `patch(bad model) status ${bad.status}: ${JSON.stringify(bad.json)}`);
      assert.equal(bad.json.error.code, "invalid_request", `patch(bad model) error.code ${bad.json.error.code}`);
      const onClosed = await api("PATCH", `/api/v1/sessions/${sessionId}`, { model: patchCandidate.id });
      assert.equal(onClosed.status, 409, `patch(closed session) status ${onClosed.status}`);
      note(`14. PATCH model=${patchCandidate.id} → 200, no-such-model → 400, closed → 409 OK`);
    } finally {
      await api("POST", `/api/v1/sessions/${second.json.id}/close`);
    }

    uiTestRepo = await teamSteps(cwd);
    await gitInitSteps(cwd);
  } finally {
    if (!KEEP) await rm(cwd, { recursive: true }).catch(() => {});
  }

  console.log("dev-smoke: OK");
  for (const line of log) console.log(`  ${line}`);
  if (KEEP && uiTestRepo) console.log(`MAM_UI_TEST_REPO=${uiTestRepo}`);
  await closeAll();
  process.exit(0);
}

/** 셸 없이 `git -C <cwd> <args>` 를 실행하고 stdout 을 돌려준다(CRITICAL 4). */
function git(cwd, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`git ${args.join(" ")} exit ${code}: ${err.trim()}`));
    });
  });
}

const GIT_IDENTITY = ["-c", "user.name=mam-smoke", "-c", "user.email=mam-smoke@example.com"];

/**
 * 팀원 세션의 승인 요청은 방에 `kind: approval` 카드로 미러링된다(PROTOCOL 6.4). 응답은 방 WS 가 아니라
 * 기존 `POST /sessions/:id/approvals/:approvalId` 로 보내고, 방에는 `room.message.updated` 로 resolution 이 채워진다(6.3).
 * Fake 기본 스크립트는 턴마다 `echo hi` 승인을 요청하므로 팀원 턴마다 한 번씩 부른다.
 */
const handledApprovals = new Set();
async function allowApproval(stream, memberId) {
  const card = await stream.waitFor(
    (e) => e.type === "room.message" && e.message.kind === "approval" && e.message.author.kind === "agent" && e.message.author.memberId === memberId
      && e.message.approval !== null && !handledApprovals.has(e.message.approval.approval.approvalId),
    30_000,
    "room.message(approval)",
  );
  const { sessionId, approval, resolution } = card.message.approval;
  assert.equal(resolution, null, "승인 카드의 resolution 이 처음부터 채워져 있음");
  handledApprovals.add(approval.approvalId);
  const res = await api("POST", `/api/v1/sessions/${sessionId}/approvals/${approval.approvalId}`, { optionId: "allow" });
  assert.equal(res.status, 200, `approval respond status ${res.status}: ${JSON.stringify(res.json)}`);
  const updated = await stream.waitFor(
    (e) => e.type === "room.message.updated" && e.message.id === card.message.id && e.message.approval?.resolution,
    30_000,
    "room.message.updated(approval resolved)",
  );
  assert.equal(updated.message.approval.resolution.optionId, "allow", "resolution.optionId");
  assert.equal(updated.message.seq, card.message.seq, "room.message.updated 의 message.seq 는 원래 값을 유지해야 함");
  assert.ok(updated.seq > card.seq, "room.message.updated 는 새 seq 를 받아야 함");
  return card;
}

const isAgentText = (memberId) => (e) =>
  e.type === "room.message" && e.message.kind === "text" && e.message.author.kind === "agent" && e.message.author.memberId === memberId;
const isIdleStatusAfter = (seq) => (e) => e.type === "room.status" && e.seq > seq && e.members.every((m) => m.state === "idle");

/** 15~21단계: PROTOCOL.md 6절 종단 검증. 실패해도 팀은 best-effort 로 지운다(worktree 가 더러우면 keepWorktrees). 만든 git 저장소 경로를 돌려준다. */
async function teamSteps(cwd) {
  let team = null;
  let deleted = false;
  const repo = path.join(cwd, "repo");
  try {
    step = "15. GET /api/v1/team-roles, git init, POST /api/v1/teams";
    const roles = await api("GET", "/api/v1/team-roles");
    assert.equal(roles.status, 200, `team-roles status ${roles.status}: ${JSON.stringify(roles.json)}`);
    assert.equal(roles.json.roles.length, 5, `roles.length ${roles.json.roles.length} !== 5`);
    await mkdir(repo, { recursive: true });
    await git(repo, "init", "-q", "-b", "main");
    await writeFile(path.join(repo, "README.md"), "# smoke\n");
    await git(repo, "add", "README.md");
    await git(repo, ...GIT_IDENTITY, "commit", "-q", "-m", "init");
    const created = await api("POST", "/api/v1/teams", {
      cwd: repo,
      name: "smoke",
      members: [
        { name: "민수", handle: "minsu", role: "team-lead", agent: "claude", isLead: true },
        { name: "지연", handle: "jiyeon", role: "developer", agent: "codex" },
      ],
    });
    assert.equal(created.status, 201, `POST /teams status ${created.status}: ${JSON.stringify(created.json)}`);
    team = created.json;
    assert.equal(team.baseBranch, "main", `baseBranch ${team.baseBranch}`);
    assert.equal(team.members.length, 2, `members.length ${team.members.length}`);
    const teamsRoot = path.join(homedir(), ".mam", "teams", team.id, "worktrees");
    for (const m of team.members) {
      assert.equal(typeof m.sessionId, "string", `${m.name}.sessionId 가 없음`);
      assert.ok(m.worktreePath.startsWith(teamsRoot), `worktreePath ${m.worktreePath} 가 ${teamsRoot} 밖`);
      assert.ok((await stat(m.worktreePath)).isDirectory(), `worktree 디렉토리 없음: ${m.worktreePath}`);
      assert.equal(m.branch, `mam/smoke/${m.handle}`, `branch ${m.branch}`);
    }
    const branches = (await git(repo, "branch", "--list", "mam/smoke/*")).split("\n").map((l) => l.trim()).filter(Boolean);
    assert.equal(branches.length, 2, `mam/smoke/* 브랜치 ${branches.length}개: ${branches.join(",")}`);
    const minsu = team.members.find((m) => m.handle === "minsu");
    const jiyeon = team.members.find((m) => m.handle === "jiyeon");
    const group = team.rooms.find((r) => r.kind === "group");
    const dm = team.rooms.find((r) => r.kind === "dm" && r.memberId === jiyeon.id);
    assert.ok(minsu && jiyeon && group && dm, "팀원·방 구성이 예상과 다름");
    note(`15. team ${team.id} (lead=${minsu.handle}, dev=${jiyeon.handle}, branches=${branches.join(",")}) OK`);

    step = "16. 그룹방 WS → room.snapshot, POST messages(hello) → user/approval/agent(work)/status";
    const groupWs = await connect(`${WS_BASE}/api/v1/teams/${team.id}/rooms/${group.id}/ws`);
    const snapshot = await groupWs.waitFor((e) => e.type === "room.snapshot", 5000, "room.snapshot");
    assert.equal(snapshot.seq, 0, "room.snapshot seq");
    assert.equal(snapshot.roomId, group.id, "room.snapshot roomId");
    assert.equal(snapshot.messages.length, 0, "새 그룹방에 메시지가 있음");
    assert.equal(snapshot.members.length, 2, "snapshot.members");
    const hello = await api("POST", `/api/v1/teams/${team.id}/rooms/${group.id}/messages`, { text: "hello" });
    assert.equal(hello.status, 201, `POST messages status ${hello.status}: ${JSON.stringify(hello.json)}`);
    assert.equal(hello.json.dispatches.length, 1, `dispatches ${JSON.stringify(hello.json.dispatches)}`);
    const helloEvent = await groupWs.waitFor((e) => e.type === "room.message" && e.message.id === hello.json.message.id, 5000, "room.message(user)");
    assert.equal(helloEvent.message.author.kind, "user");
    assert.equal(helloEvent.message.hop, 0);
    await allowApproval(groupWs, minsu.id);
    const leadReply = await groupWs.waitFor(isAgentText(minsu.id), 30_000, "room.message(agent 민수)");
    assert.ok(leadReply.seq > helloEvent.seq, "팀장 답변 seq 가 사용자 메시지보다 앞섬");
    assert.equal(leadReply.message.hop, 1, `hop ${leadReply.message.hop}`);
    assert.equal(leadReply.message.dispatchId, hello.json.dispatches[0], "dispatchId");
    assert.ok(leadReply.message.work, "work 가 없음");
    assert.equal(leadReply.message.work.sessionId, minsu.sessionId, "work.sessionId");
    assert.ok(Number.isInteger(leadReply.message.work.toolCalls) && leadReply.message.work.toolCalls >= 1, `work.toolCalls ${leadReply.message.work.toolCalls}`);
    await groupWs.waitFor(isIdleStatusAfter(leadReply.seq), 5000, "room.status(idle)");
    assertMonotonicSeq(groupWs.events);
    note(`16. group room: user(seq ${helloEvent.seq}) → approval allow → 민수 reply(seq ${leadReply.seq}, toolCalls=${leadReply.message.work.toolCalls}) → status idle OK`);

    step = "17. @jiyeon write file smoke.txt → 지연 답변 + changes 카드(ready) + GET /changes";
    const ask = await api("POST", `/api/v1/teams/${team.id}/rooms/${group.id}/messages`, { text: "@jiyeon write file smoke.txt" });
    assert.equal(ask.status, 201, `POST messages status ${ask.status}`);
    assert.deepEqual(ask.json.message.mentions, [jiyeon.id], "mentions");
    await allowApproval(groupWs, jiyeon.id);
    const devReply = await groupWs.waitFor(isAgentText(jiyeon.id), 30_000, "room.message(agent 지연)");
    assert.deepEqual(devReply.message.work.filesChanged, ["smoke.txt"], `work.filesChanged ${JSON.stringify(devReply.message.work.filesChanged)}`);
    const card = await groupWs.waitFor((e) => e.type === "room.message" && e.message.kind === "changes", 30_000, "room.message(changes)");
    assert.equal(card.message.changes.status, "ready", `changes.status ${card.message.changes.status}`);
    assert.equal(card.message.changes.memberId, jiyeon.id, "changes.memberId");
    assert.equal(card.message.changes.branch, jiyeon.branch, "changes.branch");
    assert.ok(card.message.changes.files.some((f) => f.path === "smoke.txt"), `changes.files ${JSON.stringify(card.message.changes.files)}`);
    assert.equal(card.message.changes.messageId, card.message.id, "changes.messageId");
    await groupWs.waitFor(isIdleStatusAfter(card.seq), 5000, "room.status(idle)");
    const changes = await api("GET", `/api/v1/teams/${team.id}/changes`);
    assert.equal(changes.status, 200);
    assert.equal(changes.json.changes.length, 1, `changes.length ${changes.json.changes.length}`);
    const changeId = changes.json.changes[0].id;
    assert.equal(changeId, card.message.changes.id, "changes 목록과 카드의 id 가 다름");
    assertMonotonicSeq(groupWs.events);
    note(`17. 지연 reply(files=${devReply.message.work.filesChanged}) + changes card ${changeId} ready(${card.message.changes.commits} commit) OK`);

    step = "18. DM WS → room.send(ask @minsu) → 지연 답변에 @minsu, 그룹방 연쇄 없음";
    const dmWs = await connect(`${WS_BASE}/api/v1/teams/${team.id}/rooms/${dm.id}/ws`);
    const dmSnapshot = await dmWs.waitFor((e) => e.type === "room.snapshot", 5000, "room.snapshot(dm)");
    assert.equal(dmSnapshot.room.kind, "dm");
    assert.equal(dmSnapshot.room.memberId, jiyeon.id);
    const groupBefore = await api("GET", `/api/v1/teams/${team.id}/rooms/${group.id}`);
    const groupMessagesBefore = groupBefore.json.messages.length;
    const groupEventsBefore = groupWs.events.filter((e) => e.type === "room.message").length;
    dmWs.send({ type: "room.send", text: "ask @minsu" });
    const dmUser = await dmWs.waitFor((e) => e.type === "room.message" && e.message.author.kind === "user", 5000, "room.message(dm user)");
    assert.deepEqual(dmUser.message.mentions, [], "DM 사용자 메시지의 mentions 는 비어 있어야 함");
    await allowApproval(dmWs, jiyeon.id);
    const dmReply = await dmWs.waitFor(isAgentText(jiyeon.id), 30_000, "room.message(dm agent 지연)");
    assert.ok(dmReply.message.text.includes("@minsu 확인 부탁해요."), `DM 답변에 @minsu 없음: ${dmReply.message.text}`);
    await dmWs.waitFor(isIdleStatusAfter(dmReply.seq), 5000, "room.status(dm idle)");
    const detailAfterDm = await api("GET", `/api/v1/teams/${team.id}`);
    assert.equal(detailAfterDm.json.dispatch.running.length + detailAfterDm.json.dispatch.queued.length, 0, `DM 답변 멘션이 디스패치됨: ${JSON.stringify(detailAfterDm.json.dispatch)}`);
    const groupAfter = await api("GET", `/api/v1/teams/${team.id}/rooms/${group.id}`);
    assert.equal(groupAfter.json.messages.length, groupMessagesBefore, "DM 멘션이 그룹방 메시지를 만들었음");
    assert.equal(groupWs.events.filter((e) => e.type === "room.message").length, groupEventsBefore, "DM 멘션이 그룹방 WS 에 메시지를 보냈음");
    assertMonotonicSeq(dmWs.events);
    assertMonotonicSeq(groupWs.events);
    note(`18. DM: 지연 reply(seq ${dmReply.seq}) mentions @minsu, group messages ${groupMessagesBefore} → ${groupAfter.json.messages.length} (연쇄 없음) OK`);

    step = "19. PATCH members/:id { mode: full-auto } → 승인 없는 턴, { effort }, { model } 반영";
    // PROTOCOL.md 6.2: mode·effort 는 즉시, model 은 다음 세션부터(응답 Team 에는 바로 보인다). ADR-015: full-auto 는 승인 없음.
    const toFullAuto = await api("PATCH", `/api/v1/teams/${team.id}/members/${jiyeon.id}`, { mode: "full-auto" });
    assert.equal(toFullAuto.status, 200, `PATCH mode status ${toFullAuto.status}: ${JSON.stringify(toFullAuto.json)}`);
    assert.equal(toFullAuto.json.members.find((m) => m.id === jiyeon.id).mode, "full-auto", "members[].mode 가 full-auto 가 아님");
    dmWs.send({ type: "room.send", text: "full-auto ping" });
    const fullAutoUser = await dmWs.waitFor(
      (e) => e.type === "room.message" && e.message.author.kind === "user" && e.message.text === "full-auto ping",
      5000,
      "room.message(dm user, full-auto)",
    );
    const fullAutoReply = await dmWs.waitFor(
      (e) => isAgentText(jiyeon.id)(e) && e.seq > fullAutoUser.seq,
      30_000,
      "room.message(dm agent, full-auto)",
    );
    const approvalCards = dmWs.events.filter(
      (e) => e.type === "room.message" && e.message.kind === "approval" && e.seq > fullAutoUser.seq && e.seq <= fullAutoReply.seq,
    );
    assert.equal(approvalCards.length, 0, `full-auto 턴에 승인 카드가 ${approvalCards.length}개 올라옴`);
    assert.ok(fullAutoReply.message.work.toolCalls >= 1, `full-auto 턴의 toolCalls ${fullAutoReply.message.work.toolCalls}`);
    await dmWs.waitFor(isIdleStatusAfter(fullAutoReply.seq), 5000, "room.status(dm idle, full-auto)");
    const toLowEffort = await api("PATCH", `/api/v1/teams/${team.id}/members/${jiyeon.id}`, { effort: "low" });
    assert.equal(toLowEffort.status, 200, `PATCH effort status ${toLowEffort.status}: ${JSON.stringify(toLowEffort.json)}`);
    assert.equal(toLowEffort.json.members.find((m) => m.id === jiyeon.id).effort, "low", "members[].effort 가 low 가 아님");
    // fake-mini 는 effort 를 지원하지 않으므로 서버가 effort 를 지운다(manager.setModelEffort).
    const toMini = await api("PATCH", `/api/v1/teams/${team.id}/members/${jiyeon.id}`, { model: "fake-mini" });
    assert.equal(toMini.status, 200, `PATCH model status ${toMini.status}: ${JSON.stringify(toMini.json)}`);
    const afterModel = toMini.json.members.find((m) => m.id === jiyeon.id);
    assert.equal(afterModel.model, "fake-mini", `members[].model ${afterModel.model}`);
    assert.equal(afterModel.effort, null, `members[].effort ${afterModel.effort} (fake-mini 는 effort 미지원)`);
    assert.equal(afterModel.mode, "full-auto", "model 변경이 mode 를 되돌림");
    assertMonotonicSeq(dmWs.events);
    note(`19. PATCH mode=full-auto → 승인 카드 0건, toolCalls=${fullAutoReply.message.work.toolCalls}; effort=low; model=fake-mini(effort 해제) OK`);

    step = "20. POST changes/:id/merge → merged, git log --merges 1개, show --stat 에 smoke.txt; POST stop";
    const merged = await api("POST", `/api/v1/teams/${team.id}/changes/${changeId}/merge`);
    assert.equal(merged.status, 200, `merge status ${merged.status}: ${JSON.stringify(merged.json)}`);
    assert.equal(merged.json.change.status, "merged", `change.status ${merged.json.change.status}`);
    assert.ok(typeof merged.json.mergeCommit === "string" && merged.json.mergeCommit.length === 40, `mergeCommit ${merged.json.mergeCommit}`);
    const mergesLog = (await git(repo, "log", "--merges", "--oneline")).split("\n").filter((l) => l.trim() !== "");
    assert.equal(mergesLog.length, 1, `merge 커밋 ${mergesLog.length}개: ${mergesLog.join(" | ")}`);
    assert.ok(mergesLog[0].startsWith(merged.json.mergeCommit.slice(0, 7)), `merge 커밋이 mergeCommit 과 다름: ${mergesLog[0]}`);
    const shown = await git(repo, "show", "--stat", "HEAD");
    assert.ok(shown.includes("smoke.txt"), "git show --stat HEAD 에 smoke.txt 가 없음");
    assert.equal((await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).trim(), "main", "머지 후 현재 브랜치");
    const cardMerged = await groupWs.waitFor((e) => e.type === "room.message.updated" && e.message.kind === "changes" && e.message.changes.status === "merged", 5000, "room.message.updated(changes merged)");
    assert.equal(cardMerged.message.seq, card.message.seq, "변경 카드 갱신은 message.seq 를 유지해야 함");
    const stopped = await api("POST", `/api/v1/teams/${team.id}/stop`);
    assert.equal(stopped.status, 200, `stop status ${stopped.status}`);
    assert.deepEqual(stopped.json, { running: [], queued: [] }, `stop 결과 ${JSON.stringify(stopped.json)}`);
    assertMonotonicSeq(groupWs.events);
    note(`20. merge ${merged.json.mergeCommit.slice(0, 7)} (${mergesLog[0]}) + stop OK`);

    step = "21. DELETE /api/v1/teams/:id → worktree 없음, 목록에 없음, 세션 closed + team";
    const del = await api("DELETE", `/api/v1/teams/${team.id}`);
    assert.equal(del.status, 200, `delete status ${del.status}: ${JSON.stringify(del.json)}`);
    deleted = true;
    for (const m of team.members) {
      await assert.rejects(stat(m.worktreePath), `worktree 가 남아 있음: ${m.worktreePath}`);
    }
    await assert.rejects(stat(path.join(homedir(), ".mam", "teams", team.id, "worktrees")), "worktrees 디렉토리가 남아 있음");
    const list = await api("GET", "/api/v1/teams");
    assert.equal(list.status, 200);
    assert.ok(!list.json.teams.some((t) => t.id === team.id), "삭제한 팀이 목록에 있음");
    const closedSessions = await api("GET", "/api/v1/sessions?status=closed");
    assert.equal(closedSessions.status, 200);
    for (const m of team.members) {
      const s = closedSessions.json.sessions.find((x) => x.id === m.sessionId);
      assert.ok(s, `팀원 세션 ${m.sessionId} 이 closed 목록에 없음`);
      assert.deepEqual(s.team, { teamId: team.id, memberId: m.id }, `session.team ${JSON.stringify(s.team)}`);
      assert.equal(s.instructions, undefined, "세션 응답에 instructions 가 노출됨");
    }
    await groupWs.close();
    await dmWs.close();
    note(`21. team deleted, worktrees gone, ${team.members.length} member sessions closed with team OK`);
  } finally {
    if (team && !deleted) {
      const res = await api("DELETE", `/api/v1/teams/${team.id}`).catch(() => null);
      if (!res || res.status !== 200) await api("DELETE", `/api/v1/teams/${team.id}?keepWorktrees=true`).catch(() => null);
    }
  }
  return repo;
}

/**
 * 22단계: PROTOCOL.md 1절 `POST /git/init`(2026-09-13 추가). `<cwd>/fresh` 에 파일 2개 + `node_modules/x.js` 를 두고
 * dryRun(200, 아무것도 안 바꿈) → 초기화(201, `.gitignore` + `main` 첫 커밋, `node_modules` 제외) → 같은 디렉토리로 `POST /teams`(201)
 * → `DELETE /teams/:id`(200) → 다시 `POST /git/init` 은 409. 팀은 실패해도 best-effort 로 지운다. `fresh` 는 cwd 와 함께 정리된다.
 */
async function gitInitSteps(cwd) {
  step = "22. POST /api/v1/git/init dryRun → 초기화 → POST /teams → DELETE → 다시 409";
  const fresh = path.join(cwd, "fresh");
  await mkdir(path.join(fresh, "node_modules"), { recursive: true });
  await writeFile(path.join(fresh, "index.js"), "console.log('fresh');\n");
  await writeFile(path.join(fresh, "README.md"), "# fresh\n");
  await writeFile(path.join(fresh, "node_modules", "x.js"), "module.exports = 1;\n");

  const dry = await api("POST", "/api/v1/git/init", { cwd: fresh, dryRun: true });
  assert.equal(dry.status, 200, `dryRun status ${dry.status}: ${JSON.stringify(dry.json)}`);
  assert.equal(dry.json.initialized, false, "dryRun.initialized 가 false 가 아님");
  assert.equal(dry.json.files, 2, `dryRun.files ${dry.json.files} !== 2 (node_modules 는 기본 .gitignore 로 제외)`);
  assert.equal(dry.json.commit, null, `dryRun.commit ${dry.json.commit}`);
  assert.equal(dry.json.createdGitignore, true, "dryRun.createdGitignore 가 true 가 아님");
  await assert.rejects(stat(path.join(fresh, ".git")), "dryRun 이 .git 을 만들었음");
  await assert.rejects(stat(path.join(fresh, ".gitignore")), "dryRun 이 .gitignore 를 만들었음");

  const init = await api("POST", "/api/v1/git/init", { cwd: fresh });
  assert.equal(init.status, 201, `init status ${init.status}: ${JSON.stringify(init.json)}`);
  assert.equal(init.json.initialized, true, "init.initialized 가 true 가 아님");
  assert.equal(init.json.branch, "main", `init.branch ${init.json.branch}`);
  assert.match(init.json.commit ?? "", /^[0-9a-f]{40}$/, `init.commit ${init.json.commit}`);
  assert.equal(init.json.files, dry.json.files, `init.files ${init.json.files} !== dryRun ${dry.json.files}`);
  assert.equal(init.json.bytes, dry.json.bytes, `init.bytes ${init.json.bytes} !== dryRun ${dry.json.bytes}`);
  assert.ok((await stat(path.join(fresh, ".gitignore"))).isFile(), ".gitignore 가 없음");
  const logLines = (await git(fresh, "log", "--oneline")).split("\n").filter((l) => l.trim() !== "");
  assert.equal(logLines.length, 1, `git log --oneline 이 ${logLines.length}줄: ${logLines.join(" | ")}`);
  assert.ok(logLines[0].startsWith(init.json.commit.slice(0, 7)), `git log 첫 줄이 commit 과 다름: ${logLines[0]}`);
  assert.equal((await git(fresh, "rev-parse", "--abbrev-ref", "HEAD")).trim(), "main", "초기화 후 현재 브랜치");
  const tracked = (await git(fresh, "ls-files")).split("\n").filter((l) => l.trim() !== "").sort();
  assert.ok(!tracked.some((p) => p.startsWith("node_modules")), `git ls-files 에 node_modules 가 있음: ${tracked.join(",")}`);
  assert.deepEqual(tracked, [".gitignore", "README.md", "index.js"], `git ls-files ${tracked.join(",")}`);

  const created = await api("POST", "/api/v1/teams", {
    cwd: fresh,
    name: "fresh",
    members: [{ name: "민수", handle: "minsu", role: "team-lead", agent: "claude", isLead: true }],
  });
  assert.equal(created.status, 201, `POST /teams status ${created.status}: ${JSON.stringify(created.json)}`);
  assert.equal(created.json.baseBranch, "main", `baseBranch ${created.json.baseBranch}`);
  let deleted = false;
  try {
    const del = await api("DELETE", `/api/v1/teams/${created.json.id}`);
    assert.equal(del.status, 200, `DELETE /teams status ${del.status}: ${JSON.stringify(del.json)}`);
    deleted = true;
  } finally {
    if (!deleted) await api("DELETE", `/api/v1/teams/${created.json.id}?keepWorktrees=true`).catch(() => null);
  }

  const again = await api("POST", "/api/v1/git/init", { cwd: fresh });
  assert.equal(again.status, 409, `init(again) status ${again.status}: ${JSON.stringify(again.json)}`);
  assert.equal(again.json.error.code, "conflict", `init(again) error.code ${again.json.error.code}`);
  note(`22. git/init dryRun(files=${dry.json.files}, bytes=${dry.json.bytes}, .git 없음) → init ${init.json.commit.slice(0, 7)} (main, ls-files=${tracked.join(",")}) → team ${created.json.id} 201 → delete 200 → again 409 OK`);
}

async function closeAll() {
  await Promise.all([...openSockets].map((ws) => new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.once("close", resolve);
    ws.terminate();
  })));
}

main().catch(async (err) => {
  console.error(`dev-smoke: FAIL at ${step}`);
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  console.error("받은 이벤트:");
  for (const line of log) console.error(`  ${line}`);
  await closeAll();
  process.exit(1);
});
