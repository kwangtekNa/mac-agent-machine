import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WorkSummarySchema, type TimelineItem } from "@mam/protocol";
import { describe, expect, it } from "vitest";
import { extractReply, summarizeWork } from "../../src/teams/summary.js";

const FIXTURE = fileURLToPath(new URL("../../../protocol/fixtures/rest/session-detail.json", import.meta.url));
const detail = JSON.parse(readFileSync(FIXTURE, "utf8")) as { items: TimelineItem[] };
const TURN = "trn_01J8ZQ4K5N7P9R3S6T8V0W2XC1";
const OTHER = "trn_01J8ZQ4K5N7P9R3S6T8V0W2XC2";

let n = 100;
function item<K extends TimelineItem["kind"]>(kind: K, payload: Extract<TimelineItem, { kind: K }>["payload"], over: Partial<TimelineItem> = {}): TimelineItem {
  n += 1;
  return {
    id: `itm_01J8ZQ4K5N7P9R3S6T8V0W2X${String(n).slice(-3)}`,
    seq: n,
    turnId: TURN,
    kind,
    status: "completed",
    createdAt: "2026-09-12T09:10:00Z",
    completedAt: "2026-09-12T09:10:01Z",
    payload,
    ...over,
  } as TimelineItem;
}

describe("extractReply", () => {
  it("returns the last final assistant message of the turn from the fixture", () => {
    expect(extractReply(detail.items, TURN)).toBe("테스트가 통과했습니다.");
  });

  it("prefers final over a later commentary and ignores other turns", () => {
    const items = [
      item("assistant_message", { text: "다른 턴", phase: "final" }, { turnId: OTHER }),
      item("assistant_message", { text: "최종 답", phase: "final" }),
      item("assistant_message", { text: "덧붙임", phase: "commentary" }),
    ];
    expect(extractReply(items, TURN)).toBe("최종 답");
    expect(extractReply(items, OTHER)).toBe("다른 턴");
  });

  it("falls back to the last completed assistant message when there is no final", () => {
    const items = [
      item("assistant_message", { text: "첫 코멘트", phase: "commentary" }),
      item("assistant_message", { text: "마지막 코멘트", phase: "commentary" }),
    ];
    expect(extractReply(items, TURN)).toBe("마지막 코멘트");
  });

  it("skips streaming (running) and failed messages", () => {
    const items = [
      item("assistant_message", { text: "완료된 것", phase: "commentary" }),
      item("assistant_message", { text: "아직 스트리밍", phase: "final" }, { status: "running", completedAt: null }),
      item("assistant_message", { text: "실패", phase: "final" }, { status: "failed" }),
    ];
    expect(extractReply(items, TURN)).toBe("완료된 것");
  });

  it("returns null for empty replies and unknown turns", () => {
    expect(extractReply([item("assistant_message", { text: "   \n", phase: "final" })], TURN)).toBeNull();
    expect(extractReply(detail.items, OTHER)).toBeNull();
    expect(extractReply([], TURN)).toBeNull();
    expect(extractReply([item("assistant_message", { text: "", phase: "final" }), item("assistant_message", { text: "본문", phase: "commentary" })], TURN)).toBe("본문");
  });

  it("returns the text verbatim without trimming or rewriting", () => {
    expect(extractReply([item("assistant_message", { text: "  # 제목\n\n본문  \n", phase: "final" })], TURN)).toBe("  # 제목\n\n본문  \n");
  });
});

describe("summarizeWork", () => {
  it("counts tool calls, collects file paths and copies the turn summary from the fixture", () => {
    const work = summarizeWork(detail.items, TURN);
    expect(work).toEqual({
      toolCalls: 1,
      filesChanged: ["src/login.ts"],
      durationMs: 30412,
      usage: { inputTokens: 18420, outputTokens: 1275, cacheReadTokens: 16000 },
      costUsd: 0.12,
    });
    expect(WorkSummarySchema.safeParse({ ...work, sessionId: "ses_01J8ZQ4K5N7P9R3S6T8V0W2XS1", turnId: TURN }).success).toBe(true);
  });

  it("unions and sorts file paths across file_change items and ignores other turns", () => {
    const items = [
      item("file_change", { files: [{ path: "src/b.ts", kind: "modify", additions: 1, deletions: 0 }, { path: "src/a.ts", kind: "add", additions: 5, deletions: 0 }], patch: "" }),
      item("file_change", { files: [{ path: "src/a.ts", kind: "modify", additions: 1, deletions: 1 }, { path: "docs/한글.md", kind: "add", additions: 2, deletions: 0 }], patch: "" }),
      item("file_change", { files: [{ path: "other/turn.ts", kind: "add", additions: 1, deletions: 0 }], patch: "" }, { turnId: OTHER }),
      item("tool_call", { tool: "bash", name: "Bash", title: "ls", input: {}, output: "", exitCode: 0, truncated: false }),
      item("tool_call", { tool: "edit", name: "Edit", title: "a.ts", input: {}, output: "", exitCode: null, truncated: false }, { status: "cancelled" }),
      item("tool_call", { tool: "read", name: "Read", title: "x", input: {}, output: "", exitCode: null, truncated: false }, { turnId: OTHER }),
      item("turn_summary", { durationMs: 10, usage: { inputTokens: 1, outputTokens: 2 }, stopReason: "end_turn" }),
    ];
    expect(summarizeWork(items, TURN)).toEqual({
      toolCalls: 2,
      filesChanged: ["docs/한글.md", "src/a.ts", "src/b.ts"],
      durationMs: 10,
      usage: { inputTokens: 1, outputTokens: 2 },
    });
    expect("costUsd" in summarizeWork(items, TURN)).toBe(false);
  });

  it("uses zero duration and usage when there is no turn_summary", () => {
    const items = [item("assistant_message", { text: "답", phase: "final" })];
    expect(summarizeWork(items, TURN)).toEqual({ toolCalls: 0, filesChanged: [], durationMs: 0, usage: { inputTokens: 0, outputTokens: 0 } });
    expect(summarizeWork([], TURN)).toEqual({ toolCalls: 0, filesChanged: [], durationMs: 0, usage: { inputTokens: 0, outputTokens: 0 } });
  });

  it("takes the last turn_summary when several exist", () => {
    const items = [
      item("turn_summary", { durationMs: 1, usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0.01, stopReason: "end_turn" }),
      item("turn_summary", { durationMs: 2, usage: { inputTokens: 2, outputTokens: 2 }, stopReason: "end_turn" }),
    ];
    expect(summarizeWork(items, TURN)).toEqual({ toolCalls: 0, filesChanged: [], durationMs: 2, usage: { inputTokens: 2, outputTokens: 2 } });
  });
});
