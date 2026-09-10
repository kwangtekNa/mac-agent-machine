import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const DEFAULT_CONFIG_PATH = "/etc/mam/config.json";

/** 현재 실행 중인 cli.js 경로. dist 에서는 형제 파일, 아니면 argv[1]. */
export function defaultMamCliPath(): string {
  const sibling = fileURLToPath(new URL("./cli.js", import.meta.url));
  if (existsSync(sibling)) return sibling;
  return process.argv[1] ?? sibling;
}

export const UserEntrySchema = z.object({
  macUser: z.string().min(1),
  email: z
    .string()
    .min(1)
    .transform((s) => s.trim().toLowerCase()),
  /** `~` 치환은 agent-host 가 한다. 여기서는 그대로 둔다. */
  workspaceRoot: z.string().min(1).default("~/work"),
});

/** `docs/ARCHITECTURE.md` 5절의 `/etc/mam/config.json`. 단일 진실. */
export const ConfigSchema = z.object({
  /** 0 은 OS 가 고르는 임시 포트(테스트용). */
  port: z.number().int().min(0).max(65535).default(443),
  /** "tailscale"(tailnet IPv4 자동) 또는 IPv4 리터럴. 개발 모드 기본은 127.0.0.1, 같은 Wi-Fi/핫스팟의 폰에서 붙을 때는 LAN IP. */
  bind: z.union([z.literal("tailscale"), z.ipv4()]).default("tailscale"),
  hostname: z.string().min(1).optional(),
  tls: z.object({ cert: z.string().min(1), key: z.string().min(1) }).optional(),
  users: z.array(UserEntrySchema).default([]),
  agentHost: z.object({ idleTimeoutMinutes: z.number().positive().default(30) }).prefault({}),
  paths: z
    .object({
      node: z.string().min(1).default(() => process.execPath),
      mamCli: z.string().min(1).default(() => defaultMamCliPath()),
    })
    .prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;
export type UserEntry = z.infer<typeof UserEntrySchema>;

export async function loadConfig(path: string = process.env.MAM_CONFIG ?? DEFAULT_CONFIG_PATH): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(`설정 파일을 읽을 수 없습니다: ${path} (${(err as Error).message})`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`설정 파일이 JSON 이 아닙니다: ${path} (${(err as Error).message})`);
  }
  const result = ConfigSchema.safeParse(json);
  if (!result.success) throw new Error(`설정 파일 검증 실패: ${path}\n${z.prettifyError(result.error)}`);
  return result.data;
}

/** 개발 모드: 127.0.0.1:7777, TLS 없음, 현재 사용자 한 명(`<user>@dev.local`). */
export function devConfig(overrides: Partial<ConfigInput> = {}): Config {
  const user = userInfo().username;
  return ConfigSchema.parse({
    port: 7777,
    bind: "127.0.0.1",
    users: [{ macUser: user, email: `${user}@dev.local`, workspaceRoot: "~/work" }],
    ...overrides,
  });
}
