import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import type { UserEntry } from "../config.js";
import type { Identity } from "./identity.js";

export interface ProxyTarget {
  socketPath: string;
  user: UserEntry;
  identity: Identity;
}

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "trailers", "transfer-encoding", "upgrade"]);
const UPGRADE_KEEP = new Set(["connection", "upgrade"]);

function clean(value: string): boolean {
  return !/[\r\n]/.test(value);
}

/** CRITICAL 1: 클라이언트의 x-mam-* 는 전부 버리고(프로토콜 버전만 통과) gateway 가 확정한 신원으로 덮어쓴다. */
export function buildUpstreamHeaders(req: IncomingMessage, target: ProxyTarget, upgrade: boolean): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const k = key.toLowerCase();
    if (k.startsWith("x-mam-") && k !== "x-mam-protocol") continue;
    if (k.startsWith("x-forwarded-")) continue;
    if (HOP_BY_HOP.has(k) && !(upgrade && UPGRADE_KEEP.has(k))) continue;
    out[k] = value;
  }
  out["x-mam-user"] = target.user.macUser;
  out["x-mam-email"] = target.identity.email;
  out["x-forwarded-for"] = req.socket.remoteAddress ?? "";
  out["x-forwarded-proto"] = "encrypted" in req.socket && req.socket.encrypted ? "https" : "http";
  return out;
}

function unavailable(message: string): string {
  return JSON.stringify({ error: { code: "agent_unavailable", message } });
}

export function proxyHttp(req: IncomingMessage, res: ServerResponse, target: ProxyTarget): void {
  const upstream = httpRequest({ socketPath: target.socketPath, method: req.method, path: req.url, headers: buildUpstreamHeaders(req, target, false) });
  upstream.on("response", (up) => {
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(up.headers)) if (v !== undefined && !HOP_BY_HOP.has(k)) headers[k] = v;
    res.writeHead(up.statusCode ?? 502, headers);
    up.pipe(res);
  });
  upstream.on("error", (err: NodeJS.ErrnoException) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const body = unavailable(`agent-host unreachable (${err.code ?? err.message})`);
    res.writeHead(502, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
    res.end(body);
  });
  res.on("close", () => {
    if (!res.writableFinished) upstream.destroy();
  });
  req.pipe(upstream);
}

export function proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, target: ProxyTarget, onClose: () => void): void {
  let closed = false;
  const finish = (): void => {
    if (closed) return;
    closed = true;
    onClose();
  };
  const headers = buildUpstreamHeaders(req, target, true);
  const upstream = connect(target.socketPath);
  upstream.once("connect", () => {
    const lines = [`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1`];
    for (const [k, v] of Object.entries(headers)) for (const item of Array.isArray(v) ? v : [v]) if (clean(item)) lines.push(`${k}: ${item}`);
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on("error", () => {
    if (!upstream.connecting && upstream.bytesRead > 0) return;
    if (socket.writable) socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    socket.destroy();
  });
  upstream.on("close", () => {
    socket.destroy();
    finish();
  });
  socket.on("error", () => upstream.destroy());
  socket.on("close", () => {
    upstream.destroy();
    finish();
  });
}
