import { describe, expect, it } from "vitest";
import { normalizeRemoteAddress, parseWhois, StaticIdentityResolver, TailscaleIdentityResolver } from "../../src/gateway/identity.js";
import { UserDirectory } from "../../src/gateway/users.js";

const USER = { Node: { Name: "iphone.tail1234.ts.net." }, UserProfile: { LoginName: "Alice@Example.com", DisplayName: "Alice" } };
const TAGGED = { Node: { Name: "ci.tail1234.ts.net.", Tags: ["tag:ci"] } };

describe("identity", () => {
  it("parses whois: user node → identity, tagged node → null", () => {
    expect(parseWhois(USER)).toEqual({ email: "alice@example.com", displayName: "Alice", node: "iphone.tail1234.ts.net." });
    expect(parseWhois(TAGGED)).toBeNull();
    expect(parseWhois({})).toBeNull();
  });
  it("normalizes addresses", () => {
    expect(normalizeRemoteAddress("::ffff:100.64.0.1")).toBe("100.64.0.1");
    expect(normalizeRemoteAddress("fe80::1%utun3")).toBe("fe80::1");
    expect(normalizeRemoteAddress("[fd7a::1]")).toBe("fd7a::1");
  });
  it("runs tailscale whois, returns null on failure, caches with ttl", async () => {
    const calls: string[][] = [];
    let t = 0;
    let code = 0;
    const r = new TailscaleIdentityResolver({ tailscaleBin: "/ts", ttlMs: 1000, now: () => t, exec: async (bin, args) => (calls.push([bin, ...args]), { stdout: JSON.stringify(USER), code }) });
    expect(await r.resolve("::ffff:100.64.0.1")).toMatchObject({ email: "alice@example.com" });
    expect(calls).toEqual([["/ts", "whois", "--json", "100.64.0.1"]]);
    t = 500;
    await r.resolve("100.64.0.1");
    expect(calls).toHaveLength(1);
    t = 1500;
    code = 1;
    expect(await r.resolve("100.64.0.1")).toBeNull();
    expect(calls).toHaveLength(2);
    expect(await r.resolve("100.64.0.1")).toBeNull(); // null 도 캐시
    expect(calls).toHaveLength(2);
    expect(await r.resolve("not-an-ip")).toBeNull();
    expect(calls).toHaveLength(2);
  });
  it("static resolver and case-insensitive user directory", async () => {
    expect(await new StaticIdentityResolver({ email: "me@dev.local" }).resolve("x")).toEqual({ email: "me@dev.local" });
    const d = new UserDirectory([{ macUser: "alice", email: "alice@example.com", workspaceRoot: "~/work" }]);
    expect(d.byEmail("ALICE@Example.COM")?.macUser).toBe("alice");
    expect(d.byEmail("bob@example.com")).toBeNull();
    expect(d.list()).toHaveLength(1);
  });
});
