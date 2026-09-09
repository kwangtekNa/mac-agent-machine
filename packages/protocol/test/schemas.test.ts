import { describe, expect, it } from "vitest";
import {
  ApprovalRespondRequestSchema,
  ClientMessageSchema,
  ErrorResponseSchema,
  IsoDateSchema,
  SeqSchema,
  ServerEventSchema,
  SessionSchema,
  TimelineItemSchema,
  idSchema,
  parseClientMessage,
  parseServerEvent,
  safeParseClientMessage,
} from "../src/index.js";

const SES = "ses_01J8ZQ4K5N7P9R3S6T8V0W2XAB";
const ITM = "itm_01J8ZQ4K5N7P9R3S6T8V0W2XD1";
const TRN = "trn_01J8ZQ4K5N7P9R3S6T8V0W2XC1";
const APR = "apr_01J8ZQ4K5N7P9R3S6T8V0W2XE1";
const TS = "2026-09-09T10:10:00Z";

const systemItem = {
  id: ITM,
  seq: 1,
  turnId: TRN,
  kind: "system",
  status: "completed",
  createdAt: TS,
  completedAt: TS,
  payload: { text: "컨텍스트가 압축되었습니다" },
};

const deltaEvent = {
  type: "item.delta",
  seq: 5,
  sessionId: SES,
  ts: TS,
  itemId: ITM,
  field: "text",
  delta: "안녕",
};

describe("음성 케이스", () => {
  it("모르는 kind 의 TimelineItem 은 실패한다", () => {
    expect(TimelineItemSchema.safeParse({ ...systemItem, kind: "banana" }).success).toBe(false);
  });

  it("모르는 type 의 서버 이벤트는 실패한다", () => {
    expect(ServerEventSchema.safeParse({ ...deltaEvent, type: "item.exploded" }).success).toBe(false);
    expect(() => parseServerEvent({ ...deltaEvent, type: "item.exploded" })).toThrow();
  });

  it("음수 seq 와 정수가 아닌 seq 는 실패한다", () => {
    expect(SeqSchema.safeParse(-1).success).toBe(false);
    expect(SeqSchema.safeParse(1.5).success).toBe(false);
    expect(SeqSchema.safeParse(0).success).toBe(true);
    expect(ServerEventSchema.safeParse({ ...deltaEvent, seq: -1 }).success).toBe(false);
    expect(TimelineItemSchema.safeParse({ ...systemItem, seq: -3 }).success).toBe(false);
  });

  it("session.snapshot 과 pong 은 seq 0 만 허용한다", () => {
    const pong = { type: "pong", seq: 0, sessionId: SES, ts: TS };
    expect(ServerEventSchema.safeParse(pong).success).toBe(true);
    expect(ServerEventSchema.safeParse({ ...pong, seq: 1 }).success).toBe(false);
  });

  it("잘못된 mode 는 실패한다", () => {
    expect(ClientMessageSchema.safeParse({ type: "session.setMode", mode: "yolo" }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ type: "session.setMode", mode: "auto-edit" }).success).toBe(true);
  });

  it("error.code 오타는 실패한다", () => {
    expect(ErrorResponseSchema.safeParse({ error: { code: "not-found", message: "x" } }).success).toBe(false);
    expect(ErrorResponseSchema.safeParse({ error: { code: "not_found", message: "x" } }).success).toBe(true);
  });

  it("잘못된 status 의 Session 은 실패한다", () => {
    const session = {
      id: SES,
      agent: "claude",
      cwd: "/Users/alice/work/app",
      title: "t",
      mode: "ask",
      model: null,
      status: "sleeping",
      nativeId: null,
      createdAt: TS,
      updatedAt: TS,
      lastSeq: 0,
      pendingApprovals: 0,
      preview: null,
    };
    expect(SessionSchema.safeParse(session).success).toBe(false);
    expect(SessionSchema.safeParse({ ...session, status: "idle" }).success).toBe(true);
  });

  it("ID 는 접두어와 26자 ULID 를 요구한다", () => {
    const ses = idSchema("ses_");
    expect(ses.safeParse(SES).success).toBe(true);
    expect(ses.safeParse(ITM).success).toBe(false);
    expect(ses.safeParse("ses_short").success).toBe(false);
    expect(ses.safeParse("ses_01J8ZQ4K5N7P9R3S6T8V0W2XIL").success).toBe(false); // I, L 은 Crockford 에 없음
  });

  it("날짜는 ISO-8601 문자열이어야 하고 Date 로 변환하지 않는다", () => {
    expect(IsoDateSchema.safeParse("2026-09-09T10:00:00Z").success).toBe(true);
    expect(IsoDateSchema.safeParse("2026-09-09T10:00:00.123Z").success).toBe(true);
    expect(IsoDateSchema.safeParse("2026-09-09T19:00:00+09:00").success).toBe(true);
    expect(IsoDateSchema.safeParse("2026-09-09").success).toBe(false);
    expect(IsoDateSchema.safeParse("어제").success).toBe(false);
    expect(IsoDateSchema.parse(TS)).toBe(TS);
  });
});

describe("클라이언트 메시지 파싱", () => {
  it("turn.start 의 빈 text 를 거부한다 (최소 1자)", () => {
    expect(() => parseClientMessage({ type: "turn.start", text: "" })).toThrow();
    expect(safeParseClientMessage({ type: "turn.start", text: "" }).success).toBe(false);
    expect(parseClientMessage({ type: "turn.start", text: "a" })).toEqual({ type: "turn.start", text: "a" });
  });

  it("turn.start 의 attachments 는 image 만 허용한다", () => {
    const ok = { type: "turn.start", text: "이거 봐", attachments: [{ kind: "image", mediaType: "image/png", base64: "AA==" }] };
    expect(safeParseClientMessage(ok).success).toBe(true);
    const bad = { ...ok, attachments: [{ kind: "file", mediaType: "text/plain", base64: "AA==" }] };
    expect(safeParseClientMessage(bad).success).toBe(false);
  });

  it("approval.respond 는 approvalId 형식과 optionId 를 검증한다", () => {
    expect(safeParseClientMessage({ type: "approval.respond", approvalId: APR, optionId: "deny", message: "이유" }).success).toBe(true);
    expect(safeParseClientMessage({ type: "approval.respond", approvalId: APR, optionId: "submit", inputs: { branch: "main" } }).success).toBe(true);
    expect(safeParseClientMessage({ type: "approval.respond", approvalId: "apr_x", optionId: "deny" }).success).toBe(false);
    expect(safeParseClientMessage({ type: "approval.respond", approvalId: APR, optionId: "" }).success).toBe(false);
  });

  it("REST 승인 응답 본문은 approvalId 를 생략할 수 있다", () => {
    expect(ApprovalRespondRequestSchema.safeParse({ optionId: "allow" }).success).toBe(true);
    expect(ApprovalRespondRequestSchema.safeParse({ approvalId: APR, optionId: "allow" }).success).toBe(true);
  });
});

describe("알 수 없는 키", () => {
  it("모르는 키는 거부하지 않고 제거한다 (구 클라이언트 호환)", () => {
    const parsed = parseServerEvent({ ...deltaEvent, futureField: 1 });
    expect(parsed).toEqual(deltaEvent);
    expect("futureField" in parsed).toBe(false);
    expect(parseClientMessage({ type: "ping", extra: true })).toEqual({ type: "ping" });
  });

  it("payload 안의 모르는 키도 제거한다", () => {
    const parsed = TimelineItemSchema.parse({ ...systemItem, payload: { text: "x", raw: {} } });
    expect(parsed.payload).toEqual({ text: "x" });
  });
});
