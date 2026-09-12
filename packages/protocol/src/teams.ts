import { z } from "zod";
import { ApprovalResolutionSchema, ApprovalSchema } from "./approval.js";
import {
  AgentKindSchema,
  ChangeIdSchema,
  DispatchIdSchema,
  IsoDateSchema,
  MemberIdSchema,
  MessageIdSchema,
  RoomIdSchema,
  SeqSchema,
  SessionIdSchema,
  SessionModeSchema,
  TeamIdSchema,
  TemplateIdSchema,
  TurnIdSchema,
} from "./common.js";
import { AttachmentSchema, UsageSchema } from "./session.js";
import { FileChangeEntrySchema } from "./timeline.js";

/**
 * 에이전트 팀과 방(2026-09-12 추가). `PROTOCOL.md` 6절.
 * 팀원은 기존 `Session` 하나를 가진 에이전트이며 자기 git worktree 에서 일한다.
 */

export const RoleIdSchema = z.enum(["developer", "planner", "team-lead", "code-reviewer", "custom"]);

/** `GET /team-roles` 항목. `prompt` 는 팀원 생성 시 `MemberInput.prompt` 를 생략하면 복사되는 기본 지시문. */
export const RolePresetSchema = z.object({
  id: RoleIdSchema,
  label: z.string(),
  emoji: z.string(),
  prompt: z.string(),
});

export const TeamMemberStateSchema = z.enum(["idle", "queued", "running", "waiting_approval", "error"]);

/** `@멘션` 에 쓰는 ASCII 핸들. 소문자 영숫자·하이픈, 1~32자. */
export const HandleSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, {
  message: "expected [a-z0-9][a-z0-9-]{0,31}",
});

export const TeamMemberSchema = z.object({
  id: MemberIdSchema,
  name: z.string().min(1).max(40),
  handle: HandleSchema,
  role: RoleIdSchema,
  roleLabel: z.string(),
  emoji: z.string(),
  agent: AgentKindSchema,
  prompt: z.string(),
  mode: SessionModeSchema,
  model: z.string().nullable(),
  effort: z.string().nullable(),
  /** 아직 세션을 만들지 않았으면(첫 디스패치 전, 또는 reset 직후) `null`. */
  sessionId: SessionIdSchema.nullable(),
  branch: z.string(),
  worktreePath: z.string(),
  isLead: z.boolean(),
  state: TeamMemberStateSchema,
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});

/** 팀 설정. 기본값 `maxHops` 6, `maxConcurrent` 2, `contextMaxMessages` 40. */
export const TeamSettingsSchema = z.object({
  maxHops: z.int().min(0).max(50),
  maxConcurrent: z.int().min(1).max(8),
  contextMaxMessages: z.int().min(1).max(500),
});

export const RoomKindSchema = z.enum(["group", "dm"]);

export const RoomSchema = z.object({
  id: RoomIdSchema,
  teamId: TeamIdSchema,
  kind: RoomKindSchema,
  /** DM 방의 상대 팀원. 그룹방은 `null`. */
  memberId: MemberIdSchema.nullable(),
  name: z.string(),
  lastSeq: SeqSchema,
  lastMessageAt: IsoDateSchema.nullable(),
});

export const TeamSchema = z.object({
  id: TeamIdSchema,
  name: z.string().min(1).max(60),
  cwd: z.string(),
  baseBranch: z.string(),
  settings: TeamSettingsSchema,
  members: z.array(TeamMemberSchema),
  rooms: z.array(RoomSchema),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});

export const RoomAuthorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }),
  z.object({ kind: z.literal("agent"), memberId: MemberIdSchema }),
  z.object({ kind: z.literal("system") }),
]);

/** 에이전트 답변 메시지에 붙는 턴 요약. */
export const WorkSummarySchema = z.object({
  sessionId: SessionIdSchema,
  turnId: TurnIdSchema,
  toolCalls: z.int().min(0),
  filesChanged: z.array(z.string()),
  durationMs: z.int().min(0),
  usage: UsageSchema,
  costUsd: z.number().min(0).optional(),
});

