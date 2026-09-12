import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RoomDetailResponseSchema, parseRoomServerEvent, type Room, type RoomServerEvent } from "@mam/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotFoundError } from "../../src/errors.js";
import { RoomManager, type RoomManagerOptions } from "../../src/teams/room-manager.js";
import type { TeamRecord } from "../../src/teams/types.js";
import { DM_MINSU, GROUP_ROOM, JIYEON, MINSU, makeTeamRecord } from "../helpers/team-record.js";
import { makeTmpHome, removeTmp } from "../helpers/tmp-home.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeTmp(d);
});

async function setup(opts: Partial<RoomManagerOptions> = {}, team: TeamRecord = makeTeamRecord()) {
  const teamDir = opts.teamDir ?? join(await makeTmpHome("mam-room-"), "teams", team.id);
  if (!opts.teamDir) dirs.push(join(teamDir, "..", ".."));
  const rooms = await RoomManager.open({ teamDir, team, logger: { warn() {} }, ...opts });
  return { teamDir, team, rooms };
}

function collect(rooms: RoomManager, roomId: string, since = 0) {
  const events: RoomServerEvent[] = [];
  const done = rooms.subscribe(roomId, since, (e) => {
    parseRoomServerEvent(e); // 모든 팬아웃 이벤트가 방 프로토콜 스키마를 만족해야 한다
    events.push(e);
  });
  return { events, unsubscribe: done };
}

const user = { kind: "user" as const };
const seqs = (events: RoomServerEvent[]) => events.map((e) => e.seq);

