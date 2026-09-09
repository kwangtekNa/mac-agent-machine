import type { FastifyInstance } from "fastify";
import { AgentKindSchema, LoginCodeRequestSchema, LoginStartResponseSchema, LoginStatusResponseSchema, OkResponseSchema, type AgentKind } from "@mam/protocol";
import { AgentUnavailableError, InvalidRequestError, NotFoundError } from "../../errors.js";
import { startClaudeLogin } from "../auth/claude-login.js";
import { startCodexLogin } from "../auth/codex-login.js";
import { FlowRegistry, type LoginFlow, type LoginStarter } from "../auth/flows.js";
import { send, validate, type AgentHostRuntime } from "../http.js";

const SSH_HINT = "ssh 로 접속해 직접 로그인하세요: claude setup-token / codex login";

function defaultStarters(host: AgentHostRuntime): Record<AgentKind, LoginStarter> {
  const logger = host.logger && typeof host.logger === "object" && "info" in host.logger ? (host.logger as Pick<Console, "info" | "warn" | "error">) : console;
  return {
    claude: (id) => startClaudeLogin({ id, home: host.home, logger }),
    codex: (id) => startCodexLogin({ id, home: host.home, logger }),
  };
}

function parseAgent(value: unknown): AgentKind {
  const parsed = AgentKindSchema.safeParse(value);
  if (!parsed.success) throw new InvalidRequestError(`지원하지 않는 에이전트: ${String(value)}`);
  return parsed.data;
}

function statusMessage(flow: LoginFlow): string {
  if (flow.message) return flow.message;
  if (flow.status === "pending") return flow.needsCode ? "코드 입력을 기다리는 중" : "브라우저 인증을 기다리는 중";
  return flow.status === "done" ? "로그인 완료" : "로그인 실패";
}

/** PROTOCOL 1절 로그인 플로우. 실제 구현은 `../auth/`. */
export function registerAuthRoutes(app: FastifyInstance, host: AgentHostRuntime): void {
  const registry = host.login?.registry ?? new FlowRegistry();
  const starters = { ...defaultStarters(host), ...host.login?.starters };
  app.addHook("onClose", async () => registry.cancelAll());

  const lookup = (agent: AgentKind, flowId: string): LoginFlow => {
    const flow = registry.get(flowId);
    if (!flow || flow.agent !== agent) throw new NotFoundError("로그인 플로우가 없거나 만료되었습니다");
    return flow;
  };

  app.post<{ Params: { agent: string } }>("/auth/:agent/login", async (request, reply) => {
    const agent = parseAgent(request.params.agent);
    let flow: LoginFlow;
    try {
      flow = await registry.start(agent, starters[agent]);
    } catch (err) {
      if (err instanceof AgentUnavailableError) {
        request.log.warn(`login flow unavailable (${agent}): ${err.message}`);
        return reply.code(501).send({ error: { code: "agent_unavailable", message: SSH_HINT } });
      }
      throw err;
    }
    return send(host, reply, LoginStartResponseSchema, { flowId: flow.id, url: flow.url, instructions: flow.instructions, needsCode: flow.needsCode }, 201);
  });

  app.post<{ Params: { agent: string; flowId: string }; Body: { code: string } }>(
    "/auth/:agent/login/:flowId/code",
    { preHandler: validate({ body: LoginCodeRequestSchema }) },
    async (request, reply) => {
      const flow = lookup(parseAgent(request.params.agent), request.params.flowId);
      if (!flow.needsCode || !flow.submitCode) throw new InvalidRequestError("이 플로우는 코드 입력을 받지 않습니다");
      if (flow.status !== "pending") throw new InvalidRequestError("이미 끝난 플로우입니다");
      await flow.submitCode(request.body.code);
      return send(host, reply, OkResponseSchema, { ok: true });
    },
  );

  app.get<{ Params: { agent: string; flowId: string } }>("/auth/:agent/login/:flowId", async (request, reply) => {
    const flow = lookup(parseAgent(request.params.agent), request.params.flowId);
    return send(host, reply, LoginStatusResponseSchema, { status: flow.status, message: statusMessage(flow) });
  });
}
