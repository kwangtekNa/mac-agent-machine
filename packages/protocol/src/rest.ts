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

export const FsRenderKindSchema = z.enum(["hwp", "hwpx"]);

/**
 * `GET /fs/render` 응답(2026-09-13 추가). iOS 가 못 여는 한글 문서를 서버가 HTML 로 바꾼 결과다.
 * `html` 은 자체 완결(외부 리소스·스크립트 없음, 이미지는 data URI)이며 `warnings` 는 변환하지 못한 부분이다.
 */
export const FsRenderResponseSchema = z.object({
  path: z.string().min(1),
  kind: FsRenderKindSchema,
  html: z.string(),
  warnings: z.array(z.string()),
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

/** `POST /git/init` 본문(2026-09-13 추가). `dryRun: true` 면 아무것도 바꾸지 않고 커밋될 파일 수·바이트만 계산한다. */
export const GitInitRequestSchema = z.object({
  cwd: z.string().min(1),
  dryRun: z.boolean().optional(),
});

/**
 * `POST /git/init` → 201(초기화) / 200(`dryRun`). `branch` 는 항상 `main`, `commit` 은 첫 커밋 sha(dryRun 이면 null).
 * `files`/`bytes` 는 첫 커밋에 담기는(담길) 기존 파일 수와 합계 크기(서버가 만든 `.gitignore` 는 제외).
 */
export const GitInitResponseSchema = z.object({
  initialized: z.boolean(),
  branch: z.string().min(1),
  commit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  files: z.int().min(0),
  bytes: z.int().min(0),
  createdGitignore: z.boolean(),
});

/** `POST /fs/mkdir` 본문(2026-09-10 추가). `~/` 로 시작하면 서버가 홈으로 치환한다. */
export const FsMkdirRequestSchema = z.object({
  path: z.string().min(1),
});

/** `POST /fs/mkdir` → 201. 만든 디렉토리의 FsEntry. */
export const FsMkdirResponseSchema = z.object({
  entry: FsEntrySchema,
});

/** `usedPercent < 80` → ok, 80 이상 → warning, 100 이상 또는 어댑터가 거부를 보고 → exceeded. */
export const UsageLimitStatusSchema = z.enum(["ok", "warning", "exceeded"]);

/** 구독 사용 한도 창 하나(2026-09-10 추가). `usedPercent` 는 100 을 넘을 수 있다. */
export const UsageLimitSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  usedPercent: z.int().min(0),
  windowMinutes: z.int().min(1).nullable(),
  resetsAt: IsoDateSchema.nullable(),
  status: UsageLimitStatusSchema,
});

/** 에이전트별 구독 사용 한도. 관측값이 없으면 `limits: []`, `observedAt: null`. */
export const AgentUsageSchema = z.object({
  kind: AgentKindSchema,
  plan: z.string().nullable(),
  /** Codex 는 호출 시점 조회(true), Claude 는 세션 실행 중 관측한 마지막 값(false). */
  live: z.boolean(),
  observedAt: IsoDateSchema.nullable(),
  limits: z.array(UsageLimitSchema),
});

/** `GET /usage` 응답(2026-09-10 추가). */
export const UsageResponseSchema = z.object({
  agents: z.array(AgentUsageSchema),
});

/** `GET /models` 항목(2026-09-10 추가). `efforts` 가 비어 있으면 effort 조절을 지원하지 않는다. */
export const ModelOptionSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().nullable(),
  isDefault: z.boolean(),
  efforts: z.array(z.string().min(1)),
  defaultEffort: z.string().nullable(),
});

export const ModelsResponseSchema = z.object({
  models: z.array(ModelOptionSchema),
});

/** `GET /models?agent=` 쿼리. */
export const ModelsQuerySchema = z.object({
  agent: AgentKindSchema,
});

/**
 * `GET /net/ports` 항목(2026-09-13 추가). agent-host 사용자가 TCP 로 LISTEN 중인 포트 하나.
 * `address` 는 바인딩 주소(`*`, `0.0.0.0`, `127.0.0.1`, `::1`). 폰이 Mac 주소로 직접 열어 보는 용도이며 서버는 프록시하지 않는다.
 */
export const NetPortSchema = z.object({
  port: z.int().min(1).max(65535),
  pid: z.int().min(0),
  process: z.string().min(1),
  address: z.string().min(1),
});

/** `GET /net/ports` 응답. `port` 오름차순이고, `lsof` 를 쓸 수 없으면 빈 배열이다(500 이 아니다). */
export const NetPortsResponseSchema = z.object({
  ports: z.array(NetPortSchema),
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