export const ChangeSetStatusSchema = z.enum(["ready", "merging", "merged", "conflict", "dismissed", "stale"]);

/** 턴 종료 시 서버가 worktree 를 커밋해 만든 "변경 준비됨" 묶음. */
export const ChangeSetSchema = z.object({
  id: ChangeIdSchema,
  teamId: TeamIdSchema,
  memberId: MemberIdSchema,
  sessionId: SessionIdSchema,
  turnId: TurnIdSchema,
  branch: z.string(),
  baseBranch: z.string(),
  /** 팀원 브랜치의 HEAD 커밋(40자 hex). */
  commit: z.string(),
  files: z.array(FileChangeEntrySchema),
  /** baseBranch 대비 앞선 커밋 수. */
  commits: z.int().min(1),
  status: ChangeSetStatusSchema,
  /** `status: "conflict"` 일 때 충돌 파일. 그 외 `[]`. */
  conflictFiles: z.array(z.string()),
  /** 이 ChangeSet 을 담은 방 메시지(`kind: "changes"`). */
  messageId: MessageIdSchema,
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});

export const RoomMessageKindSchema = z.enum(["text", "approval", "changes", "system"]);

/** 방에 미러링된 승인. 실제 응답은 `POST /sessions/:sessionId/approvals/:approvalId`. */
export const RoomApprovalSchema = z.object({
  memberId: MemberIdSchema,
  sessionId: SessionIdSchema,
  approval: ApprovalSchema,
  resolution: ApprovalResolutionSchema.nullable(),
});

export const RoomMessageSchema = z.object({
  id: MessageIdSchema,
  roomId: RoomIdSchema,
  /** 이 메시지를 게시한 `room.message` 이벤트의 seq. 갱신돼도 바뀌지 않는다. */
  seq: SeqSchema,
  author: RoomAuthorSchema,
  kind: RoomMessageKindSchema,
  text: z.string(),
  /** 본문에서 해석된 `@핸들`·`@이름` 멘션의 팀원 ID. `@all` 은 작성자 외 전원으로 펼친다. */
  mentions: z.array(MemberIdSchema),
  /** 연쇄 깊이. 사용자 메시지 0, 그 멘션으로 실행된 턴의 결과 1, 그 결과의 멘션으로 실행된 턴 2 … */
  hop: z.int().min(0),
  /** 이 메시지를 만든 디스패치. 사용자·시스템 메시지는 `null`. */
  dispatchId: DispatchIdSchema.nullable(),
  createdAt: IsoDateSchema,
  /** `kind: "text"` 이고 작성자가 에이전트일 때만 채운다. */
  work: WorkSummarySchema.nullable(),
  /** `kind: "approval"` 일 때만 채운다. */
  approval: RoomApprovalSchema.nullable(),
  /** `kind: "changes"` 일 때만 채운다. */
  changes: ChangeSetSchema.nullable(),
});

export const MergeResultSchema = z.object({
  change: ChangeSetSchema,
  /** `status: "merged"` 면 `--no-ff` 머지 커밋, 아니면 `null`. */
  mergeCommit: z.string().nullable(),
});

export const RunningDispatchSchema = z.object({
  dispatchId: DispatchIdSchema,
  memberId: MemberIdSchema,
  roomId: RoomIdSchema,
  sessionId: SessionIdSchema,
  /** 어댑터가 턴 ID 를 보고하기 전에는 `null`. */
  turnId: TurnIdSchema.nullable(),
  hop: z.int().min(0),
});

export const QueuedDispatchSchema = z.object({
  dispatchId: DispatchIdSchema,
  memberId: MemberIdSchema,
  roomId: RoomIdSchema,
  hop: z.int().min(0),
  enqueuedAt: IsoDateSchema,
});

/** 팀 전체의 실행 중·대기 중 디스패치. */
export const DispatchStateSchema = z.object({
  running: z.array(RunningDispatchSchema),
  queued: z.array(QueuedDispatchSchema),
});

