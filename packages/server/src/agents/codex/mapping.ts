import type { Approval } from "@mam/protocol";
import { newId } from "../../ids.js";
import type { AgentEvent, ItemDraft } from "../types.js";
import type { FileChange } from "./generated/FileChange.js";
import type { ReviewDecision } from "./generated/ReviewDecision.js";
import type { ServerNotification } from "./generated/ServerNotification.js";
import type { ServerRequest } from "./generated/ServerRequest.js";
import type { CommandExecutionRequestApprovalResponse } from "./generated/v2/CommandExecutionRequestApprovalResponse.js";
import type { FileChangeRequestApprovalResponse } from "./generated/v2/FileChangeRequestApprovalResponse.js";
import type { FileUpdateChange } from "./generated/v2/FileUpdateChange.js";
import type { GrantedPermissionProfile } from "./generated/v2/GrantedPermissionProfile.js";
import type { PermissionsRequestApprovalResponse } from "./generated/v2/PermissionsRequestApprovalResponse.js";
import type { ThreadItem } from "./generated/v2/ThreadItem.js";
import type { TokenUsageBreakdown } from "./generated/v2/TokenUsageBreakdown.js";
import type { ToolRequestUserInputResponse } from "./generated/v2/ToolRequestUserInputResponse.js";
import type { Turn } from "./generated/v2/Turn.js";

export type NotificationParams<M extends ServerNotification["method"]> = Extract<ServerNotification, { method: M }>["params"];
export type RequestParams<M extends ServerRequest["method"]> = Extract<ServerRequest, { method: M }>["params"];

type FileChangePayload = Extract<ItemDraft, { kind: "file_change" }>["payload"];
type ItemStatus = ItemDraft["status"];
const TITLE_LIMIT = 120;
const DETAIL_LIMIT = 4 * 1024;

export interface MappedApproval {
  approval: Approval;
  turnId: string | null;
  /** optionId → 서버 요청 응답 본문(v2 또는 ReviewDecision). */
  respond(optionId: string, inputs?: Record<string, string>, message?: string): unknown;
}

