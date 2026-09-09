import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import {
  ClientMessageSchema,
  ErrorResponseSchema,
  FsListResponseSchema,
  FsReadResponseSchema,
  GitDiffResponseSchema,
  GitStatusResponseSchema,
  LoginStartResponseSchema,
  LoginStatusResponseSchema,
  MeResponseSchema,
  ProjectsResponseSchema,
  ServerEventSchema,
  SessionDetailResponseSchema,
  SessionSchema,
  SessionsResponseSchema,
} from "../src/index.js";

const FIXTURES_DIR = fileURLToPath(new URL("../fixtures/", import.meta.url));

/** `rest/<name>.json` → 응답 스키마. */
const REST: Record<string, ZodType> = {
  me: MeResponseSchema,
  projects: ProjectsResponseSchema,
  sessions: SessionsResponseSchema,
  session: SessionSchema,
  "session-detail": SessionDetailResponseSchema,
  "fs-list": FsListResponseSchema,
  "fs-read-text": FsReadResponseSchema,
  "fs-read-image": FsReadResponseSchema,
  "git-status": GitStatusResponseSchema,
  "git-diff": GitDiffResponseSchema,
  error: ErrorResponseSchema,
  "login-start": LoginStartResponseSchema,
  "login-status": LoginStatusResponseSchema,
};

/** `ws/<type>[.<variant>].json` → 기대하는 `type` 과 (있으면) 아이템 kind / 승인 kind. */
const WS: Record<string, { type: string; itemKind?: string; approvalKind?: string }> = {
  "session.snapshot": { type: "session.snapshot" },
  "item.started.user_message": { type: "item.started", itemKind: "user_message" },
  "item.started.assistant_message": { type: "item.started", itemKind: "assistant_message" },
  "item.started.reasoning": { type: "item.started", itemKind: "reasoning" },
  "item.started.tool_call": { type: "item.started", itemKind: "tool_call" },
  "item.started.file_change": { type: "item.started", itemKind: "file_change" },
  "item.started.plan": { type: "item.started", itemKind: "plan" },
  "item.started.approval": { type: "item.started", itemKind: "approval" },
  "item.started.turn_summary": { type: "item.started", itemKind: "turn_summary" },
  "item.started.error": { type: "item.started", itemKind: "error" },
  "item.started.system": { type: "item.started", itemKind: "system" },
  "item.delta": { type: "item.delta" },
  "item.completed.tool_call": { type: "item.completed", itemKind: "tool_call" },
  "approval.requested.command": { type: "approval.requested", approvalKind: "command" },
  "approval.requested.file_change": { type: "approval.requested", approvalKind: "file_change" },
  "approval.requested.permission": { type: "approval.requested", approvalKind: "permission" },
  "approval.requested.user_input": { type: "approval.requested", approvalKind: "user_input" },
  "approval.resolved": { type: "approval.resolved" },
  "session.status": { type: "session.status" },
  "turn.completed": { type: "turn.completed" },
  error: { type: "error" },
  pong: { type: "pong" },
};

/** `client/<type>.json` → 기대하는 `type`. */
const CLIENT: Record<string, { type: string }> = {
  "turn.start": { type: "turn.start" },
  "turn.interrupt": { type: "turn.interrupt" },
  "approval.respond": { type: "approval.respond" },
  "session.setMode": { type: "session.setMode" },
  ping: { type: "ping" },
};

function listFixtures(dir: string): string[] {
  return readdirSync(join(FIXTURES_DIR, dir))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .sort();
}

function loadFixture(dir: string, name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, dir, `${name}.json`), "utf8"));
}

/** 파싱 결과가 입력과 같아야 한다. 다르면 fixture 에 스키마가 모르는 키가 있어 strip 된 것이다. */
function expectLossless(schema: ZodType, input: unknown): unknown {
  const parsed = schema.parse(input);
  expect(parsed).toEqual(input);
  return parsed;
}

