import type { TimelineItem, WorkSummary } from "@mam/protocol";

/**
 * 턴의 타임라인 아이템에서 방에 게시할 답변과 작업 요약을 뽑는다(PROTOCOL 6.4 "답변 게시").
 * 텍스트는 그대로 돌려준다(요약·수정 없음).
 */

/** 해당 턴의 완료된 `assistant_message` 중 본문이 비어 있지 않은 마지막 것(`phase: final` 우선). 없으면 null. */
export function extractReply(items: TimelineItem[], turnId: string): string | null {
  let lastFinal: string | null = null;
  let last: string | null = null;
  for (const item of items) {
    if (item.turnId !== turnId || item.kind !== "assistant_message" || item.status !== "completed") continue;
    if (item.payload.text.trim() === "") continue;
    last = item.payload.text;
    if (item.payload.phase === "final") lastFinal = item.payload.text;
  }
  return lastFinal ?? last;
}

/** `tool_call` 수, `file_change.files[].path` 합집합(정렬), 마지막 `turn_summary` 의 durationMs/usage/costUsd(없으면 0). */
export function summarizeWork(items: TimelineItem[], turnId: string): Omit<WorkSummary, "sessionId" | "turnId"> {
  let toolCalls = 0;
  const paths = new Set<string>();
  let summary: Extract<TimelineItem, { kind: "turn_summary" }>["payload"] | null = null;
  for (const item of items) {
    if (item.turnId !== turnId) continue;
    if (item.kind === "tool_call") toolCalls += 1;
    else if (item.kind === "file_change") for (const f of item.payload.files) paths.add(f.path);
    else if (item.kind === "turn_summary") summary = item.payload;
  }
  const work: Omit<WorkSummary, "sessionId" | "turnId"> = {
    toolCalls,
    filesChanged: [...paths].sort(),
    durationMs: summary?.durationMs ?? 0,
    usage: summary ? { ...summary.usage } : { inputTokens: 0, outputTokens: 0 },
  };
  if (summary?.costUsd !== undefined) work.costUsd = summary.costUsd;
  return work;
}
