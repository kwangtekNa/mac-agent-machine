import { z } from "zod";
import { IsoDateSchema, MemberIdSchema, RoomIdSchema, SeqSchema, SessionIdSchema, TeamIdSchema } from "./common.js";
import { AttachmentSchema } from "./session.js";
import {
  DispatchStateSchema,
  RoomApprovalSchema,
  RoomMessageSchema,
  RoomSchema,
  TeamMemberStateSchema,
} from "./teams.js";

/**
 * 방 WebSocket(2026-09-12 추가). `GET /api/v1/teams/:teamId/rooms/:roomId/ws?since=<seq>`.
 * 세션 WS 의 `ServerEventSchema`/`ClientMessageSchema` 와 합치지 않는다.
 * iOS 가 `fixtures/ws/`, `fixtures/client/` 를 엄격한 enum 으로 디코드하기 때문이다.
 */

/** 모든 방 이벤트의 공통 필드. `seq` 는 방 내 단조 증가(세션 seq 와 별개). */
const RoomServerEventBaseSchema = z.object({
  seq: SeqSchema,
  roomId: RoomIdSchema,
  teamId: TeamIdSchema,
  ts: IsoDateSchema,
});

/** `room.snapshot`·`room.status` 의 팀원 상태 한 줄. */
export const RoomMemberStatusSchema = z.object({
  memberId: MemberIdSchema,
  state: TeamMemberStateSchema,
  sessionId: SessionIdSchema.nullable(),
});

export const RoomSnapshotEventSchema = RoomServerEventBaseSchema.extend({
  type: z.literal("room.snapshot"),
  seq: z.literal(0),
  room: RoomSchema,
  messages: z.array(RoomMessageSchema),
  /** 이 방에 미러링된 승인 중 `resolution` 이 `null` 인 것. */
  pendingApprovals: z.array(RoomApprovalSchema),
  dispatch: DispatchStateSchema,
  members: z.array(RoomMemberStatusSchema),
  replayFrom: SeqSchema,
  truncated: z.boolean(),
});

export const RoomMessageEventSchema = RoomServerEventBaseSchema.extend({
  type: z.literal("room.message"),
  message: RoomMessageSchema,
});

/** 기존 메시지 갱신(승인 resolution, ChangeSet status). 이벤트는 새 seq 를 받고 `message.seq` 는 원래 값. */
export const RoomMessageUpdatedEventSchema = RoomServerEventBaseSchema.extend({
  type: z.literal("room.message.updated"),
  message: RoomMessageSchema,
});

export const RoomStatusEventSchema = RoomServerEventBaseSchema.extend({
  type: z.literal("room.status"),
  dispatch: DispatchStateSchema,
  members: z.array(RoomMemberStatusSchema),
});

export const RoomErrorEventSchema = RoomServerEventBaseSchema.extend({
  type: z.literal("room.error"),
  message: z.string(),
  recoverable: z.boolean(),
});

export const RoomPongEventSchema = RoomServerEventBaseSchema.extend({
  type: z.literal("pong"),
  seq: z.literal(0),
});

export const RoomServerEventSchema = z.discriminatedUnion("type", [
  RoomSnapshotEventSchema,
  RoomMessageEventSchema,
  RoomMessageUpdatedEventSchema,
  RoomStatusEventSchema,
  RoomErrorEventSchema,
  RoomPongEventSchema,
]);

/** REST `POST .../messages` 와 같은 본문. 응답은 `room.message` 이벤트로 온다. */
export const RoomSendMessageSchema = z.object({
  type: z.literal("room.send"),
  text: z.string().min(1),
  attachments: z.array(AttachmentSchema).optional(),
});

/** `memberId` 를 생략하면 팀 전체(`POST /teams/:id/stop` 과 같음). */
export const RoomInterruptMessageSchema = z.object({
  type: z.literal("room.interrupt"),
  memberId: MemberIdSchema.optional(),
});

export const RoomPingMessageSchema = z.object({
  type: z.literal("ping"),
});

export const RoomClientMessageSchema = z.discriminatedUnion("type", [
  RoomSendMessageSchema,
  RoomInterruptMessageSchema,
  RoomPingMessageSchema,
]);
