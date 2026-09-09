import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeAdapter } from "../../../src/agents/claude/adapter.js";
import type { AgentEvent } from "../../../src/agents/types.js";

const enabled = process.env.MAM_IT_CLAUDE === "1";

describe.skipIf(!enabled)("ClaudeAdapter 통합(MAM_IT_CLAUDE=1)", () => {
  it("실제 SDK: pong 응답과 turn.completed", { timeout: 120_000 }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mam-it-claude-"));
    const adapter = new ClaudeAdapter({ extraOptions: { maxTurns: 1, allowedTools: [] }, settingSources: [] });
    const probe = await adapter.probe();
    console.log("[it] probe", JSON.stringify(probe));
    const started = Date.now();
    const s = await adapter.start({ cwd, mode: "ask" });
    try {
      await s.sendTurn({ text: "Reply with exactly the word pong and nothing else." });
      let text = "";
      let completed: AgentEvent | undefined;
      for await (const e of s.events) {
        if (e.type === "item.completed" && e.item.kind === "assistant_message") text += (e.item.payload as { text: string }).text;
        if (e.type === "error") console.log("[it] error", e.message);
        if (e.type === "turn.completed") { completed = e; break; }
      }
      console.log(`[it] elapsed=${Date.now() - started}ms cost=${(completed as { costUsd?: number } | undefined)?.costUsd} text=${JSON.stringify(text)}`);
      expect(text.toLowerCase()).toContain("pong");
      expect(completed).toBeDefined();
    } finally {
      await s.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
