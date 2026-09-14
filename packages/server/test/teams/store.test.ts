import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TeamSchema, TeamTemplateSchema, type TeamTemplate } from "@mam/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newId } from "../../src/ids.js";
import { TeamStore, makeHandle, slug, toTeam } from "../../src/teams/store.js";
import { TeamRecordSchema } from "../../src/teams/types.js";
import { makeTeamRecord } from "../helpers/team-record.js";
import { makeTmpHome, removeTmp } from "../helpers/tmp-home.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeTmp(d);
});

async function setup() {
  const dataDir = await makeTmpHome("mam-teams-");
  dirs.push(dataDir);
  return { dataDir, store: new TeamStore(dataDir, { warn() {} }) };
}

const mode = async (p: string) => (await stat(p)).mode & 0o777;

describe("TeamStore", () => {
  it("save → load round-trips the record and creates 0700 dirs with tmp+rename", async () => {
    const { dataDir, store } = await setup();
    const record = makeTeamRecord();
    record.members[0]!.lastSeen = { [record.rooms[0]!.id]: 7 };
    await store.save(record);
    const teamDir = join(dataDir, "teams", record.id);
    expect(await mode(join(dataDir, "teams"))).toBe(0o700);
    expect(await mode(teamDir)).toBe(0o700);
    expect((await readdir(teamDir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    const loaded = await store.load(record.id);
    expect(loaded).toEqual(record);
    expect(TeamRecordSchema.safeParse(JSON.parse(await readFile(join(teamDir, "team.json"), "utf8"))).success).toBe(true);
    expect(await store.load(newId("team"))).toBeUndefined();
  });

  it("toTeam drops lastSeen and yields a protocol Team", () => {
    const record = makeTeamRecord();
    record.members[1]!.lastSeen = { x: 1 };
    const team = toTeam(record);
    expect("lastSeen" in team.members[1]!).toBe(false);
    expect(TeamSchema.safeParse(team).success).toBe(true);
    expect(team.members.map((m) => m.handle)).toEqual(["minsu", "jiyeon"]);
  });

  it("TeamRecordSchema accepts a record without lastSeen (defaults to {})", () => {
    const team = toTeam(makeTeamRecord());
    const parsed = TeamRecordSchema.parse(team);
    expect(parsed.members.every((m) => Object.keys(m.lastSeen).length === 0)).toBe(true);
  });

  it("fills sideRoomMaxParticipants when an older record does not have it (2026-09-14)", async () => {
    const { store } = await setup();
    const record = makeTeamRecord();
    const legacy = { ...record, settings: { maxHops: 6, maxConcurrent: 2, contextMaxMessages: 40 } };
    await store.save(legacy as unknown as typeof record);
    const loaded = await store.load(record.id);
    expect(loaded!.settings).toEqual({ maxHops: 6, maxConcurrent: 2, contextMaxMessages: 40, sideRoomMaxParticipants: 3 });
    // 파일은 아직 그대로다(저장은 다음 변경 때)
    const raw = JSON.parse(await readFile(join(store.teamsDir, record.id, "team.json"), "utf8")) as { settings: Record<string, number> };
    expect("sideRoomMaxParticipants" in raw.settings).toBe(false);
  });

  it("keeps a side room with its participants through save → load", async () => {
    const { store } = await setup();
    const record = makeTeamRecord();
    const side = record.rooms.find((r) => r.kind === "side")!;
    await store.save(record);
    const loaded = await store.load(record.id);
    expect(loaded!.rooms.find((r) => r.id === side.id)).toEqual(side);
    expect(toTeam(loaded!).rooms.find((r) => r.id === side.id)!.participants).toEqual(side.participants);
  });

  it("list scans teams/ and skips corrupted or foreign entries with a warning", async () => {
    const { dataDir, store } = await setup();
    const a = makeTeamRecord();
    const b = makeTeamRecord({ id: newId("team"), name: "second" });
    await store.save(a);
    await store.save(b);
    const badDir = join(dataDir, "teams", newId("team"));
    await mkdir(badDir, { recursive: true });
    await writeFile(join(badDir, "team.json"), "{not json");
    await mkdir(join(dataDir, "teams", "stray-dir"), { recursive: true }); // team.json 없음
    await writeFile(join(dataDir, "teams", "stray.json"), "{}");
    const warn = vi.fn();
    const listed = await new TeamStore(dataDir, { warn }).list();
    expect(listed.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("remove deletes team.json and rooms/ but leaves worktrees/", async () => {
    const { dataDir, store } = await setup();
    const record = makeTeamRecord();
    await store.save(record);
    const teamDir = join(dataDir, "teams", record.id);
    await mkdir(join(teamDir, "rooms"), { recursive: true });
    await writeFile(join(teamDir, "rooms", "room_x.events.jsonl"), "");
    await mkdir(join(teamDir, "worktrees", "agt_x"), { recursive: true });
    await writeFile(join(teamDir, "worktrees", "agt_x", "keep.txt"), "k");
    await store.remove(record.id);
    expect((await readdir(teamDir)).sort()).toEqual(["worktrees"]);
    expect(await store.load(record.id)).toBeUndefined();
    await store.remove(record.id); // 멱등
    // worktrees 가 없으면 팀 디렉토리 자체가 사라진다
    const other = makeTeamRecord({ id: newId("team") });
    await store.save(other);
    await store.remove(other.id);
    expect((await readdir(join(dataDir, "teams"))).includes(other.id)).toBe(false);
  });

  it("templates: save/list/remove under team-templates/", async () => {
    const { dataDir, store } = await setup();
    const at = "2026-09-12T09:00:00Z";
    const record = makeTeamRecord();
    const tpl: TeamTemplate = {
      id: newId("tpl"),
      name: "백엔드 기본",
      settings: record.settings,
      members: record.members.map(({ name, handle, role, roleLabel, emoji, agent, prompt, mode, model, effort, isLead }) => ({
        name, handle, role, roleLabel, emoji, agent, prompt, mode, model, effort, isLead,
      })),
      createdAt: at,
      updatedAt: at,
    };
    expect(await store.listTemplates()).toEqual([]);
    await store.saveTemplate(tpl);
    expect(await mode(join(dataDir, "team-templates"))).toBe(0o700);
    const listed = await store.listTemplates();
    expect(listed).toEqual([tpl]);
    expect(TeamTemplateSchema.safeParse(listed[0]).success).toBe(true);
    await writeFile(join(dataDir, "team-templates", "tpl_broken.json"), "nope");
    const warn = vi.fn();
    expect((await new TeamStore(dataDir, { warn }).listTemplates()).map((t) => t.id)).toEqual([tpl.id]);
    expect(warn).toHaveBeenCalledTimes(1);
    await store.removeTemplate(tpl.id);
    await store.removeTemplate(tpl.id); // 멱등
    expect(await store.listTemplates()).toEqual([]);
  });
});

describe("slug", () => {
  it("normalizes team names to [a-z0-9-]", () => {
    expect(slug("backend")).toBe("backend");
    expect(slug("  Backend API  v2 ")).toBe("backend-api-v2");
    expect(slug("백엔드")).toBe("team");
    expect(slug("---")).toBe("team");
    expect(slug("Mobile/iOS_app")).toBe("mobile-ios-app");
  });
});

describe("makeHandle", () => {
  it("keeps ascii letters, digits and hyphens, lowercased", () => {
    expect(makeHandle("Minsu", new Set(), 1)).toBe("minsu");
    expect(makeHandle("Ji-Yeon Park", new Set(), 2)).toBe("ji-yeonpark");
    expect(makeHandle("민수", new Set(), 1)).toBe("agent-1");
    expect(makeHandle("민수2", new Set(), 3)).toBe("2");
    expect(makeHandle("-lead-", new Set(), 1)).toBe("lead");
  });
  it("appends -2, -3 … when taken and stays within 32 chars", () => {
    expect(makeHandle("minsu", new Set(["minsu"]), 1)).toBe("minsu-2");
    expect(makeHandle("minsu", new Set(["minsu", "minsu-2"]), 1)).toBe("minsu-3");
    expect(makeHandle("지연", new Set(["agent-2"]), 2)).toBe("agent-2-2");
    const long = makeHandle("a".repeat(40), new Set(["a".repeat(32)]), 1);
    expect(long).toMatch(/^[a-z0-9][a-z0-9-]{0,31}$/);
    expect(long.endsWith("-2")).toBe(true);
  });
});