describe("fixtures ↔ 매핑 테이블 (누락 방지)", () => {
  it("rest/ 의 모든 파일이 테이블에 있고, 테이블의 모든 항목이 파일로 있다", () => {
    expect(listFixtures("rest")).toEqual(Object.keys(REST).sort());
  });
  it("ws/ 의 모든 파일이 테이블에 있고, 테이블의 모든 항목이 파일로 있다", () => {
    expect(listFixtures("ws")).toEqual(Object.keys(WS).sort());
  });
  it("client/ 의 모든 파일이 테이블에 있고, 테이블의 모든 항목이 파일로 있다", () => {
    expect(listFixtures("client")).toEqual(Object.keys(CLIENT).sort());
  });
  it("모든 서버 이벤트 타입과 아이템 kind, 승인 kind 에 fixture 가 있다", () => {
    const eventTypes = new Set(Object.values(WS).map((w) => w.type));
    expect([...eventTypes].sort()).toEqual(
      ServerEventSchema.options.map((o) => o.shape.type.value).sort(),
    );
    const itemKinds = new Set(Object.values(WS).flatMap((w) => (w.itemKind ? [w.itemKind] : [])));
    expect([...itemKinds].sort()).toEqual(
      [
        "approval",
        "assistant_message",
        "error",
        "file_change",
        "plan",
        "reasoning",
        "system",
        "tool_call",
        "turn_summary",
        "user_message",
      ].sort(),
    );
    const clientTypes = new Set(Object.values(CLIENT).map((c) => c.type));
    expect([...clientTypes].sort()).toEqual(
      ClientMessageSchema.options.map((o) => o.shape.type.value).sort(),
    );
  });
});

describe("rest fixtures", () => {
  for (const [name, schema] of Object.entries(REST)) {
    it(`rest/${name}.json 이 스키마를 통과한다`, () => {
      expectLossless(schema, loadFixture("rest", name));
    });
  }

  it("session-detail 은 kind 가 다양한 아이템 5개 이상을 담는다", () => {
    const detail = SessionDetailResponseSchema.parse(loadFixture("rest", "session-detail"));
    expect(detail.items.length).toBeGreaterThanOrEqual(5);
    expect(new Set(detail.items.map((i) => i.kind)).size).toBeGreaterThanOrEqual(5);
    const seqs = detail.items.map((i) => i.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(detail.session.lastSeq).toBeGreaterThanOrEqual(seqs.at(-1) ?? 0);
  });

  it("fs-list 는 dir/file/symlink 와 여러 gitStatus 값을 섞어 담는다", () => {
    const list = FsListResponseSchema.parse(loadFixture("rest", "fs-list"));
    const types = new Set(list.entries.map((e) => e.type));
    expect(types.has("dir") && types.has("file") && types.has("symlink")).toBe(true);
    const statuses = new Set(list.entries.map((e) => e.gitStatus));
    expect(statuses.has(null)).toBe(true);
    expect(statuses.size).toBeGreaterThanOrEqual(3);
  });

  it("fs-read-text 는 utf8, fs-read-image 는 base64 다", () => {
    const text = FsReadResponseSchema.parse(loadFixture("rest", "fs-read-text"));
    expect(text.isBinary).toBe(false);
    expect(text.encoding).toBe("utf8");
    const image = FsReadResponseSchema.parse(loadFixture("rest", "fs-read-image"));
    expect(image.isBinary).toBe(true);
    expect(image.encoding).toBe("base64");
    expect(() => Buffer.from(image.content, "base64")).not.toThrow();
  });
});

describe("ws fixtures", () => {
  for (const [name, expected] of Object.entries(WS)) {
    it(`ws/${name}.json 이 ServerEventSchema 를 통과하고 type 이 ${expected.type} 이다`, () => {
      const event = expectLossless(ServerEventSchema, loadFixture("ws", name)) as {
        type: string;
        seq: number;
        item?: { kind: string };
        approval?: { kind: string };
      };
      expect(event.type).toBe(expected.type);
      if (expected.itemKind) expect(event.item?.kind).toBe(expected.itemKind);
      if (expected.approvalKind) expect(event.approval?.kind).toBe(expected.approvalKind);
      if (expected.type === "session.snapshot" || expected.type === "pong") {
        expect(event.seq).toBe(0);
      } else {
        expect(event.seq).toBeGreaterThan(0);
      }
    });
  }
});

describe("client fixtures", () => {
  for (const [name, expected] of Object.entries(CLIENT)) {
    it(`client/${name}.json 이 ClientMessageSchema 를 통과하고 type 이 ${expected.type} 이다`, () => {
      const message = expectLossless(ClientMessageSchema, loadFixture("client", name)) as {
        type: string;
      };
      expect(message.type).toBe(expected.type);
    });
  }
});
