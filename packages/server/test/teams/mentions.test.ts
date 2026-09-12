import { describe, expect, it } from "vitest";
import { normalizeName, parseMentions } from "../../src/teams/mentions.js";

const members = [
  { id: "agt_1", name: "민수", handle: "minsu" },
  { id: "agt_2", name: "지연", handle: "jiyeon" },
  { id: "agt_3", name: "Alice Kim", handle: "alice" },
];

describe("normalizeName", () => {
  it("applies NFC, lowercases and trims", () => {
    expect(normalizeName("  Alice ")).toBe("alice");
    expect(normalizeName("민수".normalize("NFD"))).toBe("민수");
    expect(normalizeName("MİNSU").length).toBeGreaterThan(0);
  });
});

describe("parseMentions", () => {
  it("resolves Korean names and ascii handles", () => {
    expect(parseMentions("@민수 로그인 버그 고쳐줘", members)).toEqual({ memberIds: ["agt_1"], all: false, unknown: [] });
    expect(parseMentions("done, ping @jiyeon", members)).toEqual({ memberIds: ["agt_2"], all: false, unknown: [] });
    expect(parseMentions("@Alice 확인", members).memberIds).toEqual(["agt_3"]);
  });

  it("is case-insensitive and NFC-normalized", () => {
    expect(parseMentions("@MINSU @Jiyeon", members).memberIds).toEqual(["agt_1", "agt_2"]);
    expect(parseMentions(`@${"민수".normalize("NFD")} 부탁`, members).memberIds).toEqual(["agt_1"]);
  });

  it("strips trailing punctuation from the token", () => {
    expect(parseMentions("@민수, 그리고 @jiyeon. 끝 @alice!", members).memberIds).toEqual(["agt_1", "agt_2", "agt_3"]);
    expect(parseMentions("(@minsu) [@jiyeon] \"@alice\" @민수:", members).memberIds).toEqual(["agt_1", "agt_2", "agt_3"]);
  });

  it("@all expands to everyone except the author", () => {
    expect(parseMentions("@all 회의합시다", members)).toEqual({ memberIds: ["agt_1", "agt_2", "agt_3"], all: true, unknown: [] });
    expect(parseMentions("@ALL 확인", members, { excludeMemberId: "agt_2" })).toEqual({
      memberIds: ["agt_1", "agt_3"],
      all: true,
      unknown: [],
    });
  });

  it("drops the author from explicit mentions", () => {
    expect(parseMentions("@민수 @지연 같이 봐줘", members, { excludeMemberId: "agt_1" }).memberIds).toEqual(["agt_2"]);
    expect(parseMentions("@minsu 나야", members, { excludeMemberId: "agt_1" })).toEqual({ memberIds: [], all: false, unknown: [] });
  });

  it("reports unknown tokens without touching known ones", () => {
    expect(parseMentions("@철수 그리고 @minsu, @nobody.", members)).toEqual({
      memberIds: ["agt_1"],
      all: false,
      unknown: ["철수", "nobody"],
    });
  });

  it("dedupes repeated mentions of the same member", () => {
    expect(parseMentions("@민수 @minsu @MINSU @민수!", members).memberIds).toEqual(["agt_1"]);
    expect(parseMentions("@x @x", members).unknown).toEqual(["x"]);
  });

  it("ignores text without mentions and lone @", () => {
    expect(parseMentions("멘션 없음 @ 끝", members)).toEqual({ memberIds: [], all: false, unknown: [] });
    expect(parseMentions("", members)).toEqual({ memberIds: [], all: false, unknown: [] });
  });
});
