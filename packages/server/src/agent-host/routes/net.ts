import type { FastifyInstance } from "fastify";
import { NetPortsResponseSchema } from "@mam/protocol";
import { listListeningPorts } from "../../net/ports.js";
import { send, type AgentHostRuntime } from "../http.js";

/** 개발 모드 gateway 의 기본 포트(`docs/ARCHITECTURE.md` 2.1). */
export const DEV_GATEWAY_PORT = 7777;

/**
 * 목록에서 뺄 gateway 포트. 개발 모드 gateway 는 agent-host 와 같은 사용자로 돌아 `lsof` 에 함께 잡히지만,
 * 운영 모드 gateway 는 root 라 애초에 보이지 않는다. `MAM_DEV_PORT`/`MAM_DEV_BIND` 가 환경에 있으면
 * 개발 모드로 보고 그 포트(없거나 범위 밖이면 7777)를 뺀다. 단서가 없으면 아무것도 빼지 않는다.
 * agent-host 자신은 유닉스 소켓에서만 listen 하므로 TCP 목록에 나오지 않는다.
 */
export function gatewayPorts(env: NodeJS.ProcessEnv = process.env): number[] {
  if (env.MAM_DEV_PORT === undefined && env.MAM_DEV_BIND === undefined) return [];
  const port = Number(env.MAM_DEV_PORT);
  return [Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEV_GATEWAY_PORT];
}

export function registerNetRoutes(app: FastifyInstance, host: AgentHostRuntime): void {
  // 목록만 준다. 서버는 이 포트를 프록시하거나 터널링하지 않는다(PROTOCOL 1절 보안 노트).
  app.get("/net/ports", async (request, reply) => {
    const ports = await listListeningPorts({
      exclude: gatewayPorts(),
      onWarn: (message) => request.log.warn(message),
    });
    return send(host, reply, NetPortsResponseSchema, { ports });
  });
}
