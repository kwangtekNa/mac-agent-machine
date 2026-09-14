import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../../../src/agents/fake/index.js";
import type { AgentEvent } from "../../../src/agents/types.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "mam-fake-script-"));
  dirs.push(d);
  return d;
}

/** autoApprove 로 기본 스크립트를 한 턴 돌리고 status idle 까지의 이벤트를 모은다. */
async function runTurns(cwd: string, texts: string[]): Promise<AgentEvent[][]> {
  const adapter = new FakeAdapter({ autoApprove: true });
  const s = await adapter.start({ cwd, mode: "auto-edit" });
  const iter = s.events[Symbol.asyncIterator]();
  const turns: AgentEvent[][] = [];
  for (const text of texts) {
    await s.sendTurn({ text });
    const events: AgentEvent[] = [];
    for (;;) {
      const r = await iter.next();
      if (r.done) break;
      events.push(r.value);
      if (r.value.type === "status" && r.value.status === "idle") break;
    }
    turns.push(events);
  }
  await s.close();
  return turns;
}

function fileChanges(events: AgentEvent[]) {
  return events.flatMap((e) => (e.type === "item.started" && e.item.kind === "file_change" ? [e.item] : []));
}

function finalText(events: AgentEvent[]): string {
  const done = events.find((e) => e.type === "item.completed" && e.item.kind === "assistant_message");
  if (!done || done.type !== "item.completed" || done.item.kind !== "assistant_message") throw new Error("assistant_message 없음");
  return done.item.payload.text;
}

describe("defaultScript: write file <이름>", () => {
  it("cwd/<이름> 에 한 줄을 쓰고 file_change(add) 아이템을 낸다", async () => {
    const cwd = await tmp();
    const [events] = await runTurns(cwd, ["[#전체] 사용자: @jiyeon write file smoke.txt\n\nReply for room #전체."]);
    const content = await readFile(join(cwd, "smoke.txt"), "utf8");
    expect(content.endsWith("\n")).toBe(true);
    expect(content.trim().split("\n")).toHaveLength(1);
    const changes = fileChanges(events!);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.payload).toMatchObject({ files: [{ path: "smoke.txt", kind: "add", additions: 1, deletions: 0 }] });
    expect(typeof (changes[0]!.payload as { patch: string }).patch).toBe("string");
    // turn_summary 보다 앞에 와야 summarizeWork 가 filesChanged 에 넣는다.
    const idxChange = events!.findIndex((e) => e.type === "item.started" && e.item.kind === "file_change");
    const idxSummary = events!.findIndex((e) => e.type === "item.started" && e.item.kind === "turn_summary");
    expect(idxChange).toBeGreaterThanOrEqual(0);
    expect(idxChange).toBeLessThan(idxSummary);
  });

  it("이미 있는 파일이면 kind modify", async () => {
    const cwd = await tmp();
    const [, second] = await runTurns(cwd, ["write file a.txt", "write file a.txt again"]);
    const changes = fileChanges(second!);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.payload).toMatchObject({ files: [{ path: "a.txt", kind: "modify" }] });
  });

  it("경로 구분자·허용되지 않는 문자가 섞인 이름은 무시한다", async () => {
    const cwd = await tmp();
    const [a, b, c] = await runTurns(cwd, ["write file ../evil.txt", "write file sub/x.txt", "write file .."]);
    for (const events of [a!, b!, c!]) expect(fileChanges(events)).toHaveLength(0);
    await expect(stat(join(cwd, "..", "evil.txt"))).rejects.toThrow();
    await expect(stat(join(cwd, "sub"))).rejects.toThrow();
  });

  it("write file 이 없으면 파일도 file_change 도 없다(기존 동작 유지)", async () => {
    const cwd = await tmp();
    const [events] = await runTurns(cwd, ["hello"]);
    expect(fileChanges(events!)).toHaveLength(0);
    expect(finalText(events!)).toBe("안녕하세요. 요청하신 명령을 실행하겠습니다.");
    expect(events!.some((e) => e.type === "item.completed" && e.item.kind === "tool_call")).toBe(true);
    expect(events!.some((e) => e.type === "turn.completed")).toBe(true);
  });
});

/**
 * 실제 어댑터와 같은 규칙(ADR-015, Phase 6 step 0): `full-auto` 세션은 승인을 요청하지 않는다.
 * `autoApprove` 옵션은 그대로 두고 모드만으로 판단한다.
 */
