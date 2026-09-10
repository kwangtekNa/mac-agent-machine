import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentUsageSnapshot } from "../../src/agents/types.js";
import { RateLimitStore } from "../../src/usage/rate-limit-store.js";

const snapshot: AgentUsageSnapshot = {
  plan: "max",
  live: false,
  observedAt: new Date("2026-09-10T03:40:00Z"),
  limits: [
    { id: "five_hour", usedPercent: 42, windowMinutes: 300, resetsAt: new Date("2026-09-10T06:00:00Z") },
    { id: "seven_day", usedPercent: 81, windowMinutes: null, resetsAt: null, rejected: true },
  ],
};

describe("RateLimitStore", () => {
  it("saves to <dataDir>/usage/<kind>.json atomically and loads it back with Dates", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "mam-rl-"));
    const store = new RateLimitStore(dataDir);
    expect(await store.load("claude")).toBeNull();
    await store.save("claude", snapshot);
    expect(await readdir(join(dataDir, "usage"))).toEqual(["claude.json"]);
    expect(await store.load("claude")).toEqual(snapshot);
    expect(await store.load("codex")).toBeNull();
  });

  it("load with maxAgeMs returns null when the saved snapshot is older", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "mam-rl-"));
    let t = Date.parse("2026-09-10T04:00:00Z");
    const store = new RateLimitStore(dataDir, { now: () => new Date(t) });
    await store.save("codex", snapshot);
    t += 59_000;
    expect(await store.load("codex", 60_000)).toEqual(snapshot);
    t += 2_000;
    expect(await store.load("codex", 60_000)).toBeNull();
    expect(await store.load("codex")).toEqual(snapshot);
  });

  it("returns null for a corrupt file instead of throwing", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "mam-rl-"));
    const store = new RateLimitStore(dataDir);
    await store.save("claude", snapshot);
    await writeFile(join(dataDir, "usage", "claude.json"), "{not json", "utf8");
    expect(await store.load("claude")).toBeNull();
  });
});
