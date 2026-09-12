import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ChangeSetSchema, type ChangeSet } from "@mam/protocol";
import { z } from "zod";
import { ensureDir, writeJsonAtomic } from "./store.js";

/**
 * "변경 준비됨" ChangeSet 목록의 파일 저장소(`<teamDir>/changes.json`)와 머지 충돌 안내문(PROTOCOL 6.5, ADR-017).
 * git·세션·방은 모른다. 머지 흐름 자체는 `TeamManager.merge/dismiss` 에 있다.
 */

const FILE_NAME = "changes.json";
const ChangeListSchema = z.array(ChangeSetSchema);

export class ChangeStore {
  private readonly dir: string;
  private readonly path: string;

  constructor(
    teamDir: string,
    private readonly logger: Pick<Console, "warn"> = console,
  ) {
    this.dir = teamDir;
    this.path = join(teamDir, FILE_NAME);
  }

  /** 없으면 `[]`, 손상되거나 스키마가 맞지 않으면 경고 후 `[]`(파일 내용은 로그에 남기지 않는다). */
  async load(): Promise<ChangeSet[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return [];
      throw err;
    }
    try {
      const parsed = ChangeListSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {
      // 아래에서 경고
    }
    this.logger.warn(`[teams] ${FILE_NAME} 손상, 무시: ${this.dir}`);
    return [];
  }

  /** 디렉토리 0700, tmp+rename. */
  async save(list: ChangeSet[]): Promise<void> {
    await ensureDir(this.dir);
    await writeJsonAtomic(this.path, list);
  }
}

/**
 * 턴 텍스트 맨 앞에 붙는 머지 충돌 안내(`buildTurnText.conflictNote`). 서버는 마커를 건드리지 않고 팀원의 턴이 정리한다.
 * 한 줄이며 git 명령을 금지한다(커밋은 턴 종료 시 서버가 한다).
 */
export function conflictNoteFor(files: string[], base: string): string {
  const list = files.length > 0 ? files.join(", ") : "(파일 목록 없음)";
  return `머지 충돌: ${list}. ${base} 브랜치를 worktree 에 머지하다 충돌이 났다. worktree 안에서 충돌 마커(<<<<<<<, >>>>>>>)를 정리하고 파일을 저장하라. git 명령은 실행하지 마라.`;
}
