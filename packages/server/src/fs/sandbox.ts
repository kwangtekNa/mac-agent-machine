import type { Stats } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { MamError } from "../errors.js";

export type SandboxErrorCode = "forbidden" | "not_found";

/** 홈 밖 접근(403) 또는 존재하지 않는 경로(404). `MamError` 라 라우트가 그대로 매핑할 수 있다. */
export class SandboxError extends MamError {
  declare readonly code: SandboxErrorCode;

  constructor(code: SandboxErrorCode, message?: string) {
    super(
      code,
      message ?? (code === "forbidden" ? "홈 디렉토리 밖의 경로입니다" : "경로를 찾을 수 없습니다"),
      code === "forbidden" ? 403 : 404,
    );
  }
}

function errnoCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : undefined;
}

function isMissing(err: unknown): boolean {
  const code = errnoCode(err);
  return code === "ENOENT" || code === "ENOTDIR";
}

function isInside(home: string, target: string): boolean {
  return target === home || target.startsWith(home + path.sep);
}

/** 마지막 세그먼트만 없는 경로(생성 전): 부모를 realpath 하고 basename 을 붙인다. */
async function resolveMissingLeaf(realHome: string, lexicalHome: string, normalized: string): Promise<string> {
  try {
    return path.join(await realpath(path.dirname(normalized)), path.basename(normalized));
  } catch (err) {
    // 홈 밖 경로의 존재 여부가 새지 않도록 어휘적 판정을 먼저 한다.
    if (!isInside(realHome, normalized) && !isInside(lexicalHome, normalized)) throw new SandboxError("forbidden");
    if (isMissing(err)) throw new SandboxError("not_found");
    throw err;
  }
}

/**
 * `~/` 를 home 으로 치환하고 절대경로로 만든 뒤 realpath 로 해석해 home 안인지 검사한다.
 * 심볼릭 링크가 홈 밖을 가리키면 realpath 결과가 밖이므로 `forbidden` 이 된다.
 */
export async function resolveInsideHome(home: string, input: string): Promise<string> {
  const realHome = await realpath(home);
  let candidate = input;
  if (input === "~") candidate = realHome;
  else if (input.startsWith("~/")) candidate = path.join(realHome, input.slice(2));
  const normalized = path.resolve(realHome, candidate);

  let resolved: string;
  try {
    resolved = await realpath(normalized);
  } catch (err) {
    if (!isMissing(err)) {
      if (!isInside(realHome, normalized)) throw new SandboxError("forbidden");
      throw err;
    }
    resolved = await resolveMissingLeaf(realHome, path.resolve(home), normalized);
  }
  if (!isInside(realHome, resolved)) throw new SandboxError("forbidden");
  return resolved;
}

/** `resolveInsideHome` 결과를 stat 한다. 없으면 `not_found`. */
export async function statResolved(resolved: string): Promise<Stats> {
  try {
    return await stat(resolved);
  } catch (err) {
    if (isMissing(err)) throw new SandboxError("not_found");
    throw err;
  }
}
