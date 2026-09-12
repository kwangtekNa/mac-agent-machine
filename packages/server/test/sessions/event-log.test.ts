import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "@mam/protocol";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { EventLog, JsonlLog } from "../../src/sessions/event-log.js";

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

describe("JsonlLog (generic)", () => {
  const RowSchema = z.object({ seq: z.int().min(0), name: z.string() });
  type Row = z.infer<typeof RowSchema>;
  const row = (seq: number): Row => ({ seq, name: `r${seq}` });

  it("works with an arbitrary schema: append order, readSince, tail", async () => {
    const path = await tmpFile();
    const log = new JsonlLog<Row>(path, RowSchema);
    await Promise.all([1, 2, 3].map((n) => log.append(row(n))));
    await log.flush();
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    expect(lines.map((l) => JSON.parse(l) as Row)).toEqual([row(1), row(2), row(3)]);
    const since1: Row[] = [];
    for await (const r of log.readSince(1)) since1.push(r);
    expect(since1).toEqual([row(2), row(3)]);
    expect(await log.tail(1)).toEqual([row(3)]);
    expect(await log.tail(0)).toEqual([]);
  });

  it("skips corrupted or schema-mismatched lines with a warning", async () => {
    const path = await tmpFile();
    const warn = vi.fn();
    await writeFile(path, [JSON.stringify(row(1)), "garbage", JSON.stringify({ seq: 2 }), JSON.stringify(row(3))].join("\n") + "\n");
    const log = new JsonlLog<Row>(path, RowSchema, { warn });
    const got: number[] = [];
    for await (const r of log.readSince(0)) got.push(r.seq);
    expect(got).toEqual([1, 3]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("EventLog is a JsonlLog over ServerEventSchema (session events still round-trip)", async () => {
    const log = new EventLog(await tmpFile());
    expect(log).toBeInstanceOf(JsonlLog);
    await log.append(ev(7));
    expect((await log.tail(1)).map((e) => e.seq)).toEqual([7]);
  });
});
