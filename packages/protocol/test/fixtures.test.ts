import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import {
  ClientMessageSchema,
  ErrorResponseSchema,
  FsListResponseSchema,
  FsMkdirResponseSchema,
  FsReadResponseSchema,
  GitDiffResponseSchema,
  GitStatusResponseSchema,
  LoginStartResponseSchema,
  LoginStatusResponseSchema,
  MeResponseSchema,
  ModelsResponseSchema,
  ProjectsResponseSchema,
  ServerEventSchema,
  SessionDetailResponseSchema,
  SessionSchema,
  SessionsResponseSchema,
  UsageResponseSchema,
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
  "fs-mkdir": FsMkdirResponseSchema,
  "git-status": GitStatusResponseSchema,
  "git-diff": GitDiffResponseSchema,
  error: ErrorResponseSchema,
  "login-start": LoginStartResponseSchema,
  "login-status": LoginStatusResponseSchema,
  usage: UsageResponseSchema,
  "usage-empty": UsageResponseSchema,
  "models-claude": ModelsResponseSchema,
  "models-codex": ModelsResponseSchema,
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
  "session.usage": { type: "session.usage" },
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

/** 2026-09-10 추가분(사용량·모델·mkdir). 라운드트립 테스트가 최소한 이 파일들을 반드시 포함해야 한다. */
const ADDED_2026_09_10 = [
  "rest/usage",
  "rest/usage-empty",
  "rest/models-claude",
  "rest/models-codex",
  "rest/fs-mkdir",
  "ws/session.usage",
];

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

/** 모든 fixture 의 (디렉토리, 이름, 스키마) 목록. */
function allFixtures(): Array<{ dir: string; name: string; schema: ZodType }> {
  return [
    ...Object.entries(REST).map(([name, schema]) => ({ dir: "rest", name, schema })),
    ...Object.keys(WS).map((name) => ({ dir: "ws", name, schema: ServerEventSchema as ZodType })),
    ...Object.keys(CLIENT).map((name) => ({ dir: "client", name, schema: ClientMessageSchema as ZodType })),
  ];
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
  it("2026-09-10 추가분이 전부 매핑표에 있다", () => {
    const keys = new Set(allFixtures().map((f) => `${f.dir}/${f.name}`));
    for (const added of ADDED_2026_09_10) expect(keys.has(added), added).toBe(true);
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

  it("session 과 session-detail 의 Session 은 effort 와 usage(컨텍스트 포함)를 채운다", () => {
    for (const session of [
      SessionSchema.parse(loadFixture("rest", "session")),
      SessionDetailResponseSchema.parse(loadFixture("rest", "session-detail")).session,
    ]) {
      expect(session.effort).toEqual(expect.any(String));
      expect(session.usage).not.toBeNull();
      expect(session.usage?.context).not.toBeNull();
      expect(session.usage?.turns).toBeGreaterThan(0);
    }
  });

  it("sessions 의 두 번째 항목은 첫 턴 전이라 usage 와 effort 가 null 이다", () => {
    const { sessions } = SessionsResponseSchema.parse(loadFixture("rest", "sessions"));
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(sessions[0]?.usage).not.toBeNull();
    expect(sessions[0]?.effort).not.toBeNull();
    expect(sessions[1]?.usage).toBeNull();
    expect(sessions[1]?.effort).toBeNull();
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

  it("fs-mkdir 은 만든 디렉토리의 FsEntry(type dir) 를 돌려준다", () => {
    const { entry } = FsMkdirResponseSchema.parse(loadFixture("rest", "fs-mkdir"));
    expect(entry.type).toBe("dir");
    expect(entry.size).toBeNull();
    expect(entry.path.endsWith(`/${entry.name}`)).toBe(true);
  });

  it("usage 는 claude(live:false) 와 codex(live:true) 를 담고 status ok/warning 을 섞는다", () => {
    const { agents } = UsageResponseSchema.parse(loadFixture("rest", "usage"));
    expect(agents.map((a) => a.kind).sort()).toEqual(["claude", "codex"]);
    const claude = agents.find((a) => a.kind === "claude");
    const codex = agents.find((a) => a.kind === "codex");
    expect(claude?.live).toBe(false);
    expect(codex?.live).toBe(true);
    expect(claude?.observedAt).toEqual(expect.any(String));
    const statuses = new Set(agents.flatMap((a) => a.limits.map((l) => l.status)));
    expect(statuses.has("ok") && statuses.has("warning")).toBe(true);
    for (const limit of agents.flatMap((a) => a.limits)) {
      // 문서 규칙: 80 미만 ok, 80 이상 warning, 100 이상 exceeded
      const expected = limit.usedPercent >= 100 ? "exceeded" : limit.usedPercent >= 80 ? "warning" : "ok";
      expect(limit.status, limit.id).toBe(expected);
    }
  });

  it("usage-empty 는 관측값이 없어 limits [] 와 observedAt null 이다", () => {
    const { agents } = UsageResponseSchema.parse(loadFixture("rest", "usage-empty"));
    expect(agents.length).toBeGreaterThan(0);
    for (const agent of agents) {
      expect(agent.limits).toEqual([]);
      expect(agent.observedAt).toBeNull();
      expect(agent.plan).toBeNull();
    }
  });

  it("models-claude 와 models-codex 는 기본 모델 하나와 effort 지원/미지원 모델을 담는다", () => {
    for (const name of ["models-claude", "models-codex"]) {
      const { models } = ModelsResponseSchema.parse(loadFixture("rest", name));
      expect(models.filter((m) => m.isDefault), name).toHaveLength(1);
      expect(models.some((m) => m.efforts.length > 0), name).toBe(true);
      for (const model of models) {
        if (model.efforts.length === 0) expect(model.defaultEffort, model.id).toBeNull();
        if (model.defaultEffort !== null) expect(model.efforts, model.id).toContain(model.defaultEffort);
      }
    }
    const claude = ModelsResponseSchema.parse(loadFixture("rest", "models-claude")).models;
    expect(claude.some((m) => m.efforts.length === 0 && m.description === null)).toBe(true);
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

  it("session.usage 의 usage 는 Session.usage 와 같은 객체이며 percent 는 0~100 이다", () => {
    const event = ServerEventSchema.parse(loadFixture("ws", "session.usage"));
    if (event.type !== "session.usage") throw new Error("type mismatch");
    expect(SessionSchema.shape.usage.unwrap().unwrap().safeParse(event.usage).success).toBe(true);
    expect(event.usage.context?.percent).toBeGreaterThanOrEqual(0);
    expect(event.usage.context?.percent).toBeLessThanOrEqual(100);
  });

  it("session.snapshot 의 Session 도 effort 와 usage 를 담는다", () => {
    const event = ServerEventSchema.parse(loadFixture("ws", "session.snapshot"));
    if (event.type !== "session.snapshot") throw new Error("type mismatch");
    expect(event.session.effort).toEqual(expect.any(String));
    expect(event.session.usage?.context?.window).toBeGreaterThan(0);
  });
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

describe("라운드트립 (parse → JSON → parse 무손실)", () => {
  for (const { dir, name, schema } of allFixtures()) {
    it(`${dir}/${name}.json`, () => {
      const input = loadFixture(dir, name);
      const first = schema.parse(input);
      const second = schema.parse(JSON.parse(JSON.stringify(first)));
      expect(second).toEqual(first);
      expect(second).toEqual(input);
    });
  }
});
