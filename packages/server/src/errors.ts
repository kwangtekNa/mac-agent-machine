import type { ErrorCode, ErrorResponse } from "@mam/protocol";

/** 서버 공통 오류. `code` 는 PROTOCOL.md 0절의 값, `status` 는 대응 HTTP 상태. */
export class MamError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message: string, status: number) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
  }

  toResponse(): ErrorResponse {
    return { error: { code: this.code, message: this.message } };
  }
}

export class NotFoundError extends MamError {
  constructor(message = "찾을 수 없습니다") {
    super("not_found", message, 404);
  }
}

export class ForbiddenError extends MamError {
  constructor(message = "접근이 거부되었습니다") {
    super("forbidden", message, 403);
  }
}

export class InvalidRequestError extends MamError {
  constructor(message = "잘못된 요청입니다") {
    super("invalid_request", message, 400);
  }
}

export class ConflictError extends MamError {
  constructor(message = "현재 상태에서 수행할 수 없습니다") {
    super("conflict", message, 409);
  }
}

export class AgentUnavailableError extends MamError {
  constructor(message = "에이전트를 사용할 수 없습니다") {
    super("agent_unavailable", message, 503);
  }
}

export class InternalError extends MamError {
  constructor(message = "내부 오류") {
    super("internal", message, 500);
  }
}

export class SessionNotFoundError extends NotFoundError {
  constructor(id: string) {
    super(`세션을 찾을 수 없습니다: ${id}`);
  }
}

export class SessionBusyError extends ConflictError {
  constructor(id: string) {
    super(`세션이 이미 턴을 실행 중입니다: ${id}`);
  }
}

export class SessionClosedError extends ConflictError {
  constructor(id: string) {
    super(`세션이 닫혔습니다: ${id}`);
  }
}

export class ApprovalNotFoundError extends NotFoundError {
  constructor(approvalId: string) {
    super(`승인 요청을 찾을 수 없습니다: ${approvalId}`);
  }
}

export class ApprovalAlreadyResolvedError extends ConflictError {
  constructor(approvalId: string) {
    super(`이미 처리된 승인 요청입니다: ${approvalId}`);
  }
}
