import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeAdapter, type QueryFn } from "../../../src/agents/claude/adapter.js";
import type { AgentEvent } from "../../../src/agents/types.js";
import { fakeResult, makeFakeQueryFn, type FakeHandler } from "../../helpers/fake-claude-query.js";
import { makeTmpHome, removeTmp } from "../../helpers/tmp-home.js";

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const INSTRUCTIONS = "너는 팀 backend 의 개발자 지연이다. 커밋하지 마라.";
const EXPECTED_PROMPT = { type: "preset", preset: "claude_code", append: INSTRUCTIONS };

let home: string;
beforeEach(async () => {
  home = await makeTmpHome("mam-claude-instr-");
});
afterEach(async () => {
  await removeTmp(home);
});

function adapter(queryFn: QueryFn, extra: Partial<ConstructorParameters<typeof ClaudeAdapter>[0]> = {}): ClaudeAdapter {
  return new ClaudeAdapter({ queryFn, home, binPath: "/nonexistent/claude", logger, env: { PATH: "/usr/bin" }, ...extra });
}

/** 사용자 메시지마다 result 하나로 턴을 끝내는 핸들러. */
const finishTurn: FakeHandler = async (_m, { emit }) => {
  await emit(fakeResult());
};

async function collect(events: AsyncIterable<AgentEvent>, until: (e: AgentEvent) => boolean, limit = 100): Promise<AgentEvent[]> {
  const got: AgentEvent[] = [];
  for await (const e of events) {
    got.push(e);
    if (until(e) || got.length >= limit) break;
  }
  return got;
}

describe("ClaudeAdapter instructions (역할 프롬프트)", () => {
  it("instructions 가 있으면 systemPrompt 를 claude_code 프리셋 + append 로 넘긴다", async () => {
    const { queryFn, queries } = makeFakeQueryFn(finishTurn);
    const s = await adapter(queryFn).start({ cwd: home, mode: "ask", instructions: INSTRUCTIONS });
    expect(queries).toHaveLength(1);
    const o = queries[0]!.options;
    expect(o.systemPrompt).toEqual(EXPECTED_PROMPT);
    // snapshot 은 SDK 기본값(기록)을 쓴다. 프롬프트 수정은 다음 세션부터 적용된다(PROTOCOL 6.2 next_session).
    expect(o.systemPrompt).not.toHaveProperty("snapshot");
    // 다른 옵션은 그대로다.
    expect(o).toMatchObject({ cwd: home, permissionMode: "default", includePartialMessages: true, pathToClaudeCodeExecutable: "/nonexistent/claude" });
    expect(o).not.toHaveProperty("resume");
    await s.close();
  });

  it("instructions 가 없으면 systemPrompt 키 자체를 넣지 않는다(기본 프롬프트)", async () => {
    const { queryFn, queries } = makeFakeQueryFn(finishTurn);
    const s = await adapter(queryFn).start({ cwd: home, mode: "auto-edit", model: "sonnet", effort: "high" });
    const o = queries[0]!.options;
    expect(o).not.toHaveProperty("systemPrompt");
    expect(o).toMatchObject({ cwd: home, permissionMode: "acceptEdits", model: "sonnet", effort: "high" });
    await s.close();
  });

  it("resumeNativeId 재개에서도 systemPrompt 를 함께 넘긴다", async () => {
    const { queryFn, queries } = makeFakeQueryFn(finishTurn);
    const s = await adapter(queryFn).start({ cwd: home, mode: "plan", resumeNativeId: "prev-id", instructions: INSTRUCTIONS });
    const o = queries[0]!.options;
    expect(o).toMatchObject({ resume: "prev-id", permissionMode: "plan", systemPrompt: EXPECTED_PROMPT });
    await s.close();
  });

  it("effort 변경으로 프로세스를 resume 재시작할 때도 systemPrompt 가 유지된다", async () => {
    const { queryFn, queries } = makeFakeQueryFn(finishTurn);
    const s = await adapter(queryFn).start({ cwd: home, mode: "ask", instructions: INSTRUCTIONS });
    await s.sendTurn({ text: "one" });
    await collect(s.events, (e) => e.type === "status" && e.status === "idle");
    await s.setEffort("low");
    await s.sendTurn({ text: "two" });
    expect(queries).toHaveLength(2);
    expect(queries[1]!.options).toMatchObject({ resume: expect.any(String), effort: "low", systemPrompt: EXPECTED_PROMPT });
    await s.close();
  });

  it("extraOptions 의 systemPrompt 는 instructions 보다 우선한다(통합 테스트 주입용)", async () => {
    const { queryFn, queries } = makeFakeQueryFn(finishTurn);
    const custom = { type: "preset" as const, preset: "claude_code" as const, append: "override" };
    const s = await adapter(queryFn, { extraOptions: { systemPrompt: custom } }).start({ cwd: home, mode: "ask", instructions: INSTRUCTIONS });
    expect(queries[0]!.options.systemPrompt).toEqual(custom);
    await s.close();
  });
});
