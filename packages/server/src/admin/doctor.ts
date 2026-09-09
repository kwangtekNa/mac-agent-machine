import { join } from "node:path";
import { loadConfig, type Config } from "../config.js";
import { findTailscaleBin } from "../gateway/identity.js";
import { stripTrailingDot } from "./config-init.js";
import { fsOf, isRoot, resolvePaths, type AdminDeps } from "./exec.js";
import { expandWorkspace } from "./users.js";

export type CheckStatus = "ok" | "warn" | "fail";
export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}
export interface DoctorResult {
  checks: Check[];
  ok: boolean;
}
export type DoctorDeps = AdminDeps & { config?: Config; tailscaleBin?: string; now?: () => number };

export const TLS_WARN_DAYS = 14;
type Fs = Awaited<ReturnType<typeof fsOf>>;

async function statOr(fs: Fs, path: string): Promise<{ mode: number } | null> {
  try {
    const s = await fs.stat(path);
    return { mode: s.mode & 0o777 };
  } catch {
    return null;
  }
}

export function checkRoot(deps: DoctorDeps): Check {
  return isRoot(deps)
    ? { name: "root", status: "ok", detail: "root 로 실행 중" }
    : { name: "root", status: "warn", detail: "root 가 아닙니다 — 에이전트 probe·launchd 검사는 건너뜁니다 (sudo mam doctor)" };
}

export async function checkConfig(deps: DoctorDeps): Promise<{ check: Check; config?: Config }> {
  if (deps.config) return { check: { name: "config", status: "ok", detail: "주입된 설정" }, config: deps.config };
  try {
    const config = await loadConfig(deps.configPath);
    return { check: { name: "config", status: "ok", detail: `${deps.configPath} (users ${config.users.length})` }, config };
  } catch (err) {
    return { check: { name: "config", status: "fail", detail: (err as Error).message.split("\n")[0] ?? "" } };
  }
}

export async function checkTailscale(deps: DoctorDeps, config: Config): Promise<Check[]> {
  const bin = deps.tailscaleBin ?? findTailscaleBin();
  if (!bin) return [{ name: "tailscale", status: "fail", detail: "tailscale 실행 파일을 찾지 못했습니다 (brew install tailscale)" }];
  const r = await deps.exec(bin, ["status", "--json"]);
  if (r.code !== 0) return [{ name: "tailscale", status: "fail", detail: `tailscale status 실패 (exit ${r.code}): ${r.stderr.trim()}` }];
  let json: { BackendState?: string; Self?: { DNSName?: string; TailscaleIPs?: string[] } };
  try {
    json = JSON.parse(r.stdout);
  } catch {
    return [{ name: "tailscale", status: "fail", detail: "tailscale status --json 출력을 파싱할 수 없습니다" }];
  }
  const checks: Check[] = [];
  if (json.BackendState === "Running") checks.push({ name: "tailscale", status: "ok", detail: `${bin} Running` });
  else checks.push({ name: "tailscale", status: "fail", detail: `BackendState=${json.BackendState ?? "?"} (tailscale up 필요)` });
  const ipv4 = (json.Self?.TailscaleIPs ?? []).find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
  checks.push(
    ipv4
      ? { name: "tailscale.ipv4", status: "ok", detail: ipv4 }
      : { name: "tailscale.ipv4", status: "fail", detail: "tailnet IPv4 주소가 없습니다" },
  );
  const dns = json.Self?.DNSName ? stripTrailingDot(json.Self.DNSName) : "";
  if (!config.hostname) checks.push({ name: "tailscale.dns", status: "warn", detail: `config.hostname 이 없습니다 (MagicDNS: ${dns || "?"})` });
  else if (dns === config.hostname) checks.push({ name: "tailscale.dns", status: "ok", detail: dns });
  else checks.push({ name: "tailscale.dns", status: "fail", detail: `MagicDNS ${dns || "?"} ≠ config.hostname ${config.hostname}` });
  return checks;
}

