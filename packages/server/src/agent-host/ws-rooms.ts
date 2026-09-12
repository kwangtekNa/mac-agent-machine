import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { z, ZodError } from "zod";
import { parseRoomClientMessage, type RoomClientMessage, type RoomServerEvent } from "@mam/protocol";
import { MamError, NotFoundError } from "../errors.js";
import { formatIssues, type AgentHostRuntime } from "./http.js";
import { WS_PING_INTERVAL_MS, type WsOptions } from "./ws.js";

/** 팀 또는 방 없음(세션 WS 의 4004 와 같은 규칙). */
export const WS_CLOSE_ROOM_NOT_FOUND = 4004;

const QuerySchema = z.object({ since: z.coerce.number().int().min(0).default(0) });

interface RoomParams {
  teamId: string;
  roomId: string;
}

/**
 * `GET /teams/:teamId/rooms/:roomId/ws?since=`(PROTOCOL 6.3). 세션 WS(`ws.ts`)와 같은 구조: ping 인터벌·pong·onClose 정리,
 * 구독 → `room.snapshot`(seq 0) → 큐 flush → 라이브. 승인 응답은 받지 않는다(기존 세션 API 만). 방 이벤트는 RoomManager 가 만든 JSON 그대로 보낸다.
 */
export function registerRoomWsRoutes(app: FastifyInstance, host: AgentHostRuntime, opts: WsOptions = {}): void {
  const sockets = new Map<WebSocket, { alive: boolean }>();
  const interval = setInterval(() => {
    for (const [socket, state] of sockets) {
      if (!state.alive) {
        sockets.delete(socket);
        socket.terminate();
        continue;
      }
      state.alive = false;
      socket.ping();
    }
  }, opts.pingIntervalMs ?? WS_PING_INTERVAL_MS);
  interval.unref();
  app.addHook("onClose", async () => {
    clearInterval(interval);
    for (const socket of sockets.keys()) socket.close(1001, "server shutdown");
    sockets.clear();
  });

  app.get<{ Params: RoomParams }>("/teams/:teamId/rooms/:roomId/ws", { websocket: true }, (socket, request) => {
    const state = { alive: true };
    sockets.set(socket, state);
    socket.on("pong", () => {
      state.alive = true;
    });
    socket.on("close", () => sockets.delete(socket));
    attach(host, socket, request).catch((err: unknown) => {
      request.log.error({ err }, "room ws attach failed");
      if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) socket.close(1011, "internal error");
    });
  });
}

async function attach(host: AgentHostRuntime, socket: WebSocket, request: FastifyRequest<{ Params: RoomParams }>): Promise<void> {
  const { teamId, roomId } = request.params;
  const query = QuerySchema.safeParse(request.query);
  if (!query.success) {
    socket.close(1008, "invalid since");
    return;
  }
  const since = query.data.since;
  let hasRoom = false;
  try {
    hasRoom = host.teams.getTeam(teamId).rooms.some((r) => r.id === roomId);
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;
  }
  if (!hasRoom) {
    socket.close(WS_CLOSE_ROOM_NOT_FOUND, "room not found");
    return;
  }

  const sendRaw = (event: RoomServerEvent): void => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
  };
  const now = (): string => new Date().toISOString();
  const sendError = (message: string): void =>
    sendRaw({ type: "room.error", seq: 0, roomId, teamId, ts: now(), message, recoverable: true });

  // 구독 → 스냅샷 → 큐 flush. 재생/라이브 이벤트는 스냅샷 전송 전까지 큐에 모아 seq 순서를 지킨다.
  let live = false;
  const queue: RoomServerEvent[] = [];
  const listener = (event: RoomServerEvent): void => {
    if (live) sendRaw(event);
    else queue.push(event);
  };
  let closed = false;
  let unsubscribe: (() => void) | undefined;
  socket.on("close", () => {
    closed = true;
    unsubscribe?.();
  });
  socket.on("message", (data) => {
    void handleMessage(data.toString()).catch((err: unknown) => {
      request.log.error({ err }, "room ws message handling failed");
      sendError("internal error");
    });
  });

  try {
    unsubscribe = await host.teams.subscribeRoom(teamId, roomId, since, listener);
  } catch (err) {
    if (err instanceof NotFoundError) socket.close(WS_CLOSE_ROOM_NOT_FOUND, "room not found");
    else throw err;
    return;
  }
  if (closed) {
    unsubscribe();
    return;
  }
  const detail = await host.teams.roomDetail(teamId, roomId);
  const messages = since > 0 ? detail.messages.filter((m) => m.seq > since) : detail.messages;
  const pendingApprovals = await host.teams.roomPendingApprovals(teamId, roomId);
  const { dispatch } = host.teams.detail(teamId);
  sendRaw({
    type: "room.snapshot",
    seq: 0,
    roomId,
    teamId,
    ts: now(),
    room: detail.room,
    messages,
    pendingApprovals,
    dispatch,
    members: host.teams.memberStates(teamId),
    replayFrom: since,
    truncated: detail.truncated,
  });
  for (const event of queue) sendRaw(event);
  queue.length = 0;
  live = true;

  async function handleMessage(raw: string): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      sendError("invalid JSON");
      return;
    }
    let msg: RoomClientMessage;
    try {
      msg = parseRoomClientMessage(json);
    } catch (err) {
      sendError(`invalid message: ${err instanceof ZodError ? formatIssues(err.issues) : String(err)}`);
      return;
    }
    try {
      switch (msg.type) {
        case "ping":
          sendRaw({ type: "pong", seq: 0, roomId, teamId, ts: now() });
          return;
        case "room.send": {
          const { type: _type, ...input } = msg;
          await host.teams.postUserMessage(teamId, roomId, input);
          return;
        }
        case "room.interrupt":
          await host.teams.interrupt(teamId, msg.memberId);
          return;
      }
    } catch (err) {
      if (err instanceof MamError) sendError(err.message);
      else {
        request.log.error({ err }, "room ws command failed");
        sendError("internal error");
      }
    }
  }
}