export interface CodexMapperOptions {
  threadId: string;
  cwd: string;
  now?: () => string;
  logger?: Pick<Console, "info" | "warn">;
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export function relativePath(path: string, cwd: string): string {
  const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function countDiff(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

export function fileChangePayload(changes: FileUpdateChange[], cwd: string): FileChangePayload {
  return {
    files: changes.map((c) => ({
      path: relativePath(c.path, cwd),
      kind: c.kind.type === "update" ? (c.kind.move_path ? "rename" : "modify") : c.kind.type,
      ...countDiff(c.diff),
    })),
    patch: changes.map((c) => c.diff).join("\n"),
  };
}

/** 구형 applyPatchApproval 의 `fileChanges` 맵 → unified diff 형태. */
export function legacyPatch(fileChanges: { [key: string]: FileChange | undefined }): string {
  const parts: string[] = [];
  for (const [path, change] of Object.entries(fileChanges)) {
    if (!change) continue;
    if (change.type === "update") parts.push(change.unified_diff);
    else if (change.type === "add") parts.push(`--- /dev/null\n+++ b/${path}\n${change.content.split("\n").map((l) => `+${l}`).join("\n")}`);
    else parts.push(`--- a/${path}\n+++ /dev/null\n${change.content.split("\n").map((l) => `-${l}`).join("\n")}`);
  }
  return parts.join("\n");
}

function statusOf(item: ThreadItem): ItemStatus {
  const s = (item as { status?: string }).status;
  if (s === "inProgress") return "running";
  if (s === "failed" || s === "declined") return "failed";
  return "completed";
}

function userText(content: Array<{ type: string; text?: string }>): string {
  return content.map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type}]`)).join("\n");
}

const STANDARD_OPTIONS: Approval["options"] = [
  { id: "allow", label: "허용", style: "primary" },
  { id: "allow_session", label: "세션 동안 허용", style: "secondary" },
  { id: "deny", label: "거절", style: "destructive" },
];

function v2Decision(optionId: string): FileChangeApprovalDecision_ {
  if (optionId === "allow") return "accept";
  if (optionId === "allow_session") return "acceptForSession";
  if (optionId === "abort") return "cancel";
  return "decline";
}
type FileChangeApprovalDecision_ = FileChangeRequestApprovalResponse["decision"];

function reviewDecision(optionId: string, message?: string): ReviewDecision {
  if (optionId === "allow") return "approved";
  if (optionId === "allow_session") return "approved_for_session";
  if (optionId === "abort") return "abort";
  return { denied: { rejection: message ?? "사용자가 거절했습니다" } };
}

/** 알림·서버요청 → AgentEvent/Approval. seq 는 만들지 않는다(CRITICAL 7). */
export class CodexEventMapper {
  /** 우리 턴 ID(`trn_<ULID>`, PROTOCOL 스키마 강제). Codex turn id 와 1:1 로 대응한다. */
  private turnId: string | null = null;
  private codexTurnId: string | null = null;
  private turnStartedAt = 0;
  /** codex item id → 우리 ItemDraft(열린 아이템). */
  private readonly open = new Map<string, ItemDraft>();
  private usage: TokenUsageBreakdown | null = null;
  private usageAtTurnStart: TokenUsageBreakdown | null = null;
  private skipUserMessages = 0;
  private readonly now: () => string;
  private readonly logger: Pick<Console, "info" | "warn">;

  constructor(private readonly opts: CodexMapperOptions) {
    this.now = opts.now ?? (() => new Date().toISOString());
    this.logger = opts.logger ?? console;
  }

  get currentTurnId(): string | null {
    return this.turnId;
  }

  /** `turn/interrupt` 등 Codex 에 돌려줄 원본 turn id. */
  get currentCodexTurnId(): string | null {
    return this.codexTurnId;
  }

  beginTurn(codexTurnId: string): void {
    if (this.codexTurnId === codexTurnId) return;
    this.codexTurnId = codexTurnId;
    this.turnId = newId("trn");
    this.turnStartedAt = Date.now();
    this.usageAtTurnStart = this.usage;
  }

  /** sendTurn 이 직접 user_message 를 방출했으므로 서버의 userMessage 아이템 하나를 건너뛴다. */
  expectUserMessage(): void {
    this.skipUserMessages += 1;
  }

  map(method: string, params: unknown): AgentEvent[] {
    const tid = (params as { threadId?: unknown } | undefined)?.threadId;
    if (typeof tid === "string" && tid !== this.opts.threadId) {
      this.logger.info(`[codex] 다른 스레드 알림 무시 ${method} thread=${tid}`);
      return [];
    }
    const n = { method, params } as ServerNotification;
    switch (n.method) {
      case "turn/started":
        this.beginTurn(n.params.turn.id);
        return [{ type: "status", status: "running" }];
      case "turn/completed":
        return this.mapTurnCompleted(n.params.turn);
      case "item/started": {
        if (n.params.item.type === "userMessage" && this.skipUserMessages > 0) return [];
        this.beginTurn(n.params.turnId);
        const draft = this.toDraft(n.params.item, "running");
        this.open.set(n.params.item.id, draft);
        return [{ type: "item.started", item: draft }];
      }
      case "item/completed": {
        if (n.params.item.type === "userMessage" && this.skipUserMessages > 0) {
          this.skipUserMessages -= 1;
          return [];
        }
        this.beginTurn(n.params.turnId);
        const status = statusOf(n.params.item);
        const draft = this.toDraft(n.params.item, status);
        const existing = this.open.get(n.params.item.id);
        this.open.delete(n.params.item.id);
        const at = this.now();
        if (existing) return [{ type: "item.completed", item: { ...draft, id: existing.id, createdAt: existing.createdAt, completedAt: at } as ItemDraft }];
        return [{ type: "item.started", item: { ...draft, completedAt: at } as ItemDraft }];
      }
      case "item/agentMessage/delta":
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
      case "item/plan/delta":
        return this.delta(n.params.itemId, "text", n.params.delta);
      case "item/commandExecution/outputDelta":
        return this.delta(n.params.itemId, "output", n.params.delta);
      case "item/fileChange/patchUpdated": {
        // `changes` 는 전체 목록(교체). 우리 delta 는 append 이므로 접두어가 같으면 꼬리만, 아니면 전체를 보낸다.
        const item = this.open.get(n.params.itemId);
        if (!item || item.kind !== "file_change") return [];
        const next = fileChangePayload(n.params.changes, this.opts.cwd);
        const prev = item.payload.patch;
        item.payload = next;
        const delta = next.patch.startsWith(prev) ? next.patch.slice(prev.length) : next.patch;
        return delta ? [{ type: "item.delta", itemId: item.id, field: "patch", delta }] : [];
      }
      case "thread/tokenUsage/updated":
        this.usage = n.params.tokenUsage.total;
        return [];
      case "error":
        return [this.completedItem("error", { message: n.params.error.message, recoverable: n.params.willRetry })];
      default:
        this.logger.info(`[codex] ignored notification ${method}`);
        return [];
    }
  }

  /** 열린 아이템을 전부 닫고 턴 상태를 비운다(중단/강제 종료). */
  cancelOpen(status: "cancelled" | "failed" | "completed" = "cancelled"): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const item of this.open.values()) events.push({ type: "item.completed", item: { ...item, status, completedAt: this.now() } as ItemDraft });
    this.open.clear();
    return events;
  }

  private mapTurnCompleted(turn: Turn): AgentEvent[] {
    this.beginTurn(turn.id);
    const turnId = this.turnId as string;
    const events = this.cancelOpen(turn.status === "failed" ? "failed" : turn.status === "interrupted" ? "cancelled" : "completed");
    if (turn.error) events.push(this.completedItem("error", { message: turn.error.message, recoverable: true }));
    const durationMs = turn.durationMs ?? Math.max(0, Date.now() - this.turnStartedAt);
    const base = this.usageAtTurnStart;
    const total = this.usage;
    const diff = (k: keyof TokenUsageBreakdown): number => Math.max(0, (total?.[k] ?? 0) - (base?.[k] ?? 0));
    const usage = { inputTokens: diff("inputTokens"), outputTokens: diff("outputTokens"), cacheReadTokens: diff("cachedInputTokens") };
    const stopReason = turn.status;
    events.push(this.completedItem("turn_summary", { durationMs, usage, stopReason }));
    events.push({ type: "turn.completed", turnId, durationMs, usage, stopReason });
    events.push({ type: "status", status: "idle" });
    this.turnId = null;
    this.codexTurnId = null;
    return events;
  }

  private delta(codexItemId: string, field: "text" | "output", delta: string): AgentEvent[] {
    const item = this.open.get(codexItemId);
    if (!item) {
      this.logger.info(`[codex] 열리지 않은 아이템 delta 무시 ${codexItemId}`);
      return [];
    }
    const payload = item.payload as Record<string, unknown>;
    if (typeof payload[field] === "string") payload[field] = `${payload[field] as string}${delta}`;
    return [{ type: "item.delta", itemId: item.id, field, delta }];
  }

  private completedItem(kind: ItemDraft["kind"], payload: unknown): AgentEvent {
    const at = this.now();
    return { type: "item.started", item: { id: newId("itm"), turnId: this.turnId, kind, status: "completed", createdAt: at, completedAt: at, payload } as ItemDraft };
  }

  private toDraft(item: ThreadItem, status: ItemStatus): ItemDraft {
    const { kind, payload } = this.payloadFor(item);
    return { id: newId("itm"), turnId: this.turnId, kind, status, createdAt: this.now(), completedAt: null, payload } as ItemDraft;
  }

  private payloadFor(item: ThreadItem): { kind: ItemDraft["kind"]; payload: unknown } {
    const tool = (tool: string, name: string, title: string, input: unknown, output = "", exitCode: number | null = null) => ({
      kind: "tool_call" as const,
      payload: { tool, name, title: clip(title, TITLE_LIMIT), input, output, exitCode, truncated: false },
    });
    switch (item.type) {
      case "agentMessage":
        return { kind: "assistant_message", payload: { text: item.text, phase: String(item.phase) === "final_answer" ? "final" : "commentary" } };
      case "reasoning":
        return { kind: "reasoning", payload: { text: item.summary.join("\n") } };
      case "commandExecution":
        return tool("bash", "commandExecution", item.command, { command: item.command, cwd: item.cwd }, item.aggregatedOutput ?? "", item.exitCode);
      case "fileChange":
        return { kind: "file_change", payload: fileChangePayload(item.changes, this.opts.cwd) };
      case "mcpToolCall": {
        const out = item.error ? JSON.stringify(item.error) : item.result ? JSON.stringify(item.result) : "";
        return tool("mcp", `${item.server}/${item.tool}`, `${item.server}/${item.tool}`, item.arguments, out);
      }
      case "webSearch": {
        const q = (item as { query?: unknown }).query;
        return tool("web", "webSearch", typeof q === "string" ? q : "web search", { query: q ?? null });
      }
      case "plan":
        return { kind: "plan", payload: { steps: item.text.split("\n").filter((l) => l.trim()).map((text) => ({ text, status: "pending" })) } };
      case "userMessage":
        return { kind: "user_message", payload: { text: userText(item.content), attachments: [] } };
      default:
        return tool("other", item.type, item.type, {});
    }
  }

  /** 서버 요청 → Approval + 응답 생성기. 지원하지 않는 요청은 null. */
  mapRequest(method: string, params: unknown): MappedApproval | null {
    const r = { method, params } as ServerRequest;
    const requestedAt = this.now();
    const p = r.params as { threadId?: string; conversationId?: string; turnId?: string; itemId?: string };
    const tid = p.threadId ?? p.conversationId;
    if (typeof tid === "string" && tid !== this.opts.threadId) {
      this.logger.info(`[codex] 다른 스레드 요청 무시 ${method}`);
      return null;
    }
    if (p.turnId) this.beginTurn(p.turnId);
    const turnId = this.turnId;
    const base = { approvalId: newId("apr"), itemId: newId("itm"), diff: null as string | null, inputFields: [] as Approval["inputFields"], requestedAt };
    switch (r.method) {
      case "item/commandExecution/requestApproval": {
        const cmd = r.params.command ?? "";
        const approval: Approval = {
          ...base,
          kind: "command",
          title: clip(cmd || "명령 실행", TITLE_LIMIT),
          prompt: "Codex가 명령 실행 승인을 요청합니다",
          detail: `cwd: ${r.params.cwd ?? this.opts.cwd}\n$ ${cmd}${r.params.reason ? `\n${r.params.reason}` : ""}`,
          options: STANDARD_OPTIONS,
        };
        return { approval, turnId, respond: (o): CommandExecutionRequestApprovalResponse => ({ decision: v2Decision(o) }) };
      }
      case "item/fileChange/requestApproval": {
        const open = this.open.get(r.params.itemId);
        const payload = open?.kind === "file_change" ? open.payload : null;
        const files = payload?.files.map((f) => f.path).join(", ") ?? "";
        const approval: Approval = {
          ...base,
          kind: "file_change",
          title: clip(files || "파일 변경", TITLE_LIMIT),
          prompt: "Codex가 파일 변경 승인을 요청합니다",
          detail: `cwd: ${this.opts.cwd}${r.params.reason ? `\n${r.params.reason}` : ""}`,
          diff: payload?.patch ?? null,
          options: STANDARD_OPTIONS,
        };
        return { approval, turnId, respond: (o): FileChangeRequestApprovalResponse => ({ decision: v2Decision(o) }) };
      }
      case "item/permissions/requestApproval": {
        const req = r.params.permissions;
        const granted: GrantedPermissionProfile = { ...(req.network ? { network: req.network } : {}), ...(req.fileSystem ? { fileSystem: req.fileSystem } : {}) };
        const approval: Approval = {
          ...base,
          kind: "permission",
          title: "추가 권한 요청",
          prompt: "Codex가 추가 권한을 요청합니다",
          detail: `cwd: ${r.params.cwd}${r.params.reason ? `\n${r.params.reason}` : ""}\n${clip(JSON.stringify(req, null, 2), DETAIL_LIMIT)}`,
          options: STANDARD_OPTIONS,
        };
        return {
          approval,
          turnId,
          respond: (o): PermissionsRequestApprovalResponse =>
            o === "allow" || o === "allow_session" ? { permissions: granted, scope: o === "allow" ? "turn" : "session" } : { permissions: {}, scope: "turn" },
        };
      }
      case "item/tool/requestUserInput": {
        const questions = r.params.questions;
        const approval: Approval = {
          ...base,
          kind: "user_input",
          title: clip(questions[0]?.header || "입력 요청", TITLE_LIMIT),
          prompt: questions.map((q) => q.question).join("\n"),
          detail: null,
          options: [
            { id: "submit", label: "보내기", style: "primary" },
            { id: "cancel", label: "취소", style: "destructive" },
          ],
          inputFields: questions.map((q) => ({
            id: q.id,
            label: q.header ? `${q.header}: ${q.question}` : q.question,
            type: q.isSecret ? "secret" : q.options && q.options.length > 0 ? "choice" : "text",
            ...(q.options && q.options.length > 0 ? { choices: q.options.map((c) => c.label) } : {}),
          })),
        };
        return {
          approval,
          turnId,
          respond: (o, inputs = {}): ToolRequestUserInputResponse => {
            const answers: ToolRequestUserInputResponse["answers"] = {};
            if (o === "submit") for (const q of questions) if (inputs[q.id] !== undefined) answers[q.id] = { answers: [inputs[q.id] as string] };
            return { answers };
          },
        };
      }
      case "execCommandApproval": {
        const cmd = r.params.command.join(" ");
        const approval: Approval = {
          ...base,
          kind: "command",
          title: clip(cmd, TITLE_LIMIT),
          prompt: "Codex가 명령 실행 승인을 요청합니다",
          detail: `cwd: ${r.params.cwd}\n$ ${cmd}${r.params.reason ? `\n${r.params.reason}` : ""}`,
          options: STANDARD_OPTIONS,
        };
        return { approval, turnId, respond: (o, _i, m): ReviewDecision => reviewDecision(o, m) };
      }
      case "applyPatchApproval": {
        const patch = legacyPatch(r.params.fileChanges);
        const approval: Approval = {
          ...base,
          kind: "file_change",
          title: clip(Object.keys(r.params.fileChanges).join(", ") || "파일 변경", TITLE_LIMIT),
          prompt: "Codex가 파일 변경 승인을 요청합니다",
          detail: `cwd: ${this.opts.cwd}${r.params.reason ? `\n${r.params.reason}` : ""}`,
          diff: patch || null,
          options: STANDARD_OPTIONS,
        };
        return { approval, turnId, respond: (o, _i, m): ReviewDecision => reviewDecision(o, m) };
      }
      default:
        this.logger.info(`[codex] 지원하지 않는 서버 요청 ${method}`);
        return null;
    }
  }
}
