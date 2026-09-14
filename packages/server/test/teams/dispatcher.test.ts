import { DispatchStateSchema, type RoomAuthor } from "@mam/protocol";
import { describe, expect, it } from "vitest";
import type { MentionResult } from "../../src/teams/mentions.js";
import { DispatchQueue, hopExceeded, nextHop, route, sideRoomParticipants, type DispatchTarget, type RoomRef } from "../../src/teams/dispatcher.js";
import { DM_JIYEON, DM_MINSU, GROUP_ROOM, JIYEON, MINSU, makeTeamRecord } from "../helpers/team-record.js";

const team = makeTeamRecord();
const HANA = "agt_01J8ZQ4K5N7P9R3S6T8V0W2XA3";
const threeMembers = {
  members: [
    ...team.members,
    { ...team.members[1]!, id: HANA, name: "하나", handle: "hana" },
  ],
};
const group = { kind: "group" as const, memberId: null };
const dmMinsu = { kind: "dm" as const, memberId: MINSU };
const user: RoomAuthor = { kind: "user" };
const asMinsu: RoomAuthor = { kind: "agent", memberId: MINSU };
const asJiyeon: RoomAuthor = { kind: "agent", memberId: JIYEON };
const mentions = (memberIds: string[], all = false): MentionResult => ({ memberIds, all, unknown: [] });
const none = mentions([]);

describe("route", () => {
  const cases: Array<{ name: string; room: typeof group | typeof dmMinsu; author: RoomAuthor; mentions: MentionResult; expected: DispatchTarget[] }> = [
    { name: "group: one mention", room: group, author: user, mentions: mentions([JIYEON]), expected: [{ memberId: JIYEON, reason: "mention" }] },
    {
      name: "group: two mentions keep order",
      room: group,
      author: user,
      mentions: mentions([JIYEON, MINSU]),
      expected: [
        { memberId: JIYEON, reason: "mention" },
        { memberId: MINSU, reason: "mention" },
      ],
    },
    { name: "group: no mention goes to the lead", room: group, author: user, mentions: none, expected: [{ memberId: MINSU, reason: "lead" }] },
    { name: "group: unknown-only mentions still go to the lead", room: group, author: user, mentions: { memberIds: [], all: false, unknown: ["철수"] }, expected: [{ memberId: MINSU, reason: "lead" }] },
    {
      name: "group: @all from the user targets everyone",
      room: group,
      author: user,
      mentions: mentions([MINSU, JIYEON], true),
      expected: [
        { memberId: MINSU, reason: "all" },
        { memberId: JIYEON, reason: "all" },
      ],
    },
    { name: "dm: only the room member, other mentions ignored", room: dmMinsu, author: user, mentions: mentions([JIYEON]), expected: [{ memberId: MINSU, reason: "dm" }] },
    { name: "dm: no mention still goes to the room member", room: dmMinsu, author: user, mentions: none, expected: [{ memberId: MINSU, reason: "dm" }] },
    { name: "dm: agent reply ends the chain", room: dmMinsu, author: asMinsu, mentions: mentions([JIYEON]), expected: [] },
    { name: "group: agent reply without mention ends the chain", room: group, author: asMinsu, mentions: none, expected: [] },
    { name: "group: agent reply with mention dispatches", room: group, author: asMinsu, mentions: mentions([JIYEON]), expected: [{ memberId: JIYEON, reason: "mention" }] },
    { name: "group: self mention is dropped", room: group, author: asJiyeon, mentions: mentions([JIYEON, MINSU]), expected: [{ memberId: MINSU, reason: "mention" }] },
    { name: "group: self-only mention ends the chain", room: group, author: asJiyeon, mentions: mentions([JIYEON]), expected: [] },
    { name: "group: system author never dispatches", room: group, author: { kind: "system" }, mentions: mentions([MINSU]), expected: [] },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(route({ team, room: c.room, author: c.author, mentions: c.mentions })).toEqual(c.expected);
    });
  }

  it("returns nothing when there is no lead and no mention", () => {
    const noLead = { members: team.members.map((m) => ({ ...m, isLead: false })) };
    expect(route({ team: noLead, room: group, author: user, mentions: none })).toEqual([]);
  });

  it("@all from an agent excludes the author and dedupes", () => {
    expect(route({ team: threeMembers, room: group, author: asMinsu, mentions: mentions([MINSU, JIYEON, HANA, JIYEON], true) })).toEqual([
      { memberId: JIYEON, reason: "all" },
      { memberId: HANA, reason: "all" },
    ]);
  });

  it("drops mentions of members that are not in the team", () => {
    expect(route({ team, room: group, author: user, mentions: mentions(["agt_01J8ZQ4K5N7P9R3S6T8V0W2XZZ", JIYEON]) })).toEqual([
      { memberId: JIYEON, reason: "mention" },
    ]);
  });
});

