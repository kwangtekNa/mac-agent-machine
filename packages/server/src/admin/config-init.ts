import { existsSync } from "node:fs";
import { defaultMamCliPath, type ConfigInput } from "../config.js";
import { findTailscaleBin } from "../gateway/identity.js";
import { readConfigRaw, usersOf, writeConfigAtomic } from "./config-store.js";
import { fsOf, type AdminDeps } from "./exec.js";

export const DEFAULT_TLS_CERT = "/etc/mam/tls/cert.pem";
export const DEFAULT_TLS_KEY = "/etc/mam/tls/key.pem";
const NODE_CANDIDATES = ["/opt/homebrew/bin/node", "/usr/local/bin/node"];

export interface InitConfigOptions {
  hostname?: string;
  port?: number;
  force?: boolean;
  tailscaleBin?: string;
  nodePath?: string;
  mamCliPath?: string;
}

/** 심볼릭 링크 경로(`/opt/homebrew/bin/node`)를 우선한다. node 업그레이드 후에도 유효하도록. */
export function defaultNodePath(): string {
  for (const c of NODE_CANDIDATES) if (existsSync(c)) return c;
  return process.execPath;
}

export function stripTrailingDot(host: string): string {
  return host.trim().replace(/\.$/, "");
}

/** `tailscale status --json` 의 `Self.DNSName`(끝 점 제거). 실패하면 undefined. */
export async function detectMagicDns(deps: AdminDeps, tailscaleBin?: string): Promise<string | undefined> {
  const bin = tailscaleBin ?? findTailscaleBin() ?? "tailscale";
  const r = await deps.exec(bin, ["status", "--json"]);
  if (r.code !== 0) return undefined;
  try {
    const json = JSON.parse(r.stdout) as { Self?: { DNSName?: string } };
    const dns = json.Self?.DNSName;
    return dns ? stripTrailingDot(dns) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `/etc/mam/config.json` 초기화. 이미 있으면 `force` 없이는 그대로 둔다(설치 스크립트 멱등).
 * `force` 로 다시 쓸 때 기존 `users[]` 는 보존한다.
 */
export async function initConfig(deps: AdminDeps, opts: InitConfigOptions = {}): Promise<string> {
  const fs = await fsOf(deps);
  const existing = await readConfigRaw(fs, deps.configPath).catch(() => null);
  if (existing && !opts.force) {
    deps.logger?.info(`설정 파일이 이미 있습니다: ${deps.configPath} (다시 만들려면 --force)`);
    return deps.configPath;
  }
  const hostname = opts.hostname ?? (await detectMagicDns(deps, opts.tailscaleBin));
  if (!hostname) deps.logger?.warn("hostname 을 정하지 못했습니다 (--hostname 또는 tailscale 로그인 필요). TLS 발급 전에 채워야 합니다");
  const config: ConfigInput = {
    port: opts.port ?? 443,
    bind: "tailscale",
    ...(hostname ? { hostname } : {}),
    tls: { cert: DEFAULT_TLS_CERT, key: DEFAULT_TLS_KEY },
    users: existing ? usersOf(existing) : [],
    agentHost: { idleTimeoutMinutes: 30 },
    paths: { node: opts.nodePath ?? defaultNodePath(), mamCli: opts.mamCliPath ?? defaultMamCliPath() },
  };
  await writeConfigAtomic(fs, deps.configPath, config);
  deps.logger?.info(`설정 파일 작성: ${deps.configPath}${existing ? " (기존 users[] 보존)" : ""}`);
  return deps.configPath;
}
