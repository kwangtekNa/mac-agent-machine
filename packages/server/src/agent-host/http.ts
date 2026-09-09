import type { FastifyBaseLogger, FastifyReply, FastifyServerOptions, preHandlerAsyncHookHandler } from "fastify";
import type { z } from "zod";
import type { AgentKind } from "@mam/protocol";
import type { AgentAdapter } from "../agents/types.js";
import { InternalError, InvalidRequestError } from "../errors.js";
import type { SessionManager } from "../sessions/manager.js";
import type { FlowRegistry, LoginStarter } from "./auth/flows.js";

export interface AgentHostContext {
  /** `os.userInfo().username` 과 같아야 한다. `X-MAM-User` 는 이 값과 비교만 한다. */
  user: string;
  email: string | null;
  /** realpath 된 홈. 모든 파일 접근의 샌드박스 루트. */
  home: string;
  /** 기본 `${home}/work`. 없어도 만들지 않고 응답에만 표시한다. */
  workspaceRoot: string;
  manager: SessionManager;
  /** `GET /me` probe 용. 세션 생성은 manager 가 가진 어댑터를 쓴다. */
  adapters: Partial<Record<AgentKind, AgentAdapter>>;
  serverVersion: string;
  logger?: FastifyBaseLogger | FastifyServerOptions["logger"];
  /** 응답을 프로토콜 스키마로 검증한다. 기본 `NODE_ENV !== 'production'`. */
  validateResponses?: boolean;
  /** 로그인 플로우(PROTOCOL 1절). 테스트 주입용. 기본은 실제 `claude setup-token` / codex device code. */
  login?: { registry?: FlowRegistry; starters?: Partial<Record<AgentKind, LoginStarter>> };
}

/** 라우트가 받는 컨텍스트. `validateResponses` 가 확정돼 있다. */
export interface AgentHostRuntime extends AgentHostContext {
  validateResponses: boolean;
}

export function formatIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`).join("; ");
}

export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new InvalidRequestError(formatIssues(result.error.issues));
  return result.data;
}

/** preHandler: 본문/쿼리를 zod 로 파싱해 `request.body`/`request.query` 를 파싱 결과로 바꾼다. */
export function validate(schemas: { body?: z.ZodType; query?: z.ZodType }): preHandlerAsyncHookHandler {
  return async (request) => {
    if (schemas.body) request.body = parseOrThrow(schemas.body, request.body ?? {});
    if (schemas.query) request.query = parseOrThrow(schemas.query, request.query ?? {});
  };
}

/** 응답 전송. 개발 모드에서는 스키마 위반이면 500 을 내 계약 위반을 조기에 드러낸다. 원본 payload 를 그대로 보낸다(미지 키 유지). */
export function send(host: AgentHostRuntime, reply: FastifyReply, schema: z.ZodType, payload: unknown, status = 200): FastifyReply {
  if (host.validateResponses) {
    const result = schema.safeParse(payload);
    if (!result.success) {
      reply.log.error({ url: reply.request.url, issues: formatIssues(result.error.issues) }, "response contract violation");
      throw new InternalError("response contract violation");
    }
  }
  return reply.code(status).send(payload);
}