/** `openssl x509 -enddate -noout` 출력 `notAfter=Sep 30 12:00:00 2026 GMT` → Date. */
export function parseNotAfter(output: string): Date | null {
  const m = /notAfter=(.+)/.exec(output);
  if (!m?.[1]) return null;
  const d = new Date(m[1].trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function checkTls(deps: DoctorDeps, config: Config): Promise<Check> {
  const fs = await fsOf(deps);
  if (!config.tls) return { name: "tls", status: "fail", detail: "config.tls 가 없습니다" };
  for (const [label, p] of [["cert", config.tls.cert], ["key", config.tls.key]] as const) {
    if (!(await statOr(fs, p))) return { name: "tls", status: "fail", detail: `${label} 파일 없음: ${p} (tailscale cert 필요)` };
  }
  const r = await deps.exec("openssl", ["x509", "-enddate", "-noout", "-in", config.tls.cert]);
  const notAfter = r.code === 0 ? parseNotAfter(r.stdout) : null;
  if (!notAfter) return { name: "tls", status: "warn", detail: `만료일을 읽지 못했습니다 (openssl exit ${r.code})` };
  const days = Math.floor((notAfter.getTime() - (deps.now ?? Date.now)()) / 86_400_000);
  if (days < 0) return { name: "tls", status: "fail", detail: `인증서 만료됨 (${notAfter.toISOString()})` };
  if (days < TLS_WARN_DAYS) return { name: "tls", status: "warn", detail: `인증서 ${days}일 후 만료 — renew-cert.sh 실행 권장` };
  return { name: "tls", status: "ok", detail: `${days}일 남음` };
}

export async function checkPaths(deps: DoctorDeps, config: Config): Promise<Check> {
  const fs = await fsOf(deps);
  const missing: string[] = [];
  for (const [label, p] of [["node", config.paths.node], ["mamCli", config.paths.mamCli]] as const) {
    if (!(await statOr(fs, p))) missing.push(`${label}=${p}`);
  }
  return missing.length
    ? { name: "paths", status: "fail", detail: `없음: ${missing.join(", ")}` }
    : { name: "paths", status: "ok", detail: `${config.paths.node}, ${config.paths.mamCli}` };
}

export async function checkSshd(deps: DoctorDeps): Promise<Check[]> {
  const fs = await fsOf(deps);
  const r = await deps.exec("/bin/launchctl", ["print", "system/com.openssh.sshd"]);
  const conf = resolvePaths(deps).sshdConf;
  return [
    r.code === 0
      ? { name: "sshd", status: "ok", detail: "com.openssh.sshd 로드됨" }
      : { name: "sshd", status: "fail", detail: "sshd 가 활성화되어 있지 않습니다 (systemsetup -setremotelogin on)" },
    (await statOr(fs, conf))
      ? { name: "sshd.hardening", status: "ok", detail: conf }
      : { name: "sshd.hardening", status: "fail", detail: `${conf} 없음 (setup-server.sh 가 작성)` },
  ];
}

export async function checkRunRoot(deps: DoctorDeps): Promise<Check> {
  const fs = await fsOf(deps);
  const root = resolvePaths(deps).runRoot;
  const st = await statOr(fs, root);
  if (!st) return { name: "runRoot", status: "warn", detail: `${root} 없음 (gateway 시작 시 생성됨)` };
  if (st.mode !== 0o755) return { name: "runRoot", status: "warn", detail: `${root} 권한 ${st.mode.toString(8)} (기대 755)` };
  return { name: "runRoot", status: "ok", detail: `${root} 755` };
}

export async function checkUser(deps: DoctorDeps, user: Config["users"][number]): Promise<Check> {
  const fs = await fsOf(deps);
  const paths = resolvePaths(deps);
  const home = join(paths.homeRoot, user.macUser);
  const problems: string[] = [];
  let status: CheckStatus = "ok";
  const fail = (m: string): void => {
    problems.push(m);
    status = "fail";
  };
  const warn = (m: string): void => {
    problems.push(m);
    if (status === "ok") status = "warn";
  };
  const acct = await deps.exec("/usr/bin/dscl", [".", "-read", `/Users/${user.macUser}`]);
  if (acct.code !== 0) fail("계정 없음");
  if (!(await statOr(fs, home))) fail(`홈 없음 ${home}`);
  const ws = expandWorkspace(user.workspaceRoot, home);
  if (!(await statOr(fs, ws))) warn(`워크스페이스 없음 ${ws}`);
  if (!(await statOr(fs, join(paths.runRoot, user.macUser)))) warn("소켓 디렉토리 없음 (gateway 가 생성)");
  return { name: `user:${user.macUser}`, status, detail: problems.length ? problems.join("; ") : `${user.email} ${home}` };
}

interface ProbeJson {
  available?: boolean;
  version?: string;
  loggedIn?: boolean;
  account?: string | null;
  detail?: string;
}

export async function checkAgentProbe(deps: DoctorDeps, config: Config, user: Config["users"][number]): Promise<Check> {
  const name = `agents:${user.macUser}`;
  if (!isRoot(deps)) return { name, status: "warn", detail: "root 아님 — 건너뜀" };
  const r = await deps.exec("/usr/bin/sudo", ["-u", user.macUser, "-H", "-n", "--", config.paths.node, config.paths.mamCli, "agent-host", "--probe"]);
  if (r.code !== 0) return { name, status: "fail", detail: `probe 실패 (exit ${r.code}): ${r.stderr.trim().split("\n").pop() ?? ""}` };
  let json: Record<string, ProbeJson>;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    return { name, status: "fail", detail: "probe 출력이 JSON 이 아닙니다" };
  }
  const parts: string[] = [];
  let status: CheckStatus = "ok";
  for (const kind of ["claude", "codex"] as const) {
    const p = json[kind];
    if (!p?.available) {
      parts.push(`${kind} 없음`);
      status = "warn";
      continue;
    }
    if (!p.loggedIn) status = "warn";
    parts.push(`${kind} ${p.version ?? "?"} ${p.loggedIn ? `로그인됨(${p.account ?? "?"})` : "로그인 필요"}`);
  }
  return { name, status, detail: parts.join(" / ") };
}

export async function checkGatewayLaunchd(deps: DoctorDeps): Promise<Check> {
  if (!isRoot(deps)) return { name: "gateway.launchd", status: "warn", detail: "root 아님 — 건너뜀" };
  const r = await deps.exec("/bin/launchctl", ["print", "system/dev.mam.gateway"]);
  return r.code === 0
    ? { name: "gateway.launchd", status: "ok", detail: "dev.mam.gateway 로드됨" }
    : { name: "gateway.launchd", status: "fail", detail: "dev.mam.gateway 가 로드되지 않았습니다 (launchctl bootstrap system /Library/LaunchDaemons/dev.mam.gateway.plist)" };
}

/** 전 항목을 독립적으로 검사한다. config 파싱이 실패하면 config 의존 검사는 건너뛴다. */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorResult> {
  const checks: Check[] = [checkRoot(deps)];
  const { check: cfgCheck, config } = await checkConfig(deps);
  checks.push(cfgCheck);
  if (config) {
    checks.push(...(await checkTailscale(deps, config)));
    checks.push(await checkTls(deps, config));
    checks.push(await checkPaths(deps, config));
  }
  checks.push(...(await checkSshd(deps)));
  checks.push(await checkRunRoot(deps));
  if (config) {
    for (const u of config.users) {
      checks.push(await checkUser(deps, u));
      checks.push(await checkAgentProbe(deps, config, u));
    }
  }
  checks.push(await checkGatewayLaunchd(deps));
  return { checks, ok: checks.every((c) => c.status !== "fail") };
}

export function formatDoctorTable(result: DoctorResult): string {
  const width = Math.max(...result.checks.map((c) => c.name.length), 4);
  const lines = result.checks.map((c) => `${c.status.toUpperCase().padEnd(4)}  ${c.name.padEnd(width)}  ${c.detail}`);
  lines.push("", result.ok ? "doctor: OK" : "doctor: FAIL");
  return lines.join("\n");
}
