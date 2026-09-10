import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AgentKind } from "@mam/protocol";
import type { AgentUsageSnapshot } from "../agents/types.js";

const StoredSchema = z.object({
  savedAt: z.string(),
  plan: z.string().nullable(),
  live: z.boolean(),
  observedAt: z.string().nullable(),
  limits: z.array(
    z.object({
      id: z.string(),
      usedPercent: z.number(),
      windowMinutes: z.number().nullable(),
      resetsAt: z.string().nullable(),
      rejected: z.boolean().optional(),
    }),
  ),
});

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

/**
 * 구독 한도 관측값 저장소(ADR-016). `<dataDir>/usage/<kind>.json` 에 원자적으로 쓴다.
 * Claude 어댑터(step 2)는 `rate_limit_event` 마다 `save()` 하고 `usage()` 가 `load()` 한다.
 * Codex 는 즉시 조회하므로 `load(kind, 60_000)` 처럼 60초 캐시로 쓴다.
 */
export class RateLimitStore {
  private readonly dir: string;
  private readonly now: () => Date;

  constructor(dataDir: string, opts: { now?: () => Date } = {}) {
    this.dir = join(dataDir, "usage");
    this.now = opts.now ?? (() => new Date());
  }

  filePath(kind: AgentKind): string {
    return join(this.dir, `${kind}.json`);
  }

  async save(kind: AgentKind, snapshot: AgentUsageSnapshot): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const stored: z.infer<typeof StoredSchema> = {
      savedAt: this.now().toISOString(),
      plan: snapshot.plan,
      live: snapshot.live,
      observedAt: snapshot.observedAt ? snapshot.observedAt.toISOString() : null,
      limits: snapshot.limits.map((l) => ({
        id: l.id,
        usedPercent: l.usedPercent,
        windowMinutes: l.windowMinutes,
        resetsAt: l.resetsAt ? l.resetsAt.toISOString() : null,
        ...(l.rejected !== undefined ? { rejected: l.rejected } : {}),
      })),
    };
    const path = this.filePath(kind);
    const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(stored, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(tmp, path);
  }

  /** 없거나 손상됐거나 `maxAgeMs` 보다 오래됐으면 `null`. */
  async load(kind: AgentKind, maxAgeMs?: number): Promise<AgentUsageSnapshot | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath(kind), "utf8");
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return null;
    }
    const parsed = StoredSchema.safeParse(json);
    if (!parsed.success) return null;
    const stored = parsed.data;
    if (maxAgeMs !== undefined && this.now().getTime() - Date.parse(stored.savedAt) > maxAgeMs) return null;
    return {
      plan: stored.plan,
      live: stored.live,
      observedAt: stored.observedAt === null ? null : new Date(stored.observedAt),
      limits: stored.limits.map((l) => ({
        id: l.id,
        usedPercent: l.usedPercent,
        windowMinutes: l.windowMinutes,
        resetsAt: l.resetsAt === null ? null : new Date(l.resetsAt),
        ...(l.rejected !== undefined ? { rejected: l.rejected } : {}),
      })),
    };
  }
}