/** 템플릿에 저장하는 팀원 정의. 런타임 필드(id, sessionId, branch, worktreePath, state, 시각)는 없다. */
export const TeamTemplateMemberSchema = TeamMemberSchema.pick({
  name: true,
  handle: true,
  role: true,
  roleLabel: true,
  emoji: true,
  agent: true,
  prompt: true,
  mode: true,
  model: true,
  effort: true,
  isLead: true,
});

export const TeamTemplateSchema = z.object({
  id: TemplateIdSchema,
  name: z.string().min(1).max(60),
  settings: TeamSettingsSchema,
  members: z.array(TeamTemplateMemberSchema),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});

// ---- 요청 ----

/** `POST /teams` 의 `members[]`, `POST /teams/:id/members` 본문. */
export const MemberInputSchema = z.object({
  name: z.string().min(1).max(40),
  role: RoleIdSchema,
  /** 생략하면 프리셋 label. `custom` 은 필수. */
  roleLabel: z.string().min(1).optional(),
  agent: AgentKindSchema,
  /** 생략하면 프리셋 emoji. */
  emoji: z.string().min(1).optional(),
  /** 생략하면 프리셋 prompt. */
  prompt: z.string().optional(),
  /** 생략하면 `auto-edit`. */
  mode: SessionModeSchema.optional(),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  /** 생략하면 이름에서 만든다(로마자·숫자만 남기고 없으면 `agent-<n>`). */
  handle: HandleSchema.optional(),
  isLead: z.boolean().optional(),
});

export const CreateTeamRequestSchema = z.object({
  cwd: z.string().min(1),
  name: z.string().min(1).max(60),
  members: z.array(MemberInputSchema).min(1),
  settings: TeamSettingsSchema.partial().optional(),
  templateId: TemplateIdSchema.optional(),
});

export const PatchTeamRequestSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  settings: TeamSettingsSchema.partial().optional(),
});

/** `prompt`/`model` 은 다음 세션(reset 또는 재시작)부터 적용된다(`appliesAt: "next_session"`). */
export const PatchMemberRequestSchema = z.object({
  name: z.string().min(1).max(40).optional(),
  emoji: z.string().min(1).optional(),
  prompt: z.string().optional(),
  mode: SessionModeSchema.optional(),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
});

/** `POST /teams/:id/rooms/:roomId/messages` 본문. `attachments` 는 디스패치되는 턴에만 전달되고 RoomMessage 에는 남지 않는다. */
export const PostRoomMessageRequestSchema = z.object({
  text: z.string().min(1),
  attachments: z.array(AttachmentSchema).optional(),
});

export const CreateTeamTemplateRequestSchema = z.object({
  name: z.string().min(1).max(60),
  settings: TeamSettingsSchema.partial().optional(),
  members: z.array(TeamTemplateMemberSchema).min(1),
});

export const PatchTeamTemplateRequestSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  settings: TeamSettingsSchema.partial().optional(),
  members: z.array(TeamTemplateMemberSchema).min(1).optional(),
});

// ---- 응답 ----

export const TeamRolesResponseSchema = z.object({
  roles: z.array(RolePresetSchema),
});

export const TeamsResponseSchema = z.object({
  teams: z.array(TeamSchema),
});

export const TeamDetailResponseSchema = z.object({
  team: TeamSchema,
  dispatch: DispatchStateSchema,
  changes: z.array(ChangeSetSchema),
});

/** `GET /teams/:id/rooms/:roomId` — 최근 `limit`(기본 200)개. 더 있으면 `truncated: true`. */
export const RoomDetailResponseSchema = z.object({
  room: RoomSchema,
  messages: z.array(RoomMessageSchema),
  truncated: z.boolean(),
});

/** `dispatches` 는 이 메시지로 만들어진 디스패치 ID(실행·대기 포함). 멘션이 없어 팀장에게 갔으면 1개. */
export const PostRoomMessageResponseSchema = z.object({
  message: RoomMessageSchema,
  dispatches: z.array(DispatchIdSchema),
});

export const ChangesResponseSchema = z.object({
  changes: z.array(ChangeSetSchema),
});

export const TeamTemplatesResponseSchema = z.object({
  templates: z.array(TeamTemplateSchema),
});
