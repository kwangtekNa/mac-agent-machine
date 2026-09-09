import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAdapter } from "../../../src/agents/codex/adapter.js";

const IT = process.env.MAM_IT_CODEX === "1";

/** 실제 `codex app-server` 스모크. `MAM_IT_CODEX=1` 일 때만 실행한다(게이트 제외). */
describe.skipIf(!IT)("codex integration (MAM_IT_CODEX=1)", () => {
  it("plan 모드 세션에서 pong 응답과 turn.completed 를 받는다", async () => {
    const adapter = new CodexAdapter();
    const probe = await adapter.probe();
    expect(probe.available).toBe(true);
    expect(probe.loggedIn).toBe(true);
    const cwd = await mkdtemp(join(tmpdir(), "mam-codex-it-"));
    const started = Date.now();
    const session = await adapter.start({ cwd, mode: "plan" });
    try {
      expect(session.nativeId).toBeTruthy();
      const iter = session.events[Symbol.asyncIterator]();
      await session.sendTurn({ text: "Reply with exactly the word pong and nothing else." });
      let text = "";
      let completed = false;
      const seen: string[] = [];
      while (!completed) {
        const r = await iter.next();
        if (r.done) break;
        const e = r.value;
        seen.push(e.type);
        if (e.type === "item.completed" && e.item.kind === "assistant_message") text += e.item.payload.text;
        if (e.type === "turn.completed") completed = true;
        if (e.type === "error") throw new Error(e.message);
      }
      console.log(`[codex IT] version=${probe.version} account=${probe.account} elapsed=${Date.now() - started}ms events=${seen.join(",")}`);
      expect(completed).toBe(true);
      expect(text.toLowerCase()).toContain("pong");
    } finally {
      await session.close();
      await rm(cwd, { recursive: true, force: true });
    }
  }, 120_000);
});
