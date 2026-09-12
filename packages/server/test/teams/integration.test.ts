import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentKind, RoomMessage, RoomServerEvent } from "@mam/protocol";
import { describe, expect, it } from "vitest";
import { ClaudeAdapter } from "../../src/agents/claude/adapter.js";
import { CodexAdapter } from "../../src/agents/codex/adapter.js";
import type { AgentAdapter } from "../../src/agents/types.js";
import { SessionManager } from "../../src/sessions/manager.js";
import { TeamManager } from "../../src/teams/team-manager.js";
import { git, initRepo } from "../helpers/tmp-home.js";

/**
 * 실제 CLI 로 팀장 1명 팀을 돌리는 스모크(게이트 제외). `MAM_IT_CLAUDE=1` / `MAM_IT_CODEX=1` 일 때만 실행한다.
 * 한 턴("pong")이면 충분하고 비용은 수 센트다. full-auto 나 파일을 바꾸는 지시는 보내지 않는다.
 * 승인 요청이 오면(도구를 쓰려 하면) 거절해 턴이 멈추지 않게 한다.
 */
const CLAUDE = process.env.MAM_IT_CLAUDE === "1";
const CODEX = process.env.MAM_IT_CODEX === "1";
const PROMPT = "Reply with exactly the word pong.";
const ROLE_PROMPT = "You answer questions in plain text only. Never use tools, never read or write files.";
const TURN_TIMEOUT_MS = 120_000;

const logger = { info: () => undefined, warn: (m: string) => console.log("[it] warn", m), error: (m: string) => console.log("[it] error", m) };

/** 임시 홈 + git 저장소(커밋 1개) + 실제 어댑터로 팀장 1명 팀을 만들고, 그룹방 pong 에 대한 팀장 답변을 돌려준다. */
async function runPong(agent: AgentKind, mode: "ask" | "plan", makeAdapter: (dataDir: string) => AgentAdapter): Promise<RoomMessage> {
  const tmp = await mkdtemp(join(tmpdir(), "mam-teams-it-"));
  const home = await realpath(tmp);
  const dataDir = join(home, ".mam");
  const repo = join(home, "work", "app");
  await initRepo(repo);
  await writeFile(join(repo, "README.md"), "# it\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-q", "-m", "init");
  const manager = await SessionManager.open({ dataDir, adapters: { [agent]: makeAdapter(dataDir) }, logger });
  const teams = await TeamManager.open({ dataDir, home, manager, logger });
  try {
    const team = await teams.createTeam({
      cwd: repo,
      name: "it",
      members: [{ name: "리드", handle: "lead", role: "custom", roleLabel: "리드", agent, prompt: ROLE_PROMPT, mode, isLead: true }],
    });
    const group = team.rooms.find((r) => r.kind === "group")!;
    const started = Date.now();
    const reply = new Promise<RoomMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("팀장 답변을 받지 못함")), TURN_TIMEOUT_MS);
      const listener = (event: RoomServerEvent): void => {
        if (event.type !== "room.message") return;
        const { message } = event;
        if (message.kind === "approval" && message.approval) {
          const { sessionId, approval } = message.approval;
          console.log(`[it] approval ${approval.kind} '${approval.title}' → deny`);
          void manager.respondApproval(sessionId, approval.approvalId, "deny").catch(() => undefined);
        } else if (message.kind === "system") {
          console.log(`[it] system: ${message.text}`);
        } else if (message.kind === "text" && message.author.kind === "agent") {
          clearTimeout(timer);
          resolve(message);
        }
      };
      void teams.subscribeRoom(team.id, group.id, 0, listener).then(() => teams.postUserMessage(team.id, group.id, { text: PROMPT }), reject);
    });
    const message = await reply;
    console.log(`[it] ${agent} elapsed=${Date.now() - started}ms text=${JSON.stringify(message.text)} work=${JSON.stringify(message.work)}`);
    await teams.deleteTeam(team.id, { keepWorktrees: true }).catch(() => undefined);
    return message;
  } finally {
    await teams.shutdown().catch(() => undefined);
    await manager.shutdown().catch(() => undefined);
    await rm(tmp, { recursive: true, force: true });
  }
}

function expectPong(message: RoomMessage): void {
  expect(message.text.toLowerCase()).toContain("pong");
  expect(message.hop).toBe(1);
  expect(message.work).not.toBeNull();
  expect(typeof message.work!.toolCalls).toBe("number");
  expect(message.work!.durationMs).toBeGreaterThanOrEqual(0);
}

describe.skipIf(!CLAUDE)("teams 통합: Claude 팀장(MAM_IT_CLAUDE=1)", () => {
  it("그룹방 pong → 팀장 답변에 work 가 붙는다", { timeout: TURN_TIMEOUT_MS + 30_000 }, async () => {
    const message = await runPong("claude", "ask", (dataDir) =>
      new ClaudeAdapter({ extraOptions: { maxTurns: 1, allowedTools: [] }, settingSources: [], dataDir, logger }),
    );
    expectPong(message);
  });
});

describe.skipIf(!CODEX)("teams 통합: Codex 팀장(MAM_IT_CODEX=1)", () => {
  it("그룹방 pong → 팀장 답변에 work 가 붙는다", { timeout: TURN_TIMEOUT_MS + 30_000 }, async () => {
    const message = await runPong("codex", "plan", (dataDir) => new CodexAdapter({ dataDir }));
    expectPong(message);
  });
});