describe("DispatchQueue", () => {
  let counter = 0;
  const newId = (prefix: "dsp") => `${prefix}_01J8ZQ4K5N7P9R3S6T8V0W2X${String(++counter).padStart(2, "0")}`;
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 8, 12, 10, 0, tick++));
  const make = (maxConcurrent = 2) => {
    counter = 0;
    tick = 0;
    return new DispatchQueue({ maxConcurrent, now, newId });
  };
  const base = { rootId: "msg_01J8ZQ4K5N7P9R3S6T8V0W2XM1", roomId: GROUP_ROOM, sourceMessageId: "msg_01J8ZQ4K5N7P9R3S6T8V0W2XM1", hop: 1 };

  it("enqueues FIFO with dsp_ ids and enqueuedAt", () => {
    const q = make();
    const a = q.enqueue({ ...base, memberId: MINSU });
    const b = q.enqueue({ ...base, memberId: JIYEON });
    expect(a.coalesced).toBe(false);
    expect(a.item).toEqual({ ...base, memberId: MINSU, dispatchId: "dsp_01J8ZQ4K5N7P9R3S6T8V0W2X01", enqueuedAt: "2026-09-12T10:00:00.000Z" });
    expect(b.item.dispatchId).toBe("dsp_01J8ZQ4K5N7P9R3S6T8V0W2X02");
    expect(q.state().queued.map((d) => d.dispatchId)).toEqual([a.item.dispatchId, b.item.dispatchId]);
    expect(q.next()).toEqual(a.item);
    expect(q.next()).toEqual(a.item); // next() does not consume
  });

  it("runs at most maxConcurrent and keeps the third waiting", () => {
    const q = make(2);
    const a = q.enqueue({ ...base, memberId: MINSU }).item;
    const b = q.enqueue({ ...base, memberId: JIYEON }).item;
    const c = q.enqueue({ ...base, memberId: HANA }).item;
    const ra = q.markRunning(a.dispatchId, "ses_01J8ZQ4K5N7P9R3S6T8V0W2XS1");
    expect(ra).toEqual({ ...a, sessionId: "ses_01J8ZQ4K5N7P9R3S6T8V0W2XS1", turnId: null, startedAt: expect.any(String) });
    expect(q.next()).toEqual(b);
    q.markRunning(b.dispatchId, "ses_01J8ZQ4K5N7P9R3S6T8V0W2XS2");
    expect(q.next()).toBeNull();
    expect(q.isBusy(HANA)).toBe(true);
    q.setTurn(a.dispatchId, "trn_01J8ZQ4K5N7P9R3S6T8V0W2XC1");
    expect(q.state().running[0]).toEqual({
      dispatchId: a.dispatchId,
      memberId: MINSU,
      roomId: GROUP_ROOM,
      sessionId: "ses_01J8ZQ4K5N7P9R3S6T8V0W2XS1",
      turnId: "trn_01J8ZQ4K5N7P9R3S6T8V0W2XC1",
      hop: 1,
    });
    q.markDone(a.dispatchId);
    expect(q.next()).toEqual(c);
    expect(q.isBusy(MINSU)).toBe(false);
  });

  it("a member never runs two turns at once even with free slots", () => {
    const q = make(2);
    const a = q.enqueue({ ...base, memberId: MINSU }).item;
    q.markRunning(a.dispatchId, "ses_01J8ZQ4K5N7P9R3S6T8V0W2XS1");
    const b = q.enqueue({ ...base, memberId: MINSU, sourceMessageId: "msg_01J8ZQ4K5N7P9R3S6T8V0W2XM2" });
    expect(b.coalesced).toBe(false);
    expect(q.next()).toBeNull();
    const c = q.enqueue({ ...base, memberId: JIYEON }).item;
    expect(q.next()).toEqual(c);
    q.markDone(a.dispatchId);
    expect(q.next()).toEqual(b.item);
  });

  it("coalesces a new trigger into the member's existing queued item", () => {
    const q = make();
    const a = q.enqueue({ ...base, memberId: MINSU }).item;
    const again = q.enqueue({ ...base, memberId: MINSU, rootId: "msg_01J8ZQ4K5N7P9R3S6T8V0W2XM9", sourceMessageId: "msg_01J8ZQ4K5N7P9R3S6T8V0W2XM9", hop: 0 });
    expect(again).toEqual({ item: a, coalesced: true });
    expect(q.state().queued).toHaveLength(1);
  });

  it("dedupes the same (member, source) within one root even while running", () => {
    const q = make();
    const a = q.enqueue({ ...base, memberId: MINSU }).item;
    q.markRunning(a.dispatchId, "ses_01J8ZQ4K5N7P9R3S6T8V0W2XS1");
    const dup = q.enqueue({ ...base, memberId: MINSU });
    expect(dup).toEqual({ item: a, coalesced: true });
    expect(q.state().queued).toHaveLength(0);
    const otherRoot = q.enqueue({ ...base, memberId: MINSU, rootId: "msg_01J8ZQ4K5N7P9R3S6T8V0W2XM9" });
    expect(otherRoot.coalesced).toBe(false);
    expect(q.state().queued).toHaveLength(1);
  });

  it("clear removes queued items only and returns them", () => {
    const q = make();
    const a = q.enqueue({ ...base, memberId: MINSU }).item;
    const b = q.enqueue({ ...base, memberId: JIYEON }).item;
    q.markRunning(a.dispatchId, "ses_01J8ZQ4K5N7P9R3S6T8V0W2XS1");
    expect(q.clear()).toEqual([b]);
    expect(q.state()).toEqual({
      running: [{ dispatchId: a.dispatchId, memberId: MINSU, roomId: GROUP_ROOM, sessionId: "ses_01J8ZQ4K5N7P9R3S6T8V0W2XS1", turnId: null, hop: 1 }],
      queued: [],
    });
    expect(q.next()).toBeNull();
    expect(q.isBusy(JIYEON)).toBe(false);
    q.markDone(a.dispatchId);
    q.markDone(a.dispatchId); // idempotent
    expect(q.state()).toEqual({ running: [], queued: [] });
  });

  it("state() satisfies DispatchStateSchema and is a snapshot", () => {
    const q = make();
    const a = q.enqueue({ ...base, memberId: MINSU }).item;
    q.enqueue({ ...base, memberId: JIYEON, roomId: DM_JIYEON });
    q.markRunning(a.dispatchId, "ses_01J8ZQ4K5N7P9R3S6T8V0W2XS1");
    const s = q.state();
    expect(DispatchStateSchema.safeParse(s).success).toBe(true);
    expect(s.queued[0]).toEqual({ dispatchId: expect.stringMatching(/^dsp_/), memberId: JIYEON, roomId: DM_JIYEON, hop: 1, enqueuedAt: expect.any(String) });
    s.queued.length = 0;
    expect(q.state().queued).toHaveLength(1);
  });

  it("setMaxConcurrent takes effect on the next call", () => {
    const q = make(1);
    const a = q.enqueue({ ...base, memberId: MINSU }).item;
    const b = q.enqueue({ ...base, memberId: JIYEON }).item;
    q.markRunning(a.dispatchId, "ses_01J8ZQ4K5N7P9R3S6T8V0W2XS1");
    expect(q.next()).toBeNull();
    q.setMaxConcurrent(2);
    expect(q.next()).toEqual(b);
    q.setMaxConcurrent(1);
    expect(q.next()).toBeNull();
  });

  it("rejects transitions for unknown or wrong-state ids", () => {
    const q = make();
    const a = q.enqueue({ ...base, memberId: MINSU }).item;
    expect(() => q.markRunning("dsp_01J8ZQ4K5N7P9R3S6T8V0W2XZZ", "ses_01J8ZQ4K5N7P9R3S6T8V0W2XS1")).toThrow(/dsp_/);
    expect(() => q.setTurn(a.dispatchId, "trn_01J8ZQ4K5N7P9R3S6T8V0W2XC1")).toThrow(/dsp_/);
    q.markRunning(a.dispatchId, "ses_01J8ZQ4K5N7P9R3S6T8V0W2XS1");
    expect(() => q.markRunning(a.dispatchId, "ses_01J8ZQ4K5N7P9R3S6T8V0W2XS1")).toThrow(/dsp_/);
    const b = q.enqueue({ ...base, memberId: MINSU, sourceMessageId: "msg_01J8ZQ4K5N7P9R3S6T8V0W2XM2" }).item;
    expect(() => q.markRunning(b.dispatchId, "ses_01J8ZQ4K5N7P9R3S6T8V0W2XS1")).toThrow(/agt_/);
  });

  it("keeps DM room ids on items", () => {
    const q = make();
    const a = q.enqueue({ ...base, memberId: MINSU, roomId: DM_MINSU }).item;
    expect(a.roomId).toBe(DM_MINSU);
  });
});

