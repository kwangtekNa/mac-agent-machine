import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAdapter } from "../../../src/agents/codex/adapter.js";
import type { AgentEvent } from "../../../src/agents/types.js";

const IT = process.env.MAM_IT_CODEX === "1";

/** 실제 `codex app-server` 스모크. `MAM_IT_CODEX=1` 일 때만 실행한다(게이트 제외). */
describe.skipIf(!IT)("codex integration (MAM_IT_CODEX=1)", () => {
  it("plan 모드 세션에서 pong 응답과 turn.completed 를 받는다", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mam-codex-it-"));
    const adapter = new CodexAdapter({ dataDir: join(cwd, ".mam") });
    const probe = await adapter.probe();
    expect(probe.available).toBe(true);
    expect(probe.loggedIn).toBe(true);
    // 라이브 세션 없이 임시 app-server 로 한도·모델을 조회한다(값 형태만 로그).
    const usage = await adapter.usage();
    console.log(`[codex IT] usage plan=${usage.plan} live=${usage.live} limits=${JSON.stringify(usage.limits.map((l) => ({ id: l.id, windowMinutes: l.windowMinutes, usedPercent: l.usedPercent, resetsAt: l.resetsAt?.toISOString() ?? null, rejected: l.rejected })))}`);
    expect(usage.live).toBe(true);
    expect(usage.limits.length).toBeGreaterThanOrEqual(1);
    const models = await adapter.listModels();
    console.log(`[codex IT] models=${JSON.stringify(models.map((m) => ({ id: m.id, isDefault: m.isDefault, efforts: m.efforts, defaultEffort: m.defaultEffort })))}`);
    const def = models.find((m) => m.isDefault);
    expect(def).toBeDefined();
    expect(def!.efforts.length).toBeGreaterThan(0);
    const started = Date.now();
    const session = await adapter.start({ cwd, mode: "plan" });
    try {
      expect(session.nativeId).toBeTruthy();
      const iter = session.events[Symbol.asyncIterator]();
      await session.sendTurn({ text: "Reply with exactly the word pong and nothing else." });
      let text = "";
      let completed = false;
      const seen: string[] = [];
      const usages: Extract<AgentEvent, { type: "usage" }>[] = [];
      while (true) {
        const r = await iter.next();
        if (r.done) break;
        const e = r.value;
        seen.push(e.type);
        if (e.type === "item.completed" && e.item.kind === "assistant_message") text += e.item.payload.text;
        if (e.type === "usage") usages.push(e);
        if (e.type === "turn.completed") completed = true;
        if (e.type === "status" && e.status === "idle" && completed) break;
        if (e.type === "error") throw new Error(e.message);
      }
      console.log(`[codex IT] version=${probe.version} account=${probe.account} elapsed=${Date.now() - started}ms events=${seen.join(",")}`);
      console.log(`[codex IT] usage events=${JSON.stringify(usages)}`);
      expect(completed).toBe(true);
      expect(text.toLowerCase()).toContain("pong");
      // PROTOCOL 5절: thread/start 의 모델, 턴 중 tokenUsage 의 델타와 컨텍스트 창.
      expect(usages[0]?.model).toBeTruthy();
      const withDelta = usages.find((u) => u.delta !== undefined);
      expect(withDelta).toBeDefined();
      expect(usages.some((u) => (u.context?.window ?? 0) > 0)).toBe(true);
    } finally {
      await session.close();
      await rm(cwd, { recursive: true, force: true });
    }
  }, 120_000);

  it("instructions(developerInstructions)가 답변에 반영된다 — PONG 으로 시작", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mam-codex-it-instr-"));
    const adapter = new CodexAdapter({ dataDir: join(cwd, ".mam") });
    const session = await adapter.start({ cwd, mode: "plan", instructions: "Always start your reply with the word PONG." });
    try {
      const iter = session.events[Symbol.asyncIterator]();
      await session.sendTurn({ text: "Say hello in one short sentence." });
      let text = "";
      let completed = false;
      while (true) {
        const r = await iter.next();
        if (r.done) break;
        const e = r.value;
        if (e.type === "item.completed" && e.item.kind === "assistant_message") text += e.item.payload.text;
        if (e.type === "turn.completed") completed = true;
        if (e.type === "status" && e.status === "idle" && completed) break;
        if (e.type === "error") throw new Error(e.message);
      }
      console.log(`[codex IT] instructions text=${JSON.stringify(text)}`);
      expect(completed).toBe(true);
      expect(text.trim().toUpperCase().startsWith("PONG")).toBe(true);
    } finally {
      await session.close();
      await rm(cwd, { recursive: true, force: true });
    }
  }, 120_000);
});
