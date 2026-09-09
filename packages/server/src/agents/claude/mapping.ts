import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Approval } from "@mam/protocol";
import { newId } from "../../ids.js";
import type { AgentEvent, ItemDraft } from "../types.js";

type ToolCallItem = Extract<ItemDraft, { kind: "tool_call" }>;
export type ToolKind = ToolCallItem["payload"]["tool"];
type FileChangeItem = Extract<ItemDraft, { kind: "file_change" }>;
export type FileChangePayload = FileChangeItem["payload"];
type FileChangeEntry = FileChangePayload["files"][number];
export type ApprovalKind = Approval["kind"];

export const OUTPUT_LIMIT = 64 * 1024;
const TITLE_LIMIT = 120;
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const LOGIN_PATTERN = /log ?in|authenticat|credential|api key|oauth|unauthorized|token|setup-token/i;

interface TextBlock { type: "text"; text: string }
interface ThinkingBlock { type: "thinking"; thinking: string }
interface ToolUseBlock { type: "tool_use"; id: string; name: string; input: unknown }
interface ToolResultBlock { type: "tool_result"; tool_use_id: string; content?: unknown; is_error?: boolean }
type AnyBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | { type: string };
type StreamEvent =
  | { type: "message_start" }
  | { type: "content_block_start"; index: number; content_block: AnyBlock }
  | { type: "content_block_delta"; index: number; delta: { type: "text_delta"; text: string } | { type: "thinking_delta"; thinking: string } | { type: string } }
  | { type: string };

export function toolKindFor(name: string): ToolKind {
  if (name.startsWith("mcp__")) return "mcp";
  switch (name) {
    case "Bash": return "bash";
    case "Read": return "read";
    case "Write": return "write";
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit": return "edit";
    case "Glob": return "glob";
    case "Grep": return "grep";
    case "WebFetch":
    case "WebSearch": return "web";
    case "Task":
    case "Agent": return "task";
    default: return "other";
  }
}

export function isFileTool(name: string): boolean {
  return FILE_TOOLS.has(name);
}

export function approvalKindFor(name: string): ApprovalKind {
  if (name === "Bash") return "command";
  if (isFileTool(name)) return "file_change";
  return "permission";
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function toolTitle(name: string, input: unknown): string {
  const rec = asRecord(input);
  if (name === "Bash") {
    const command = str(rec.command) ?? "";
    return command.length > TITLE_LIMIT ? command.slice(0, TITLE_LIMIT) : command || name;
  }
  const path = str(rec.file_path) ?? str(rec.notebook_path);
  if (path && (isFileTool(name) || name === "Read")) return path;
  return name;
}

export function relativePath(path: string, cwd: string): string {
  const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.replace(/\n$/, "").split("\n");
}

interface Hunk { text: string; additions: number; deletions: number }

/** 줄 단위 단순 diff: 공통 접두/접미를 제외한 가운데를 -/+ 로 낸다. */
function hunk(oldText: string, newText: string): Hunk {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const before = a.slice(Math.max(0, p - 3), p);
  const removed = a.slice(p, a.length - s);
  const added = b.slice(p, b.length - s);
  const after = a.slice(a.length - s, a.length - s + 3);
  const start = Math.max(1, p - before.length + 1);
  const oldCount = before.length + removed.length + after.length;
  const newCount = before.length + added.length + after.length;
  const lines = [
    `@@ -${start},${oldCount} +${start},${newCount} @@`,
    ...before.map((l) => ` ${l}`),
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
    ...after.map((l) => ` ${l}`),
  ];
  return { text: `${lines.join("\n")}\n`, additions: added.length, deletions: removed.length };
}

/** Edit/Write/MultiEdit/NotebookEdit 입력으로 unified diff 를 만든다. 파일은 읽지 않는다. */
export function buildFilePatch(name: string, input: unknown, cwd: string): FileChangePayload | null {
  const rec = asRecord(input);
  const path = str(rec.file_path) ?? str(rec.notebook_path);
  if (!path || !isFileTool(name)) return null;
  const rel = relativePath(path, cwd);
  const hunks: Hunk[] = [];
  let kind: FileChangeEntry["kind"] = "modify";
  if (name === "Write") {
    kind = "add";
    hunks.push(hunk("", str(rec.content) ?? ""));
  } else if (name === "Edit") {
    hunks.push(hunk(str(rec.old_string) ?? "", str(rec.new_string) ?? ""));
  } else if (name === "MultiEdit") {
    const edits = Array.isArray(rec.edits) ? rec.edits : [];
    for (const edit of edits) {
      const e = asRecord(edit);
      hunks.push(hunk(str(e.old_string) ?? "", str(e.new_string) ?? ""));
    }
  } else {
    hunks.push(hunk("", str(rec.new_source) ?? ""));
  }
  const header = `diff --git a/${rel} b/${rel}\n--- ${kind === "add" ? "/dev/null" : `a/${rel}`}\n+++ b/${rel}\n`;
  const additions = hunks.reduce((n, h) => n + h.additions, 0);
  const deletions = hunks.reduce((n, h) => n + h.deletions, 0);
  return { files: [{ path: rel, kind, additions, deletions }], patch: header + hunks.map((h) => h.text).join("") };
}

export function stringifyToolResult(content: unknown): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const b = asRecord(block);
        if (b.type === "text" && typeof b.text === "string") return b.text;
        if (b.type === "image") return "[image]";
        return JSON.stringify(block);
      })
      .join("\n");
  }
  return JSON.stringify(content);
}

