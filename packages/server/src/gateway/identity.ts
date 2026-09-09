import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { isIP } from "node:net";
import { delimiter, join } from "node:path";

export interface Identity {
  email: string;
  displayName?: string;
  node?: string;
}

export interface IdentityResolver {
  resolve(remoteAddress: string): Promise<Identity | null>;
}

export type ExecFn = (bin: string, args: string[]) => Promise<{ stdout: string; code: number }>;

/** 고정 명령 실행(인자 배열, 셸 없음). 실패·타임아웃은 code -1. */
export function runCommand(bin: string, args: string[], timeoutMs = 5000): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve({ stdout: "", code: -1 });
      return;
    }
    let out = "";
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout: out, code });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(-1);
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", () => finish(-1));
    child.on("close", (code) => finish(code ?? -1));
  });
}

const TAILSCALE_CANDIDATES = [
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findTailscaleBin(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const candidate of TAILSCALE_CANDIDATES) if (isExecutable(candidate)) return candidate;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "tailscale");
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/** `::ffff:100.1.2.3` → `100.1.2.3`, `fe80::1%utun3` → `fe80::1`, `[..]` 제거. */
export function normalizeRemoteAddress(address: string): string {
  let a = address.trim();
  const zone = a.indexOf("%");
  if (zone >= 0) a = a.slice(0, zone);
  if (a.startsWith("[") && a.endsWith("]")) a = a.slice(1, -1);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(a);
  if (mapped) a = mapped[1]!;
  return a;
}

interface WhoisJson {
  Node?: { Name?: string; ComputedName?: string; Tags?: string[] };
  UserProfile?: { LoginName?: string; DisplayName?: string };
}

/** `tailscale whois --json` 결과 → Identity. 태그 노드(사용자 없음)는 null. */
export function parseWhois(json: unknown): Identity | null {
  if (typeof json !== "object" || json === null) return null;
  const who = json as WhoisJson;
  const tags = who.Node?.Tags;
  if (Array.isArray(tags) && tags.length > 0) return null;
  const login = who.UserProfile?.LoginName;
  if (typeof login !== "string" || login.length === 0 || login === "tagged-devices") return null;
  const identity: Identity = { email: login.trim().toLowerCase() };
  if (typeof who.UserProfile?.DisplayName === "string" && who.UserProfile.DisplayName) identity.displayName = who.UserProfile.DisplayName;
  const node = who.Node?.ComputedName ?? who.Node?.Name;
  if (typeof node === "string" && node) identity.node = node;
  return identity;
}

export interface TailscaleIdentityResolverOptions {
  exec?: ExecFn;
  tailscaleBin?: string;
  ttlMs?: number;
  now?: () => number;
}

const CACHE_MAX = 1000;

/** ADR-003: 접속 IP → `tailscale whois --json` → LoginName. 결과(null 포함)를 ttl 동안 캐시. */
export class TailscaleIdentityResolver implements IdentityResolver {
  private readonly exec: ExecFn;
  private readonly bin: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, { at: number; value: Promise<Identity | null> }>();

  constructor(opts: TailscaleIdentityResolverOptions = {}) {
    this.exec = opts.exec ?? ((bin, args) => runCommand(bin, args));
    this.bin = opts.tailscaleBin ?? findTailscaleBin() ?? "tailscale";
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.now = opts.now ?? (() => Date.now());
  }

  async resolve(remoteAddress: string): Promise<Identity | null> {
    const ip = normalizeRemoteAddress(remoteAddress);
    if (isIP(ip) === 0) return null;
    const hit = this.cache.get(ip);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
    if (this.cache.size >= CACHE_MAX) this.evict();
    const value = this.lookup(ip);
    this.cache.set(ip, { at: this.now(), value });
    return value;
  }

  private evict(): void {
    const now = this.now();
    for (const [key, entry] of this.cache) if (now - entry.at >= this.ttlMs) this.cache.delete(key);
    if (this.cache.size >= CACHE_MAX) this.cache.clear();
  }

  private async lookup(ip: string): Promise<Identity | null> {
    let result: { stdout: string; code: number };
    try {
      result = await this.exec(this.bin, ["whois", "--json", ip]);
    } catch {
      return null;
    }
    if (result.code !== 0) return null;
    try {
      return parseWhois(JSON.parse(result.stdout));
    } catch {
      return null;
    }
  }
}

/** 개발 모드: 모든 접속을 같은 신원으로. */
export class StaticIdentityResolver implements IdentityResolver {
  constructor(private readonly identity: Identity) {}

  async resolve(): Promise<Identity | null> {
    return this.identity;
  }
}
