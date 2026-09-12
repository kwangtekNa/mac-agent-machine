import { RolePresetSchema } from "@mam/protocol";
import { describe, expect, it } from "vitest";
import { ROLE_PRESETS, buildInstructions } from "../../src/teams/roles.js";

const team = { name: "backend", cwd: "/Users/alice/work/app" };
const teammates = [
  { name: "민수", handle: "minsu", roleLabel: "팀장", isLead: true },
  { name: "지연", handle: "jiyeon", roleLabel: "개발자", isLead: false },
];
const jiyeon = {
  name: "지연",
  handle: "jiyeon",
  roleLabel: "개발자",
  prompt: "",
  branch: "mam/backend/jiyeon",
  worktreePath: "/Users/alice/.mam/teams/team_x/worktrees/agt_y",
};

describe("ROLE_PRESETS", () => {
  it("has the five presets in RoleId order with Korean labels and English prompts", () => {
    expect(ROLE_PRESETS.map((p) => p.id)).toEqual(["developer", "planner", "team-lead", "code-reviewer", "custom"]);
    expect(ROLE_PRESETS.map((p) => p.label)).toEqual(["개발자", "기획자", "팀장", "코드 리뷰어", "커스텀"]);
    for (const p of ROLE_PRESETS) expect(RolePresetSchema.safeParse(p).success).toBe(true);
    const custom = ROLE_PRESETS.find((p) => p.id === "custom")!;
    expect(custom.prompt).toBe("");
    for (const p of ROLE_PRESETS.filter((p) => p.id !== "custom")) {
      const sentences = p.prompt.split(/[.!?](\s|$)/).filter((s) => s.trim().length > 3);
      expect(sentences.length, p.id).toBeGreaterThanOrEqual(5);
      expect(sentences.length, p.id).toBeLessThanOrEqual(10);
      expect(p.prompt).not.toMatch(/[가-힣]/);
    }
    expect(ROLE_PRESETS.find((p) => p.id === "team-lead")!.prompt).toMatch(/@/);
    expect(ROLE_PRESETS.find((p) => p.id === "planner")!.prompt).toMatch(/not .*code|do not edit/i);
    expect(ROLE_PRESETS.find((p) => p.id === "code-reviewer")!.prompt).toMatch(/diff/i);
  });
});

describe("buildInstructions", () => {
  it("prepends the role prompt and appends the team protocol block", () => {
    const text = buildInstructions({ member: { ...jiyeon, prompt: "You are a Rust expert." }, team, teammates });
    expect(text.startsWith("You are a Rust expert.")).toBe(true);
    expect(text.indexOf("You are a Rust expert.")).toBeLessThan(text.indexOf("backend"));
    // 정체성·worktree
    expect(text).toContain("지연");
    expect(text).toContain("개발자");
    expect(text).toContain('"backend"');
    expect(text).toContain("/Users/alice/work/app");
    expect(text).toContain(jiyeon.worktreePath);
    expect(text).toContain("mam/backend/jiyeon");
    // 메시지 형식
    expect(text).toContain("[#전체] 사용자:");
    expect(text).toContain("[DM] 사용자:");
    expect(text).toContain("[#전체] @민수(개발자):");
    expect(text).toContain("[#전체] 시스템:");
    // 한국어 답변, 멘션 규칙, 동료 목록(팀장 표시), 자기 자신 금지
    expect(text).toMatch(/answer in Korean/i);
    expect(text).toContain("@minsu");
    expect(text).toContain("민수");
    expect(text).toMatch(/lead/i);
    expect(text).toMatch(/do not mention yourself/i);
    // git 금지 + 서버 커밋 + 요약
    expect(text).toMatch(/git commit/);
    expect(text).toMatch(/push/);
    expect(text).toMatch(/merge/);
    expect(text).toMatch(/rebase/);
    expect(text).toMatch(/checkout/);
    expect(text).toMatch(/server commits/i);
    expect(text).toMatch(/1.{0,3}3 line/i);
  });

  it("uses the preset prompt when member.prompt is empty and a role is known", () => {
    const text = buildInstructions({ member: { ...jiyeon, role: "developer" }, team, teammates });
    expect(text.startsWith(ROLE_PRESETS[0]!.prompt)).toBe(true);
  });

  it("still attaches the protocol block for a custom role with an empty prompt", () => {
    const text = buildInstructions({ member: { ...jiyeon, role: "custom", roleLabel: "번역가" }, team, teammates: [] });
    expect(text.trim().length).toBeGreaterThan(200);
    expect(text).toContain("번역가");
    expect(text).toMatch(/answer in Korean/i);
    expect(text).toMatch(/git commit/);
    expect(text).not.toMatch(/^\s*\n/); // 빈 프롬프트로 시작하지 않는다
  });

  it("lists every teammate except the member themself, marking the lead", () => {
    const text = buildInstructions({ member: jiyeon, team, teammates });
    const list = text.slice(text.indexOf("Teammates"));
    expect(list).toContain("@minsu");
    expect(list).toMatch(/민수.*lead/i);
    expect(list).not.toMatch(/@jiyeon/);
  });
});
