import { z } from "zod";
import { ApprovalIdSchema, IsoDateSchema, ItemIdSchema } from "./common.js";

export const ApprovalKindSchema = z.enum([
  "command",
  "file_change",
  "permission",
  "user_input",
  "other",
]);

export const ApprovalOptionStyleSchema = z.enum(["primary", "secondary", "destructive"]);

/** `id` 는 어댑터가 정한다. 공통 값: `allow`, `allow_session`, `deny`, `abort`, `submit`, `cancel`. */
export const ApprovalOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  style: ApprovalOptionStyleSchema,
});

export const InputFieldTypeSchema = z.enum(["text", "secret", "choice"]);

export const InputFieldSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  type: InputFieldTypeSchema,
  choices: z.array(z.string()).optional(),
});

export const ApprovalSchema = z.object({
  approvalId: ApprovalIdSchema,
  itemId: ItemIdSchema,
  kind: ApprovalKindSchema,
  title: z.string(),
  prompt: z.string(),
  detail: z.string().nullable(),
  diff: z.string().nullable(),
  options: z.array(ApprovalOptionSchema).min(1),
  inputFields: z.array(InputFieldSchema),
  requestedAt: IsoDateSchema,
});

export const ApprovalResolvedBySchema = z.enum(["client", "timeout", "system"]);

export const ApprovalResolutionSchema = z.object({
  optionId: z.string().min(1),
  by: ApprovalResolvedBySchema,
  at: IsoDateSchema,
});