describe("hops", () => {
  it("nextHop: user message 0, derived hop = parent + 1", () => {
    expect(nextHop(null)).toBe(0);
    expect(nextHop(0)).toBe(1);
    expect(nextHop(5)).toBe(6);
  });

  it("hopExceeded: 6 allowed, 7 exceeded with maxHops 6", () => {
    expect(hopExceeded(6, 6)).toBe(false);
    expect(hopExceeded(7, 6)).toBe(true);
    expect(hopExceeded(0, 0)).toBe(false);
    expect(hopExceeded(1, 0)).toBe(true);
  });
});

describe("route in a side room (2026-09-14)", () => {
  const sideMJ = { kind: "side" as const, memberId: null, participants: [MINSU, JIYEON] };

  it("user without a mention wakes every participant", () => {
    expect(route({ team: threeMembers, room: sideMJ, author: user, mentions: none })).toEqual([
      { memberId: MINSU, reason: "side" },
      { memberId: JIYEON, reason: "side" },
    ]);
  });

  it("user with a mention wakes only that participant", () => {
    expect(route({ team: threeMembers, room: sideMJ, author: user, mentions: mentions([JIYEON]) })).toEqual([{ memberId: JIYEON, reason: "mention" }]);
  });

  it("a user mention outside the room falls back to the participants", () => {
    expect(route({ team: threeMembers, room: sideMJ, author: user, mentions: mentions([HANA]) })).toEqual([
      { memberId: MINSU, reason: "side" },
      { memberId: JIYEON, reason: "side" },
    ]);
  });

  it("an agent dispatches only the mentioned members, self excluded", () => {
    expect(route({ team: threeMembers, room: sideMJ, author: asMinsu, mentions: mentions([MINSU, JIYEON]) })).toEqual([{ memberId: JIYEON, reason: "mention" }]);
    expect(route({ team: threeMembers, room: sideMJ, author: asMinsu, mentions: mentions([HANA]) })).toEqual([{ memberId: HANA, reason: "mention" }]);
    expect(route({ team: threeMembers, room: sideMJ, author: asMinsu, mentions: none })).toEqual([]);
  });
});