describe("defaultScript: full-auto 는 승인을 요청하지 않는다", () => {
  /** autoApprove 없이 한 턴을 돌리고 `stop` 이 true 가 될 때까지 이벤트를 모은다(승인 대기 중에도 멈출 수 있게). */
  async function turnUntil(
    session: { sendTurn: (i: { text: string }) => Promise<void>; events: AsyncIterable<AgentEvent> },
    iter: AsyncIterator<AgentEvent>,
    stop: (e: AgentEvent) => boolean,
  ): Promise<AgentEvent[]> {
    await session.sendTurn({ text: "hello" });
    const events: AgentEvent[] = [];
    for (;;) {
      const r = await iter.next();
      if (r.done) break;
      events.push(r.value);
      if (stop(r.value)) break;
    }
    return events;
  }

  const isApprovalItem = (e: AgentEvent): boolean =>
    (e.type === "item.started" || e.type === "item.completed") && e.item.kind === "approval";
  const isIdle = (e: AgentEvent): boolean => e.type === "status" && e.status === "idle";

  it("mode full-auto 로 시작한 세션은 승인 아이템 없이 tool_call 을 끝낸다", async () => {
    const cwd = await tmp();
    const adapter = new FakeAdapter();
    const s = await adapter.start({ cwd, mode: "full-auto" });
    const events = await turnUntil(s, s.events[Symbol.asyncIterator](), isIdle);
    expect(events.some(isApprovalItem)).toBe(false);
    expect(events.some((e) => e.type === "item.completed" && e.item.kind === "tool_call")).toBe(true);
    expect(events.some((e) => e.type === "turn.completed")).toBe(true);
    await s.close();
  });

  it("ask 모드는 그대로 승인을 요청한다", async () => {
    const cwd = await tmp();
    const adapter = new FakeAdapter();
    const s = await adapter.start({ cwd, mode: "ask" });
    const events = await turnUntil(s, s.events[Symbol.asyncIterator](), isApprovalItem);
    expect(events.some(isApprovalItem)).toBe(true);
    await s.close();
  });

  it("setMode('full-auto') 는 다음 턴부터 승인을 없앤다", async () => {
    const cwd = await tmp();
    const adapter = new FakeAdapter();
    const s = await adapter.start({ cwd, mode: "ask" });
    const iter = s.events[Symbol.asyncIterator]();
    const first = await turnUntil(s, iter, isApprovalItem);
    const approval = first.find((e) => e.type === "item.started" && e.item.kind === "approval");
    expect(approval).toBeDefined();
    if (approval?.type !== "item.started" || approval.item.kind !== "approval") throw new Error("approval 아이템 없음");
    await s.respondApproval(approval.item.payload.approvalId, "allow");
    for (;;) {
      const r = await iter.next(); // 첫 턴이 끝날 때까지 흘려보낸다
      if (r.done || isIdle(r.value)) break;
    }
    await s.setMode("full-auto");
    const second = await turnUntil(s, iter, isIdle);
    expect(second.some(isApprovalItem)).toBe(false);
    await s.close();
  });
});

/** 2026-09-14(Phase 7): 앱의 미리보기 링크 가로채기(IOS.md 12절)를 폰에서 눌러 볼 수 있게 답변에 localhost 링크를 넣는다. */
describe("defaultScript: serve <포트>", () => {
  it("답변 마지막 줄에 http://localhost:<포트>/ 마크다운 링크를 넣는다", async () => {
    const cwd = await tmp();
    const [events] = await runTurns(cwd, ["serve 3456"]);
    const text = finalText(events!);
    expect(text.startsWith("안녕하세요. 요청하신 명령을 실행하겠습니다.")).toBe(true);
    expect(text).toContain("[http://localhost:3456/](http://localhost:3456/)");
    expect(text.trimEnd().endsWith("[http://localhost:3456/](http://localhost:3456/)")).toBe(true);
    // 델타를 이어 붙인 결과와 최종 텍스트가 같다.
    const deltas = events!.flatMap((e) => (e.type === "item.delta" ? [e.delta] : [])).join("");
    expect(deltas).toBe(text);
  });

  it("실제로 포트를 열지는 않는다(파일도 만들지 않는다)", async () => {
    const cwd = await tmp();
    const [events] = await runTurns(cwd, ["serve 3456"]);
    expect(fileChanges(events!)).toHaveLength(0);
    await expect(fetch("http://127.0.0.1:3456/", { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  });

  it("포트가 없거나 범위 밖이면 링크를 넣지 않는다", async () => {
    const cwd = await tmp();
    const [a, b, c] = await runTurns(cwd, ["serve", "serve 0", "serve 70000"]);
    for (const events of [a!, b!, c!]) expect(finalText(events)).not.toContain("http://localhost");
  });

  it("ask 와 같이 오면 멘션 뒤에 링크가 온다", async () => {
    const cwd = await tmp();
    const [events] = await runTurns(cwd, ["ask @minsu serve 8080"]);
    const text = finalText(events!);
    expect(text.indexOf("@minsu 확인 부탁해요.")).toBeLessThan(text.indexOf("http://localhost:8080/"));
  });
});

describe("defaultScript: ask @<핸들>", () => {
  it("답변에 '@<핸들> 확인 부탁해요.' 를 넣는다", async () => {
    const cwd = await tmp();
    const [events] = await runTurns(cwd, ["[DM] 사용자: ask @minsu\n\nReply in this DM."]);
    const text = finalText(events!);
    expect(text).toContain("@minsu 확인 부탁해요.");
    expect(text.startsWith("안녕하세요. 요청하신 명령을 실행하겠습니다.")).toBe(true);
    // 델타를 이어 붙인 결과와 최종 텍스트가 같다.
    const deltas = events!.flatMap((e) => (e.type === "item.delta" ? [e.delta] : [])).join("");
    expect(deltas).toBe(text);
  });

  it("ask 가 없으면 멘션을 넣지 않는다", async () => {
    const cwd = await tmp();
    const [events] = await runTurns(cwd, ["hello @minsu"]);
    expect(finalText(events!)).not.toContain("확인 부탁해요");
  });
});
