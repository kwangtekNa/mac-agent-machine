import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeAdapter } from "../../../src/agents/claude/adapter.js";
import type { AgentEvent } from "../../../src/agents/types.js";
import { RateLimitStore } from "../../../src/usage/rate-limit-store.js";

const enabled = process.env.MAM_IT_CLAUDE === "1";

describe.skipIf(!enabled)("ClaudeAdapter 통합(MAM_IT_CLAUDE=1)", () => {
  it("실제 SDK: pong 응답과 turn.completed", { timeout: 120_000 }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mam-it-claude-"));
    const dataDir = join(cwd, ".mam");
    // rate_limit 원본 값 형태를 관측하기 위해 info 로그를 모은다(토큰 없음).
    const lines: string[] = [];
    const logger = { info: (m: string) => { lines.push(String(m)); }, warn: (m: string) => { lines.push(String(m)); }, error: (m: string) => { lines.push(String(m)); } };
    const adapter = new ClaudeAdapter({ extraOptions: { maxTurns: 1, allowedTools: [] }, settingSources: [], dataDir, logger });
    const probe = await adapter.probe();
    console.log("[it] probe", JSON.stringify(probe));
    const started = Date.now();
    const s = await adapter.start({ cwd, mode: "ask" });
    try {
      await s.sendTurn({ text: "Reply with exactly the word pong and nothing else." });
      let text = "";
      let completed: AgentEvent | undefined;
      const usages: Extract<AgentEvent, { type: "usage" }>[] = [];
      for await (const e of s.events) {
        if (e.type === "item.completed" && e.item.kind === "assistant_message") text += (e.item.payload as { text: string }).text;
        if (e.type === "error") console.log("[it] error", e.message);
        if (e.type === "usage") usages.push(e);
        if (e.type === "turn.completed") completed = e;
        if (e.type === "status" && e.status === "idle" && completed) break;
      }
      console.log(`[it] elapsed=${Date.now() - started}ms cost=${(completed as { costUsd?: number } | undefined)?.costUsd} text=${JSON.stringify(text)}`);
      expect(text.toLowerCase()).toContain("pong");
      expect(completed).toBeDefined();
      // 사용량(PROTOCOL 5절): init 의 model, 턴 끝의 delta·context.
      console.log("[it] usage events", JSON.stringify(usages));
      expect(usages[0]?.model).toBeTruthy();
      const turnEnd = usages.find((u) => u.delta !== undefined);
      expect(turnEnd).toBeDefined();
      expect(turnEnd!.delta!.inputTokens).toBeGreaterThan(0);
      expect(turnEnd!.context?.window ?? 0).toBeGreaterThan(0);
      // 모델 목록: 라이브 세션의 supportedModels (형태만 로그).
      const models = await adapter.listModels();
      console.log("[it] models", JSON.stringify(models.slice(0, 3)));
      expect(models.length).toBeGreaterThan(0);
      await s.close();
      // 구독 한도: rate_limit_event 가 관측됐으면 저장소에 있어야 한다. 아니면 skip 로그.
      const rl = lines.filter((l) => l.includes("rate_limit"));
      console.log("[it] rate_limit raw", JSON.stringify(rl));
      console.log("[it] account", JSON.stringify(lines.filter((l) => l.includes("account"))));
      const stored = await new RateLimitStore(dataDir).load("claude");
      console.log("[it] usage()", JSON.stringify(await adapter.usage()));
      if (rl.length > 0) {
        expect(stored?.limits.length ?? 0).toBeGreaterThan(0);
      } else {
        console.log("[it] skip: rate_limit_event 관측 안 됨");
      }
    } finally {
      await s.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
