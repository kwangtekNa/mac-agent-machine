import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeAdapter } from "../../../src/agents/claude/adapter.js";
import type { AgentEvent } from "../../../src/agents/types.js";
import { RateLimitStore } from "../../../src/usage/rate-limit-store.js";

const enabled = process.env.MAM_IT_CLAUDE === "1";

// Claude Code 기본(default) 모드는 읽기 전용 명령(`echo pong` 등)을 승인 없이 자동 허용하므로, ask 와 full-auto 를
// 구분하려면 쓰기가 있는 명령이어야 한다(관측: 2026-09-13, `echo pong` 은 ask 에서도 승인 0건).
const BASH_PROMPT = "Use the Bash tool to run: echo pong > pong.txt && cat pong.txt. Then reply with only the cat output.";

/** 임시 cwd 는 `~/.mam/smoke/<ts>/` 아래(홈 안, 샌드박스 규칙). */
async function smokeCwd(name: string): Promise<string> {
  const dir = join(homedir(), ".mam", "smoke", String(Date.now()), name);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

interface BashRun { text: string; approvals: number; toolCalls: number; completed: boolean }

/** Bash 한 턴을 돌리고 승인 요청 수·tool_call 수·답변을 모은다. 승인 요청이 오면 allow 로 응답한다. */
async function runBashTurn(mode: "ask" | "full-auto", cwd: string): Promise<BashRun> {
  const logger = { info: () => undefined, warn: (m: string) => console.log("[it] warn", m), error: (m: string) => console.log("[it] error", m) };
  const adapter = new ClaudeAdapter({ extraOptions: { maxTurns: 4 }, settingSources: [], dataDir: join(cwd, ".mam"), logger });
  const s = await adapter.start({ cwd, mode });
  const run: BashRun = { text: "", approvals: 0, toolCalls: 0, completed: false };
  try {
    await s.sendTurn({ text: BASH_PROMPT });
    for await (const e of s.events) {
      if (e.type === "approval.requested") {
        run.approvals += 1;
        await s.respondApproval(e.approval.approvalId, "allow");
      }
      if (e.type === "item.completed" && e.item.kind === "tool_call") run.toolCalls += 1;
      if (e.type === "item.completed" && e.item.kind === "assistant_message") run.text += e.item.payload.text;
      if (e.type === "error") console.log("[it] error", e.message);
      if (e.type === "turn.completed") run.completed = true;
      if (e.type === "status" && e.status === "idle" && run.completed) break;
    }
  } finally {
    await s.close();
  }
  console.log(`[it] ${mode} approvals=${run.approvals} toolCalls=${run.toolCalls} text=${JSON.stringify(run.text)}`);
  return run;
}

describe.skipIf(!enabled)("ClaudeAdapter 통합(MAM_IT_CLAUDE=1)", () => {
  it("full-auto: Bash 실행에 approval.requested 0건, tool_call 아이템, pong 답변", { timeout: 120_000 }, async () => {
    const cwd = await smokeCwd("claude-full-auto");
    try {
      const run = await runBashTurn("full-auto", cwd);
      expect(run.completed).toBe(true);
      expect(run.approvals).toBe(0);
      expect(run.toolCalls).toBeGreaterThanOrEqual(1);
      expect(run.text.toLowerCase()).toContain("pong");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("ask: 같은 지시에 approval.requested 1건 이상", { timeout: 120_000 }, async () => {
    const cwd = await smokeCwd("claude-ask");
    try {
      const run = await runBashTurn("ask", cwd);
      expect(run.completed).toBe(true);
      expect(run.approvals).toBeGreaterThanOrEqual(1);
      expect(run.text.toLowerCase()).toContain("pong");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

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

  it("실제 SDK: instructions(systemPrompt append)가 답변에 반영된다 — PONG 으로 시작", { timeout: 120_000 }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mam-it-claude-instr-"));
    const dataDir = join(cwd, ".mam");
    const logger = { info: () => undefined, warn: (m: string) => console.log("[it] warn", m), error: (m: string) => console.log("[it] error", m) };
    const adapter = new ClaudeAdapter({ extraOptions: { maxTurns: 1, allowedTools: [] }, settingSources: [], dataDir, logger });
    const s = await adapter.start({ cwd, mode: "ask", instructions: "Always start your reply with the word PONG." });
    try {
      await s.sendTurn({ text: "Say hello in one short sentence." });
      let text = "";
      let completed = false;
      for await (const e of s.events) {
        if (e.type === "item.completed" && e.item.kind === "assistant_message") text += e.item.payload.text;
        if (e.type === "error") console.log("[it] error", e.message);
        if (e.type === "turn.completed") completed = true;
        if (e.type === "status" && e.status === "idle" && completed) break;
      }
      console.log(`[it] instructions text=${JSON.stringify(text)}`);
      expect(completed).toBe(true);
      expect(text.trim().toUpperCase().startsWith("PONG")).toBe(true);
    } finally {
      await s.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
