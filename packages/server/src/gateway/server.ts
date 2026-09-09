import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import type { Config } from "../config.js";
import { ForbiddenError, MamError } from "../errors.js";
import { SERVER_VERSION } from "../index.js";
import type { ExecFn, IdentityResolver } from "./identity.js";
import { proxyHttp, proxyUpgrade, type ProxyTarget } from "./proxy.js";
import type { AgentHostSupervisor } from "./supervisor.js";
import { loadTls, tailscaleIPv4 } from "./tls.js";
import type { UserDirectory } from "./users.js";

type Logger = Pick<Console, "info" | "warn" | "error">;

export interface GatewayDeps {
  config: Config;
  identity: IdentityResolver;
  users: UserDirectory;
  supervisor: AgentHostSupervisor;
  dev: boolean;
  logger?: Logger;
  /** `tailscale ip -4` 실행기(테스트 주입). */
  exec?: ExecFn;
}

export interface GatewayHandle {
  address: { host: string; port: number };
  close(): Promise<void>;
}

const STATUS_TEXT: Record<number, string> = { 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 409: "Conflict", 500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable" };

function toError(err: unknown, logger: Logger): { status: number; body: string } {
  if (err instanceof MamError) return { status: err.status, body: JSON.stringify(err.toResponse()) };
  logger.error(`[gateway] unhandled: ${err instanceof Error ? err.message : String(err)}`);
  return { status: 500, body: JSON.stringify({ error: { code: "internal", message: "internal error" } }) };
}

function sendJson(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function sendRaw(socket: Duplex, status: number, body: string): void {
  socket.end(`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? "Error"}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}

export async function startGateway(deps: GatewayDeps): Promise<GatewayHandle> {
  const { config, supervisor } = deps;
  const logger = deps.logger ?? { info() {}, warn() {}, error() {} };
  const host = deps.dev ? "127.0.0.1" : config.bind === "tailscale" ? await tailscaleIPv4(deps.exec) : config.bind;
  const server: Server = deps.dev ? createHttpServer() : createHttpsServer(await loadTls(config.tls));
  const upgraded = new Set<Duplex>();

  // 신원(전송 계층) → 계정 매핑 → agent-host 확보. 클라이언트 헤더는 어디에도 쓰지 않는다.
  const authorize = async (req: IncomingMessage): Promise<ProxyTarget> => {
    const identity = await deps.identity.resolve(req.socket.remoteAddress ?? "");
    if (!identity) throw new ForbiddenError("unknown tailnet identity");
    const user = deps.users.byEmail(identity.email);
    if (!user) throw new ForbiddenError(`no account mapped for ${identity.email}`);
    supervisor.noteActivity(user.macUser);
    const { socketPath } = await supervisor.ensure(user);
    return { socketPath, user, identity };
  };

  server.on("request", (req, res) => {
    const started = Date.now();
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    let user = "-";
    res.once("finish", () => logger.info(`[gateway] ${req.method} ${path} user=${user} status=${res.statusCode} ${Date.now() - started}ms`));
    if (req.method === "GET" && path === "/healthz") return sendJson(res, 200, JSON.stringify({ ok: true, version: SERVER_VERSION }));
    if (!path.startsWith("/api/")) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("mac-agent-machine gateway");
      return;
    }
    authorize(req).then(
      (target) => {
        user = target.user.macUser;
        proxyHttp(req, res, target);
      },
      (err: unknown) => {
        const { status, body } = toError(err, logger);
        sendJson(res, status, body);
      },
    );
  });

  server.on("upgrade", (req, socket, head) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (!path.startsWith("/api/")) return sendRaw(socket, 404, JSON.stringify({ error: { code: "not_found", message: "route not found" } }));
    authorize(req).then(
      (target) => {
        upgraded.add(socket);
        const release = supervisor.trackConnection(target.user.macUser);
        logger.info(`[gateway] UPGRADE ${path} user=${target.user.macUser}`);
        proxyUpgrade(req, socket, head, target, () => {
          upgraded.delete(socket);
          release();
          logger.info(`[gateway] CLOSE ${path} user=${target.user.macUser}`);
        });
      },
      (err: unknown) => {
        const { status, body } = toError(err, logger);
        sendRaw(socket, status, body);
      },
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address() as AddressInfo;
  let closing: Promise<void> | undefined;
  return {
    address: { host: addr.address, port: addr.port },
    close: () => {
      closing ??= (async () => {
        for (const s of upgraded) s.destroy();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await supervisor.shutdown();
      })();
      return closing;
    },
  };
}

/** SIGTERM/SIGINT → close(). cli 가 호출한다. */
export function installGatewaySignalHandlers(gateway: GatewayHandle, exit: (code: number) => void = (code) => process.exit(code)): void {
  const onSignal = (): void => {
    gateway.close().then(
      () => exit(0),
      () => exit(1),
    );
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
}
