import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TeamSchema, TeamTemplateSchema, type Team, type TeamTemplate } from "@mam/protocol";
import { InternalError } from "../errors.js";
import { TeamRecordSchema, type TeamRecord } from "./types.js";

/**
 * 팀 레코드·템플릿 파일 저장소. `<dataDir>/teams/<teamId>/team.json`, `<dataDir>/team-templates/<tplId>.json`.
 * 디렉토리는 0700, 쓰기는 tmp+rename. 세션·디스패치·git 은 모른다. 로그에 파일 내용을 남기지 않는다.
 * ChangeSet 목록(`changes.json`)은 `changes.ts` 의 `ChangeStore` 가 맡는다.
 */

const DIR_MODE = 0o700;

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 내부 레코드 → 프로토콜 `Team`. `TeamSchema` 가 모르는 키(`lastSeen`)를 떨어뜨린다. */
export function toTeam(record: TeamRecord): Team {
  return TeamSchema.parse(record);
}

/** 팀 이름 → `[a-z0-9-]` 슬러그. 영숫자가 없으면 `team`. */
export function slug(name: string): string {
  const s = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s === "" ? "team" : s;
}

const HANDLE_MAX = 32;

/**
 * 이름에서 `@멘션` 핸들을 만든다. ascii 문자·숫자·하이픈만 남겨 소문자로, 비어 있으면(한글 이름) `agent-<index>`,
 * 이미 있으면 `-2`, `-3` … 접미. 결과는 항상 `^[a-z0-9][a-z0-9-]{0,31}$` 을 만족한다.
 */
export function makeHandle(name: string, taken: ReadonlySet<string>, index: number): string {
  let base = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "");
  if (base === "") base = `agent-${index}`;
  base = base.slice(0, HANDLE_MAX).replace(/-+$/g, "");
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, HANDLE_MAX - suffix.length).replace(/-+$/g, "") + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  await chmod(dir, DIR_MODE);
}

/** JSON 을 tmp 파일에 쓰고 rename 한다. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export class TeamStore {
  readonly teamsDir: string;
  readonly templatesDir: string;

  constructor(
    dataDir: string,
    private readonly logger: Pick<Console, "warn"> = console,
  ) {
    this.teamsDir = join(dataDir, "teams");
    this.templatesDir = join(dataDir, "team-templates");
  }

  /** 팀 디렉토리 경로(`<teamsDir>/<teamId>`). RoomManager 의 `teamDir` 와 worktree 부모가 이 아래에 있다. */
  teamDir(teamId: string): string {
    return join(this.teamsDir, teamId);
  }

  /** `teams/<teamId>/team.json` 을 전부 읽는다. 손상되거나 스키마가 맞지 않는 파일은 경고 후 건너뛴다. */
  async list(): Promise<TeamRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.teamsDir);
    } catch (err) {
      if (isEnoent(err)) return [];
      throw err;
    }
    const out: TeamRecord[] = [];
    for (const name of names) {
      const path = join(this.teamsDir, name, "team.json");
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch (err) {
        if (isEnoent(err) || (err as { code?: string }).code === "ENOTDIR") continue; // team.json 이 없는 항목은 팀이 아니다
        this.logger.warn(`[teams] 팀 레코드 읽기 실패, 건너뜀: ${name}: ${errorMessage(err)}`);
        continue;
      }
      const record = this.parseRecord(raw, name);
      if (record) out.push(record);
    }
    return out;
  }

  /** 팀 하나. 파일이 없으면 `undefined`, 있는데 손상됐으면 `InternalError`. */
  async load(teamId: string): Promise<TeamRecord | undefined> {
    let raw: string;
    try {
      raw = await readFile(join(this.teamDir(teamId), "team.json"), "utf8");
    } catch (err) {
      if (isEnoent(err)) return undefined;
      throw err;
    }
    const record = this.parseRecord(raw, teamId);
    if (!record) throw new InternalError(`팀 레코드가 손상되었습니다: ${teamId}`);
    return record;
  }

  /** `<teamsDir>/<teamId>/team.json` 에 원자적으로 쓴다(tmp+rename, 디렉토리 0700). */
  async save(record: TeamRecord): Promise<void> {
    const dir = this.teamDir(record.id);
    await ensureDir(this.teamsDir);
    await ensureDir(dir);
    await writeJsonAtomic(join(dir, "team.json"), record);
  }

  /** `team.json`·`changes.json` 과 `rooms/` 만 지운다. `worktrees/` 는 git 이 정리한다(step 5·6). 남은 것이 없으면 팀 디렉토리도 지운다. 멱등. */
  async remove(teamId: string): Promise<void> {
    const dir = this.teamDir(teamId);
    await rm(join(dir, "team.json"), { force: true });
    await rm(join(dir, "changes.json"), { force: true });
    await rm(join(dir, "rooms"), { recursive: true, force: true });
    try {
      await rmdir(dir);
    } catch (err) {
      if (!isEnoent(err) && (err as { code?: string }).code !== "ENOTEMPTY") throw err;
    }
  }

  async listTemplates(): Promise<TeamTemplate[]> {
    let names: string[];
    try {
      names = await readdir(this.templatesDir);
    } catch (err) {
      if (isEnoent(err)) return [];
      throw err;
    }
    const out: TeamTemplate[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = TeamTemplateSchema.safeParse(JSON.parse(await readFile(join(this.templatesDir, name), "utf8")));
        if (!parsed.success) {
          this.logger.warn(`[teams] 템플릿 스키마 불일치, 건너뜀: ${name}`);
          continue;
        }
        out.push(parsed.data);
      } catch (err) {
        this.logger.warn(`[teams] 템플릿 로드 실패, 건너뜀: ${name}: ${errorMessage(err)}`);
      }
    }
    return out;
  }

  async saveTemplate(template: TeamTemplate): Promise<void> {
    await ensureDir(this.templatesDir);
    await writeJsonAtomic(join(this.templatesDir, `${template.id}.json`), template);
  }

  async removeTemplate(templateId: string): Promise<void> {
    await rm(join(this.templatesDir, `${templateId}.json`), { force: true });
  }

  private parseRecord(raw: string, name: string): TeamRecord | undefined {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.logger.warn(`[teams] 팀 레코드 JSON 파싱 실패, 건너뜀: ${name}`);
      return undefined;
    }
    const parsed = TeamRecordSchema.safeParse(json);
    if (!parsed.success) {
      this.logger.warn(`[teams] 팀 레코드 스키마 불일치, 건너뜀: ${name}`);
      return undefined;
    }
    return parsed.data;
  }
}