describe("sideRoomParticipants", () => {
  const SUJIN = "agt_01J8ZQ4K5N7P9R3S6T8V0W2XA4";
  const group = { kind: "group" as const, memberId: null };
  const dm = { kind: "dm" as const, memberId: MINSU };
  const sideMJ = { kind: "side" as const, memberId: null, participants: [MINSU, JIYEON] };
  const targets = (...ids: string[]): DispatchTarget[] => ids.map((memberId) => ({ memberId, reason: "mention" }));
  const pair = [MINSU, JIYEON].sort();
  const trio = [MINSU, JIYEON, HANA].sort();

  const cases: Array<{ name: string; room: RoomRef; author: RoomAuthor; targets: DispatchTarget[]; max?: number; expected: string[] | null }> = [
    { name: "group: agent calls one agent → pair", room: group, author: asMinsu, targets: targets(JIYEON), expected: pair },
    { name: "group: agent calls two agents → trio", room: group, author: asMinsu, targets: targets(JIYEON, HANA), expected: trio },
    { name: "group: agent calls three agents → over the limit, stays", room: group, author: asMinsu, targets: targets(JIYEON, HANA, SUJIN), expected: null },
    { name: "group: limit 2 keeps a trio in the group room", room: group, author: asMinsu, targets: targets(JIYEON, HANA), max: 2, expected: null },
    { name: "side: only participants → same room", room: sideMJ, author: asMinsu, targets: targets(JIYEON), expected: null },
    { name: "side: an outsider makes a new set", room: sideMJ, author: asJiyeon, targets: targets(MINSU, HANA), expected: trio },
    { name: "side: outsider only → author + target", room: sideMJ, author: asMinsu, targets: targets(HANA), expected: [MINSU, HANA].sort() },
    { name: "side: over the limit falls back to the group room", room: sideMJ, author: asMinsu, targets: targets(JIYEON, HANA, SUJIN), expected: null },
    { name: "dm: never splits", room: dm, author: asMinsu, targets: targets(JIYEON), expected: null },
    { name: "user author: never splits", room: group, author: user, targets: targets(JIYEON), expected: null },
    { name: "system author: never splits", room: group, author: { kind: "system" }, targets: targets(JIYEON), expected: null },
    { name: "no target: nothing to split", room: group, author: asMinsu, targets: [], expected: null },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(sideRoomParticipants({ author: c.author, room: c.room, targets: c.targets, maxParticipants: c.max ?? 3 })).toEqual(c.expected);
    });
  }

  it("always returns a sorted, deduped set", () => {
    const ids = sideRoomParticipants({ author: asMinsu, room: { kind: "group", memberId: null }, targets: targets(JIYEON, JIYEON), maxParticipants: 3 });
    expect(ids).toEqual([MINSU, JIYEON].sort());
    expect(ids).toEqual([...ids!].sort());
  });
});

