import { z } from "zod";
import { ApprovalIdSchema, AgentKindSchema, FlowIdSchema, IsoDateSchema } from "./common.js";
import { SessionSchema } from "./session.js";
import { TimelineItemSchema } from "./timeline.js";

export const OkResponseSchema = z.object({ ok: z.literal(true) });

export const AgentInfoSchema = z.object({
  kind: AgentKindSchema,
  available: z.boolean(),
  version: z.string().nullable(),
  loggedIn: z.boolean(),
  account: z.string().nullable(),
});

export const ServerInfoSchema = z.object({
  version: z.string(),
  protocolVersion: z.int().min(1),
});

export const MeResponseSchema = z.object({
  user: z.string().min(1),
  email: z.string(),
  home: z.string().min(1),
  workspaceRoot: z.string().min(1),
  agents: z.array(AgentInfoSchema),
  server: ServerInfoSchema,
});

export const ProjectSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  isGitRepo: z.boolean(),
  lastSessionAt: IsoDateSchema.nullable(),
  sessionCount: z.int().min(0),
});

export const ProjectsResponseSchema = z.object({
  projects: z.array(ProjectSchema),
});

export const SessionsResponseSchema = z.object({
  sessions: z.array(SessionSchema),
});

export const SessionDetailResponseSchema = z.object({
  session: SessionSchema,
  items: z.array(TimelineItemSchema),
  truncated: z.boolean(),
});

export const FsEntryTypeSchema = z.enum(["file", "dir", "symlink", "other"]);

/** `git status --porcelain` 이 준 값만 채운다. */
export const GitStatusCodeSchema = z.enum(["M", "A", "D", "R", "?", "!"]);

export const FsEntrySchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  type: FsEntryTypeSchema,
  size: z.int().min(0).nullable(),
  mtime: IsoDateSchema,
  isHidden: z.boolean(),
  gitStatus: GitStatusCodeSchema.nullable(),
});

export const FsListResponseSchema = z.object({
  path: z.string().min(1),
  parent: z.string().nullable(),
  isGitRepo: z.boolean(),
  entries: z.array(FsEntrySchema),
});

export const FsEncodingSchema = z.enum(["utf8", "base64"]);

export const FsReadResponseSchema = z.object({
  path: z.string().min(1),
  size: z.int().min(0),
  mtime: IsoDateSchema,
  isBinary: z.boolean(),
  encoding: FsEncodingSchema,
  content: z.string(),
  truncated: z.boolean(),
  language: z.string().min(1),
});

export const GitStatusEntrySchema = z.object({
  path: z.string().min(1),
  index: z.string().length(1),
  worktree: z.string().length(1),
});

export const GitStatusResponseSchema = z.object({
  isRepo: z.boolean(),
  branch: z.string().nullable(),
  ahead: z.int().min(0),
  behind: z.int().min(0),
  entries: z.array(GitStatusEntrySchema),
});

export const GitDiffResponseSchema = z.object({
  patch: z.string(),
});

export const LoginStartResponseSchema = z.object({
  flowId: FlowIdSchema,
  url: z.string().min(1),
  instructions: z.string(),
  needsCode: z.boolean(),
});

export const LoginFlowStatusSchema = z.enum(["pending", "done", "error"]);

export const LoginStatusResponseSchema = z.object({
  status: LoginFlowStatusSchema,
  message: z.string(),
});

export const LoginCodeRequestSchema = z.object({
  code: z.string().min(1),
});

/** 승인 응답 필드. WS `approval.respond` 와 REST `POST /sessions/:id/approvals/:approvalId` 본문이 공유한다. */
export const ApprovalRespondFieldsSchema = z.object({
  approvalId: ApprovalIdSchema,
  optionId: z.string().min(1),
  inputs: z.record(z.string(), z.string()).optional(),
  message: z.string().optional(),
});

/** REST 본문. `approvalId` 는 URL 에 있으므로 생략 가능하며, 있으면 URL 과 같아야 한다. */
export const ApprovalRespondRequestSchema = ApprovalRespondFieldsSchema.extend({
  approvalId: ApprovalIdSchema.optional(),
});
