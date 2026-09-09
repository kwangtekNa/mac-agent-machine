import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { z, ZodError } from "zod";
import { parseClientMessage, type ClientMessage, type ServerEvent } from "@mam/protocol";
import { MamError, SessionBusyError, SessionNotFoundError } from "../errors.js";
import { formatIssues, type AgentHostRuntime } from "./http.js";

export const WS_PING_INTERVAL_MS = 30_000;
/** 세션 없음. */
export const WS_CLOSE_SESSION_NOT_FOUND = 4004;

export interface WsOptions {
  pingIntervalMs?: number;
}

const QuerySchema = z.object({ since: z.coerce.number().int().min(0).default(0) });

export function registerWsRoutes(app: FastifyInstance, host: AgentHostRuntime, opts: WsOptions = {}): void {
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

  app.get<{ Params: { id: string } }>("/sessions/:id/ws", { websocket: true }, (socket, request) => {
    const state = { alive: true };
    sockets.set(socket, state);
    socket.on("pong", () => {
      state.alive = true;
    });
    socket.on("close", () => sockets.delete(socket));
    attach(host, socket, request).catch((err: unknown) => {
      request.log.error({ err }, "ws attach failed");
      if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) socket.close(1011, "internal error");
    });
  });
}

async function attach(host: AgentHostRuntime, socket: WebSocket, request: FastifyRequest<{ Params: { id: string } }>): Promise<void> {
  const id = request.params.id;
  const query = QuerySchema.safeParse(request.query);
  if (!query.success) {
    socket.close(1008, "invalid since");
    return;
  }
  const since = query.data.since;
  if (!host.manager.get(id)) {
    socket.close(WS_CLOSE_SESSION_NOT_FOUND, "session not found");
    return;
  }

  const sendRaw = (event: ServerEvent): void => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
  };
  const now = (): string => new Date().toISOString();
  const sendError = (message: string): void =>
    sendRaw({ type: "error", seq: 0, sessionId: id, ts: now(), message, recoverable: true });

  // 구독 → 스냅샷 → 큐 flush. 재생/라이브 이벤트는 스냅샷 전송 전까지 큐에 모아 seq 순서를 지킨다.
  let live = false;
  const queue: ServerEvent[] = [];
  const listener = (event: ServerEvent): void => {
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
      request.log.error({ err }, "ws message handling failed");
      sendError("internal error");
    });
  });

  try {
    unsubscribe = await host.manager.subscribe(id, since, listener);
  } catch (err) {
    if (err instanceof SessionNotFoundError) socket.close(WS_CLOSE_SESSION_NOT_FOUND, "session not found");
    else throw err;
    return;
  }
  if (closed) {
    unsubscribe();
    return;
  }
  const detail = await host.manager.detail(id);
  const items = since > 0 ? detail.items.filter((item) => item.seq > since) : detail.items;
  sendRaw({
    type: "session.snapshot",
    seq: 0,
    sessionId: id,
    ts: now(),
    session: detail.session,
    items,
    pendingApprovals: host.manager.pendingApprovals(id),
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
    let msg: ClientMessage;
    try {
      msg = parseClientMessage(json);
    } catch (err) {
      sendError(`invalid message: ${err instanceof ZodError ? formatIssues(err.issues) : String(err)}`);
      return;
    }
    try {
      switch (msg.type) {
        case "ping":
          sendRaw({ type: "pong", seq: 0, sessionId: id, ts: now() });
          return;
        case "turn.start": {
          const { type: _type, ...input } = msg;
          await host.manager.startTurn(id, input);
          return;
        }
        case "turn.interrupt":
          await host.manager.interrupt(id);
          return;
        case "approval.respond":
          await host.manager.respondApproval(id, msg.approvalId, msg.optionId, msg.inputs, msg.message);
          return;
        case "session.setMode":
          await host.manager.setMode(id, msg.mode);
          return;
      }
    } catch (err) {
      if (err instanceof SessionBusyError) sendError("session is busy");
      else if (err instanceof MamError) sendError(err.message);
      else {
        request.log.error({ err }, "ws command failed");
        sendError("internal error");
      }
    }
  }
}