describe("DispatchQueue.hasRoot", () => {
  let counter = 0;
  const newId = (prefix: "dsp") => `${prefix}_01J8ZQ4K5N7P9R3S6T8V0W2X${String(++counter).padStart(2, "0")}`;
  const base = { rootId: "msg_01J8ZQ4K5N7P9R3S6T8V0W2XM1", roomId: GROUP_ROOM, sourceMessageId: "msg_01J8ZQ4K5N7P9R3S6T8V0W2XM1", hop: 1 };

  it("is true while the root has a queued or running item and false once it is done", () => {
    const q = new DispatchQueue({ maxConcurrent: 2, newId });
    expect(q.hasRoot(base.rootId)).toBe(false);
    const a = q.enqueue({ ...base, memberId: MINSU }).item;
    expect(q.hasRoot(base.rootId)).toBe(true);
    q.markRunning(a.dispatchId, "ses_01J8ZQ4K5N7P9R3S6T8V0W2XS1");
    expect(q.hasRoot(base.rootId)).toBe(true);
    expect(q.hasRoot("msg_01J8ZQ4K5N7P9R3S6T8V0W2XM9")).toBe(false);
    const b = q.enqueue({ ...base, rootId: "msg_01J8ZQ4K5N7P9R3S6T8V0W2XM9", memberId: JIYEON }).item;
    q.markDone(a.dispatchId);
    expect(q.hasRoot(base.rootId)).toBe(false);
    expect(q.hasRoot(b.rootId)).toBe(true);
  });
});