export function truncateOutput(text: string): { output: string; truncated: boolean } {
  if (text.length <= OUTPUT_LIMIT) return { output: text, truncated: false };
  return { output: text.slice(0, OUTPUT_LIMIT), truncated: true };
}

export function isLoginError(message: string): boolean {
  return LOGIN_PATTERN.test(message);
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

export interface MapperOptions {
  cwd: string;
  now?: () => string;
  logger?: Pick<Console, "info" | "warn">;
}

interface ToolState { itemId: string; fileChangeId?: string }

/** SDKMessage → AgentEvent[]. seq 는 만들지 않는다(CRITICAL 7). 상태: 현재 턴, 열린 아이템, 스트림 블록 인덱스, tool_use 매핑. */
export class ClaudeEventMapper {
  private turnId: string | null = null;
  private readonly open = new Map<string, ItemDraft>();
  private readonly streamBlocks = new Map<number, string>();
  private readonly pendingText: string[] = [];
  private readonly pendingThinking: string[] = [];
  private readonly tools = new Map<string, ToolState>();
  private readonly now: () => string;
  private readonly logger: Pick<Console, "info" | "warn">;

  constructor(private readonly opts: MapperOptions) {
    this.now = opts.now ?? (() => new Date().toISOString());
    this.logger = opts.logger ?? console;
  }

  get currentTurnId(): string | null {
    return this.turnId;
  }

  beginTurn(turnId: string): void {
    this.turnId = turnId;
  }

  map(msg: SDKMessage): AgentEvent[] {
    switch (msg.type) {
      case "system":
        return this.mapSystem(msg);
      case "stream_event":
        return msg.parent_tool_use_id ? [] : this.mapStream(msg.event as unknown as StreamEvent);
      case "assistant":
        return msg.parent_tool_use_id ? [] : this.mapAssistant(msg.message.content as unknown as AnyBlock[]);
      case "user":
        return msg.parent_tool_use_id ? [] : this.mapUser(msg.message.content);
      case "result":
        return this.mapResult(msg);
      case "auth_status":
        return [
          this.completedItem("system", { text: msg.error ? `인증 오류: ${msg.error}` : msg.isAuthenticating ? "Claude 인증 진행 중" : "Claude 인증 완료" }),
        ];
      default:
        this.logger.info(`[claude] ignored message type=${msg.type}`);
        return [];
    }
  }

  /** 열린 아이템을 전부 `cancelled` 로 닫고 상태를 비운다(중단/강제 종료). */
  cancelOpen(): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const item of this.open.values()) events.push(this.finish(item, "cancelled"));
    this.reset();
    return events;
  }

  private reset(): void {
    this.open.clear();
    this.streamBlocks.clear();
    this.pendingText.length = 0;
    this.pendingThinking.length = 0;
    this.tools.clear();
  }

  private mapSystem(msg: Extract<SDKMessage, { type: "system" }>): AgentEvent[] {
    switch (msg.subtype) {
      case "init":
        this.logger.info(`[claude] init model=${msg.model} permissionMode=${msg.permissionMode}`);
        return [
          { type: "native_id", nativeId: msg.session_id },
          { type: "status", status: "idle" },
        ];
      case "compact_boundary":
        return [this.completedItem("system", { text: `컨텍스트가 압축되었습니다 (${msg.compact_metadata.trigger === "auto" ? "자동" : "수동"})` })];
      case "permission_denied":
        return [this.completedItem("system", { text: `도구 사용이 거부되었습니다: ${msg.tool_name}` })];
      case "api_retry":
        return [this.completedItem("system", { text: `API 재시도 중 (${msg.attempt}/${msg.max_retries})` })];
      default:
        this.logger.info(`[claude] ignored system subtype=${msg.subtype}`);
        return [];
    }
  }

  private mapStream(event: StreamEvent): AgentEvent[] {
    if (event.type === "message_start") {
      this.streamBlocks.clear();
      return [];
    }
    if (event.type === "content_block_start") {
      const { index, content_block: block } = event as Extract<StreamEvent, { type: "content_block_start" }>;
      if (block.type === "text") {
        const item = this.runningItem("assistant_message", { text: "", phase: "final" });
        this.streamBlocks.set(index, item.id);
        this.pendingText.push(item.id);
        return [this.start(item)];
      }
      if (block.type === "thinking") {
        const item = this.runningItem("reasoning", { text: "" });
        this.streamBlocks.set(index, item.id);
        this.pendingThinking.push(item.id);
        return [this.start(item)];
      }
      if (block.type === "tool_use") {
        const tool = block as ToolUseBlock;
        const item = this.runningItem("tool_call", { tool: toolKindFor(tool.name), name: tool.name, title: toolTitle(tool.name, {}), input: {}, output: "", exitCode: null, truncated: false });
        this.streamBlocks.set(index, item.id);
        this.tools.set(tool.id, { itemId: item.id });
        return [this.start(item)];
      }
      return [];
    }
    if (event.type === "content_block_delta") {
      const { index, delta } = event as Extract<StreamEvent, { type: "content_block_delta" }>;
      const itemId = this.streamBlocks.get(index);
      if (!itemId) return [];
      if (delta.type === "text_delta") return [{ type: "item.delta", itemId, field: "text", delta: (delta as { text: string }).text }];
      if (delta.type === "thinking_delta") return [{ type: "item.delta", itemId, field: "text", delta: (delta as { thinking: string }).thinking }];
      return [];
    }
    return [];
  }

  private mapAssistant(blocks: AnyBlock[]): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const block of blocks) {
      if (block.type === "text") {
        const id = this.pendingText.shift();
        const item = (id && this.open.get(id)) || this.runningItem("assistant_message", { text: "", phase: "final" });
        events.push(this.finish(item, "completed", { text: (block as TextBlock).text }));
      } else if (block.type === "thinking") {
        const id = this.pendingThinking.shift();
        const item = (id && this.open.get(id)) || this.runningItem("reasoning", { text: "" });
        events.push(this.finish(item, "completed", { text: (block as ThinkingBlock).thinking }));
      } else if (block.type === "tool_use") {
        const tool = block as ToolUseBlock;
        const input = asRecord(tool.input);
        const state = this.tools.get(tool.id);
        const existing = state && this.open.get(state.itemId);
        const payload = { tool: toolKindFor(tool.name), name: tool.name, title: toolTitle(tool.name, input), input, output: "", exitCode: null, truncated: false };
        let item: ItemDraft;
        if (existing) {
          item = { ...existing, payload } as ItemDraft;
          this.open.set(item.id, item);
          events.push({ type: "item.completed", item });
        } else {
          item = this.runningItem("tool_call", payload);
          events.push(this.start(item));
        }
        const toolState: ToolState = { itemId: item.id };
        const patch = buildFilePatch(tool.name, input, this.opts.cwd);
        if (patch) {
          const change = this.runningItem("file_change", patch);
          toolState.fileChangeId = change.id;
          events.push(this.start(change));
        }
        this.tools.set(tool.id, toolState);
      }
    }
    return events;
  }

  private mapUser(content: unknown): AgentEvent[] {
    if (!Array.isArray(content)) return [];
    const events: AgentEvent[] = [];
    for (const raw of content as AnyBlock[]) {
      if (raw.type !== "tool_result") continue;
      const block = raw as ToolResultBlock;
      const state = this.tools.get(block.tool_use_id);
      if (!state) continue;
      this.tools.delete(block.tool_use_id);
      const status = block.is_error ? "failed" : "completed";
      const tool = this.open.get(state.itemId);
      if (tool) {
        const { output, truncated } = truncateOutput(stringifyToolResult(block.content));
        events.push(this.finish(tool, status, { output, truncated }));
      }
      const change = state.fileChangeId ? this.open.get(state.fileChangeId) : undefined;
      if (change) events.push(this.finish(change, status));
    }
    return events;
  }

  private mapResult(msg: Extract<SDKMessage, { type: "result" }>): AgentEvent[] {
    const events: AgentEvent[] = this.cancelOpen();
    const turnId = this.turnId ?? newId("trn");
    const usage = {
      inputTokens: int(msg.usage?.input_tokens),
      outputTokens: int(msg.usage?.output_tokens),
      cacheReadTokens: int(msg.usage?.cache_read_input_tokens),
    };
    const durationMs = int(msg.duration_ms);
    const stopReason = msg.stop_reason ?? msg.subtype;
    const costUsd = typeof msg.total_cost_usd === "number" && msg.total_cost_usd >= 0 ? msg.total_cost_usd : undefined;
    events.push(this.completedItem("turn_summary", { durationMs, usage, ...(costUsd !== undefined ? { costUsd } : {}), stopReason }, turnId));
    if (msg.is_error) {
      const errors = (msg as { errors?: unknown }).errors;
      let message =
        (msg.subtype === "success" ? msg.result : undefined) ||
        (Array.isArray(errors) ? errors.map(String).join("\n") : undefined) ||
        msg.subtype;
      if (isLoginError(message)) message = `Claude 로그인이 필요합니다: ${message}`;
      events.push(this.completedItem("error", { message, recoverable: true }, turnId));
      events.push({ type: "error", message, recoverable: true });
    }
    events.push({ type: "turn.completed", turnId, durationMs, usage, ...(costUsd !== undefined ? { costUsd } : {}), stopReason });
    events.push({ type: "status", status: "idle" });
    this.turnId = null;
    return events;
  }

  private runningItem(kind: ItemDraft["kind"], payload: unknown): ItemDraft {
    return { id: newId("itm"), turnId: this.turnId, kind, status: "running", createdAt: this.now(), completedAt: null, payload } as ItemDraft;
  }

  private completedItem(kind: ItemDraft["kind"], payload: unknown, turnId: string | null = this.turnId): AgentEvent {
    const at = this.now();
    return { type: "item.started", item: { id: newId("itm"), turnId, kind, status: "completed", createdAt: at, completedAt: at, payload } as ItemDraft };
  }

  private start(item: ItemDraft): AgentEvent {
    this.open.set(item.id, item);
    return { type: "item.started", item };
  }

  private finish(item: ItemDraft, status: "completed" | "failed" | "cancelled", patch: Record<string, unknown> = {}): AgentEvent {
    this.open.delete(item.id);
    const payload = { ...(item.payload as Record<string, unknown>), ...patch };
    return { type: "item.completed", item: { ...item, status, completedAt: this.now(), payload } as ItemDraft };
  }
}
