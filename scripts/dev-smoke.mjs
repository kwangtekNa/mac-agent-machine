#!/usr/bin/env node
// 개발 모드 gateway(scripts/dev-smoke.sh 가 기동)에 대해 REST → WS → 승인 응답 → 완료를 검증한다.
// docs/PROTOCOL.md 2절의 WS 이벤트 순서를 그대로 따라간다. 실패하면 단계와 받은 이벤트를 출력하고 exit 1.
// 11~14단계는 2026-09-10 추가분(PROTOCOL.md: /fs/mkdir, Session.usage + session.usage, /usage, /models, PATCH model).
import { strict as assert } from "node:assert";
import { mkdir, rm } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import WebSocket from "ws";

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
  } finally {
    await rm(cwd, { recursive: true }).catch(() => {});
  }

  console.log("dev-smoke: OK");
  for (const line of log) console.log(`  ${line}`);
  await closeAll();
  process.exit(0);
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
