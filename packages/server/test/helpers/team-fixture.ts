import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Approval, MemberInput } from "@mam/protocol";
import { FakeAdapter, type FakeScript } from "../../src/agents/fake/index.js";
import { newId } from "../../src/ids.js";
import { SessionManager } from "../../src/sessions/manager.js";
import { TeamManager } from "../../src/teams/team-manager.js";
import { git, initRepo, makeTmpHome, removeTmp } from "./tmp-home.js";

/**
 * agent-host 팀 라우트·방 WS 테스트용 픽스처: 임시 홈 + `work/app`(git, 커밋 1개) + `work/lib`(git 아님) +
 * Fake 어댑터(claude/codex) + SessionManager + TeamManager. 어댑터 스크립트는 트리거 줄(뒤에서 세 번째 줄)로 동작한다:
 * "approve" → 승인 요청 후 응답 대기, "wait" → interrupt 될 때까지 대기, "write" → `<cwd>/out.txt` 를 쓰고 file_change.
 * 답변은 트리거 줄을 되돌리되 `@` 는 지운다(답변 멘션으로 연쇄가 생기지 않게).
 */
export const teamScript: FakeScript = async (ctx) => {
  const { input, turnId } = ctx;
  const lines = input.text.split("\n");
  const trigger = lines.length >= 3 ? lines[lines.length - 3]! : input.text;
  const emitItem = (kind: string, payload: unknown): void => {
    const at = ctx.now();
    ctx.emit({
      type: "item.started",
      item: { id: newId("itm"), turnId, kind, status: "completed", createdAt: at, completedAt: at, payload } as never,
    });
  };
  emitItem("user_message", { text: input.text, attachments: input.attachments ?? [] });
  if (trigger.includes("wait")) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 10_000);
      ctx.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(Object.assign(new Error("interrupted"), { name: "AbortError" }));
        },
        { once: true },
      );
    });
  }
  if (trigger.includes("approve")) {
    const approval: Approval = {
      approvalId: newId("apr"),
      itemId: newId("itm"),
      kind: "command",
      title: "npm test 실행",
      prompt: "run npm test",
      detail: null,
      diff: null,
      options: [
        { id: "allow", label: "허용", style: "primary" },
        { id: "deny", label: "거절", style: "destructive" },
      ],
      inputFields: [],
      requestedAt: ctx.now(),
    };
    ctx.emit({ type: "approval.requested", approval });
    await ctx.requestApproval(approval);
  }
  emitItem("tool_call", { tool: "bash", name: "Bash", title: "echo", input: {}, output: "ok\n", exitCode: 0, truncated: false });
  if (trigger.includes("write")) {
    await writeFile(join(ctx.cwd, "out.txt"), `${turnId}\n`);
    emitItem("file_change", { files: [{ path: "out.txt", kind: "add", additions: 1, deletions: 0 }], patch: "" });
  }
  emitItem("assistant_message", { text: `완료했습니다: ${trigger.replaceAll("@", "")}`, phase: "final" });
  const summary = { durationMs: 5, usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.001, stopReason: "end_turn" };
  emitItem("turn_summary", summary);
  ctx.emit({ type: "turn.completed", turnId, ...summary });
  ctx.emit({ type: "status", status: "idle" });
};

export const TEAM_MEMBERS: MemberInput[] = [
  { name: "민수", handle: "minsu", role: "team-lead", agent: "claude", isLead: true },
  { name: "지연", handle: "jiyeon", role: "developer", agent: "codex" },
];

export interface TeamFixture {
  tmp: string;
  home: string;
  dataDir: string;
  workspaceRoot: string;
  /** git 저장소(커밋 1개, `main`). */
  repo: string;
  /** git 저장소가 아닌 디렉토리. */
  lib: string;
  claude: FakeAdapter;
  codex: FakeAdapter;
  manager: SessionManager;
  teams: TeamManager;
  cleanup(): Promise<void>;
}

const silent = { info() {}, warn() {}, error() {} };

export async function makeTeamFixture(): Promise<TeamFixture> {
  const tmp = await makeTmpHome("mam-teams-");
  const home = await realpath(tmp);
  const dataDir = join(home, ".mam");
  const workspaceRoot = join(home, "work");
  const repo = join(workspaceRoot, "app");
  const lib = join(workspaceRoot, "lib");
  await initRepo(repo);
  await writeFile(join(repo, "a.txt"), "hello\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "init");
  await mkdir(lib, { recursive: true });
  const claude = new FakeAdapter({ kind: "claude", script: teamScript });
  const codex = new FakeAdapter({ kind: "codex", script: teamScript });
  const manager = await SessionManager.open({ dataDir, adapters: { claude, codex }, logger: silent });
  const teams = await TeamManager.open({ dataDir, home, manager, logger: silent });
  return {
    tmp,
    home,
    dataDir,
    workspaceRoot,
    repo,
    lib,
    claude,
    codex,
    manager,
    teams,
    cleanup: async () => {
      // 백그라운드 저장이 임시 디렉토리 삭제와 경합하지 않게 teams → manager 순서로 먼저 닫는다.
      await teams.shutdown().catch(() => undefined);
      await manager.shutdown().catch(() => undefined);
      await removeTmp(tmp);
    },
  };
}

export async function waitUntil(pred: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}