describe("RoomManager", () => {
  it("issues per-room monotonic seq independently and fans out room.message", async () => {
    const { rooms, team } = await setup();
    const g = collect(rooms, GROUP_ROOM);
    const d = collect(rooms, DM_MINSU);
    await g.unsubscribe;
    await d.unsubscribe;
    const m1 = await rooms.post(GROUP_ROOM, { author: user, kind: "text", text: "@민수 안녕", mentions: [MINSU] });
    const m2 = await rooms.post(DM_MINSU, { author: user, kind: "text", text: "DM" });
    const m3 = await rooms.post(GROUP_ROOM, { author: { kind: "agent", memberId: MINSU }, kind: "text", text: "네", hop: 1 });
    expect([m1.seq, m3.seq]).toEqual([1, 2]);
    expect(m2.seq).toBe(1);
    expect(rooms.lastSeq(GROUP_ROOM)).toBe(2);
    expect(rooms.lastSeq(DM_MINSU)).toBe(1);
    expect(g.events.map((e) => e.type)).toEqual(["room.message", "room.message"]);
    expect(seqs(g.events)).toEqual([1, 2]);
    expect(seqs(d.events)).toEqual([1]);
    for (const e of [...g.events, ...d.events]) expect(e.teamId).toBe(team.id);
    expect(m1.id).toMatch(/^msg_/);
    expect(m1).toMatchObject({ roomId: GROUP_ROOM, mentions: [MINSU], hop: 0, dispatchId: null, work: null, approval: null, changes: null });
    expect(m3.hop).toBe(1);
  });

  it("post rejects unknown rooms and reports room changes through onRoomChanged", async () => {
    const { rooms } = await setup({ now: () => new Date("2026-09-12T10:00:00Z") });
    const changed: Room[] = [];
    rooms.onRoomChanged = (room) => changed.push(room);
    await expect(rooms.post("room_01J8ZQ4K5N7P9R3S6T8V0W2XZZ", { author: user, kind: "text", text: "x" })).rejects.toBeInstanceOf(NotFoundError);
    expect(() => rooms.lastSeq("room_01J8ZQ4K5N7P9R3S6T8V0W2XZZ")).toThrow(NotFoundError);
    await rooms.post(GROUP_ROOM, { author: user, kind: "text", text: "hi" });
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ id: GROUP_ROOM, lastSeq: 1, lastMessageAt: "2026-09-12T10:00:00.000Z" });
    await rooms.error(GROUP_ROOM, "멘션한 팀원을 찾을 수 없습니다: @철수", true);
    expect(changed[1]).toMatchObject({ lastSeq: 2, lastMessageAt: "2026-09-12T10:00:00.000Z" });
  });

  it("update emits room.message.updated with a new seq while message.seq stays", async () => {
    const { rooms } = await setup();
    const c = collect(rooms, GROUP_ROOM);
    await c.unsubscribe;
    const posted = await rooms.post(GROUP_ROOM, { author: { kind: "agent", memberId: JIYEON }, kind: "text", text: "작업 중", hop: 2 });
    await rooms.status(GROUP_ROOM, { running: [], queued: [] }, [{ memberId: JIYEON, state: "running", sessionId: null }]);
    const updated = await rooms.update(GROUP_ROOM, posted.id, { text: "완료" });
    expect(updated.seq).toBe(posted.seq);
    expect(updated.text).toBe("완료");
    expect(updated.id).toBe(posted.id);
    expect(c.events.map((e) => [e.type, e.seq])).toEqual([
      ["room.message", 1],
      ["room.status", 2],
      ["room.message.updated", 3],
    ]);
    const ev = c.events[2]!;
    if (ev.type !== "room.message.updated") throw new Error("type");
    expect(ev.message.seq).toBe(1);
    expect(ev.message.text).toBe("완료");
    await expect(rooms.update(GROUP_ROOM, "msg_01J8ZQ4K5N7P9R3S6T8V0W2XZZ", { text: "x" })).rejects.toBeInstanceOf(NotFoundError);
    const { messages } = await rooms.detail(GROUP_ROOM);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toBe("완료");
  });

  it("replays `since` from the ring buffer, from the file when the ring rolled over, then goes live", async () => {
    const { rooms } = await setup({ ringBufferSize: 3 });
    for (let i = 1; i <= 6; i += 1) await rooms.post(GROUP_ROOM, { author: user, kind: "text", text: `m${i}` });
    // 링(4,5,6) 안: since=4 → 5,6
    const inRing = collect(rooms, GROUP_ROOM, 4);
    await inRing.unsubscribe;
    expect(seqs(inRing.events)).toEqual([5, 6]);
    // 링 밖: since=1 → 파일에서 2..6
    const fromFile = collect(rooms, GROUP_ROOM, 1);
    await fromFile.unsubscribe;
    expect(seqs(fromFile.events)).toEqual([2, 3, 4, 5, 6]);
    // since=lastSeq → 아무것도 재생하지 않고 라이브만
    const live = collect(rooms, GROUP_ROOM, 6);
    await live.unsubscribe;
    expect(live.events).toEqual([]);
    await rooms.post(GROUP_ROOM, { author: user, kind: "text", text: "m7" });
    expect(seqs(live.events)).toEqual([7]);
    expect(seqs(fromFile.events)).toEqual([2, 3, 4, 5, 6, 7]);
    // 구독 해제 후에는 받지 않는다
    (await live.unsubscribe)();
    await rooms.post(GROUP_ROOM, { author: user, kind: "text", text: "m8" });
    expect(seqs(live.events)).toEqual([7]);
    expect(seqs(fromFile.events)).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });

  it("with the default ring (500) a replay from before the ring start falls back to the file without gaps", async () => {
    const { rooms } = await setup();
    for (let i = 1; i <= 505; i += 1) await rooms.post(GROUP_ROOM, { author: user, kind: "text", text: `m${i}` });
    const c = collect(rooms, GROUP_ROOM, 2);
    await c.unsubscribe;
    expect(seqs(c.events)).toEqual(Array.from({ length: 503 }, (_, i) => i + 3));
  });

  it("does not deliver live events twice while replaying from file", async () => {
    const { rooms } = await setup({ ringBufferSize: 2 });
    for (let i = 1; i <= 5; i += 1) await rooms.post(GROUP_ROOM, { author: user, kind: "text", text: `m${i}` });
    const events: RoomServerEvent[] = [];
    const subscribing = rooms.subscribe(GROUP_ROOM, 0, (e) => events.push(e));
    // 재생이 진행되는 동안 도착한 라이브 이벤트는 재생 뒤 한 번만 전달된다
    const p = rooms.post(GROUP_ROOM, { author: user, kind: "text", text: "m6" });
    await subscribing;
    await p;
    expect(seqs(events)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("re-open restores messages (with updates applied), lastSeq and the ring from the JSONL log", async () => {
    const { rooms, teamDir, team } = await setup({ ringBufferSize: 4 });
    const a = await rooms.post(GROUP_ROOM, { author: user, kind: "text", text: "a" });
    const b = await rooms.post(GROUP_ROOM, { author: { kind: "agent", memberId: MINSU }, kind: "text", text: "b", hop: 1 });
    await rooms.update(GROUP_ROOM, a.id, { text: "a2" });
    await rooms.error(GROUP_ROOM, "oops", true);
    await rooms.flush();
    const logPath = join(teamDir, "rooms", `${GROUP_ROOM}.events.jsonl`);
    const lines = (await readFile(logPath, "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(4);
    for (const line of lines) parseRoomServerEvent(JSON.parse(line));

    // team.json 의 lastSeq 가 뒤처져 있어도(0) 로그 쪽이 이긴다
    const reopened = await RoomManager.open({ teamDir, team: makeTeamRecord({ id: team.id }), logger: { warn() {} } });
    expect(reopened.lastSeq(GROUP_ROOM)).toBe(4);
    const detail = await reopened.detail(GROUP_ROOM);
    expect(RoomDetailResponseSchema.safeParse(detail).success).toBe(true);
    expect(detail.room).toMatchObject({ id: GROUP_ROOM, lastSeq: 4, lastMessageAt: b.createdAt });
    expect(detail.messages.map((m) => [m.id, m.seq, m.text])).toEqual([
      [a.id, 1, "a2"],
      [b.id, 2, "b"],
    ]);
    expect(detail.truncated).toBe(false);
    // 링이 복원됐으므로 since=2 는 파일 없이 재생된다
    const c = collect(reopened, GROUP_ROOM, 2);
    await c.unsubscribe;
    expect(seqs(c.events)).toEqual([3, 4]);
    // 이어서 발급되는 seq 는 5
    const next = await reopened.post(GROUP_ROOM, { author: user, kind: "text", text: "c" });
    expect(next.seq).toBe(5);
    // team.json 쪽 lastSeq 가 더 크면 그 값을 따른다(로그 유실 방어)
    const ahead = makeTeamRecord({ id: team.id });
    ahead.rooms[0]!.lastSeq = 42;
    const reopened2 = await RoomManager.open({ teamDir, team: ahead, logger: { warn() {} } });
    expect(reopened2.lastSeq(GROUP_ROOM)).toBe(42);
    expect((await reopened2.post(GROUP_ROOM, { author: user, kind: "text", text: "d" })).seq).toBe(43);
  });

  it("detail honours limit/truncated and messagesSince returns current state by original seq", async () => {
    const { rooms } = await setup();
    const posted = [];
    for (let i = 1; i <= 5; i += 1) posted.push(await rooms.post(GROUP_ROOM, { author: user, kind: "text", text: `m${i}` }));
    await rooms.status(GROUP_ROOM, { running: [], queued: [] }, []);
    await rooms.update(GROUP_ROOM, posted[1]!.id, { text: "m2!" }); // seq 7
    const d = await rooms.detail(GROUP_ROOM, 3);
    expect(d.truncated).toBe(true);
    expect(d.messages.map((m) => m.text)).toEqual(["m3", "m4", "m5"]);
    const full = await rooms.detail(GROUP_ROOM);
    expect(full.truncated).toBe(false);
    expect(full.messages.map((m) => m.text)).toEqual(["m1", "m2!", "m3", "m4", "m5"]);
    expect((await rooms.messagesSince(GROUP_ROOM, 1)).map((m) => m.text)).toEqual(["m2!", "m3", "m4", "m5"]);
    expect(await rooms.messagesSince(GROUP_ROOM, 5)).toEqual([]);
    // 반환된 메시지를 고쳐도 내부 상태는 바뀌지 않는다
    full.messages[0]!.text = "hacked";
    expect((await rooms.detail(GROUP_ROOM)).messages[0]!.text).toBe("m1");
  });

  it("keeps a listener exception from breaking the fan-out and logs without the message body", async () => {
    const warn = vi.fn();
    const { rooms } = await setup({ logger: { warn } });
    const got: number[] = [];
    await rooms.subscribe(GROUP_ROOM, 0, () => {
      throw new Error("boom");
    });
    await rooms.subscribe(GROUP_ROOM, 0, (e) => got.push(e.seq));
    await rooms.post(GROUP_ROOM, { author: user, kind: "text", text: "SECRET-BODY" });
    expect(got).toEqual([1]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).not.toContain("SECRET-BODY");
  });

  it("rejects drafts that do not form a valid RoomMessage without consuming a seq", async () => {
    const { rooms } = await setup();
    await expect(rooms.post(GROUP_ROOM, { author: user, kind: "text", text: "x", mentions: ["not-an-id"] })).rejects.toThrow();
    expect(rooms.lastSeq(GROUP_ROOM)).toBe(0);
    expect((await rooms.post(GROUP_ROOM, { author: user, kind: "text", text: "ok" })).seq).toBe(1);
  });

  it("addRoom registers a room created after open (new DM) with its own seq", async () => {
    const { rooms, team } = await setup();
    const room: Room = { id: "room_01J8ZQ4K5N7P9R3S6T8V0W2XR9", teamId: team.id, kind: "dm", memberId: JIYEON, name: "지연2", lastSeq: 0, lastMessageAt: null };
    await rooms.addRoom(room);
    await rooms.addRoom(room); // 멱등
    expect((await rooms.post(room.id, { author: user, kind: "text", text: "hi" })).seq).toBe(1);
    expect((await rooms.detail(room.id)).room.name).toBe("지연2");
  });
});
