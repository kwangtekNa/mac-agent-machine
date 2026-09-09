import { dirname } from "node:path";
import type { ConfigInput } from "../config.js";

type Fs = typeof import("node:fs/promises");

/** 설정 파일의 원본 JSON(검증 전). 없으면 null. */
export async function readConfigRaw(fs: Fs, path: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`설정 파일을 읽을 수 없습니다: ${path} (${(err as Error).message})`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`설정 파일이 JSON 이 아닙니다: ${path} (${(err as Error).message})`);
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error(`설정 파일 최상위는 객체여야 합니다: ${path}`);
  }
  return json as Record<string, unknown>;
}

/** tmp 파일에 쓴 뒤 rename. 부분 쓰기 상태가 남지 않는다. 모드 0644(root 소유, 비밀값 없음). */
export async function writeConfigAtomic(fs: Fs, path: string, data: ConfigInput | Record<string, unknown>): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o644 });
  await fs.rename(tmp, path);
}

export interface RawUserEntry {
  macUser: string;
  email: string;
  workspaceRoot?: string;
}

export function usersOf(raw: Record<string, unknown>): RawUserEntry[] {
  const users = raw.users;
  if (!Array.isArray(users)) return [];
  return users.filter((u): u is RawUserEntry => typeof u === "object" && u !== null && typeof (u as RawUserEntry).macUser === "string");
}
