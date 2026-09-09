import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "@mam/protocol";
import { describe, expect, it, vi } from "vitest";
import { EventLog } from "../../src/sessions/event-log.js";

const SID = "ses_01J8ZQ4K5N7P9R3S6T8V0W2XAB";
const ev = (seq: number): ServerEvent => ({
  type: "session.status",
  seq,
  sessionId: SID,
  ts: "2026-09-09T10:00:00Z",
  status: "idle",
  mode: "ask",
});

async function tmpFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "mam-log-")), "s.events.jsonl");
}

describe("EventLog", () => {
  it("returns nothing for a missing file", async () => {
    const log = new EventLog(await tmpFile());
    const got = [];
    for await (const e of log.readSince(0)) got.push(e);
    expect(got).toEqual([]);
    expect(await log.tail(5)).toEqual([]);
  });

  it("appends one JSON line per event in order and reads since/tail", async () => {
    const path = await tmpFile();
    const log = new EventLog(path);
    await Promise.all([1, 2, 3, 4].map((n) => log.append(ev(n))));
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    expect(lines.map((l) => (JSON.parse(l) as ServerEvent).seq)).toEqual([1, 2, 3, 4]);
    const since2 = [];
    for await (const e of log.readSince(2)) since2.push(e.seq);
    expect(since2).toEqual([3, 4]);
    expect((await log.tail(2)).map((e) => e.seq)).toEqual([3, 4]);
  });

  it("skips corrupted lines with a warning", async () => {
    const path = await tmpFile();
    const warn = vi.fn();
    await writeFile(
      path,
      [JSON.stringify(ev(1)), "{not json", JSON.stringify({ type: "bogus", seq: 2 }), JSON.stringify(ev(3)), ""].join("\n"),
    );
    const log = new EventLog(path, { warn });
    const got = [];
    for await (const e of log.readSince(0)) got.push(e.seq);
    expect(got).toEqual([1, 3]);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
