import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import { readConfigRaw, usersOf, writeConfigAtomic, type RawUserEntry } from "./config-store.js";
import { fsOf, resolvePaths, type AdminDeps } from "./exec.js";

export const USER_NAME_RE = /^[a-z_][a-z0-9_-]{0,30}$/;
const EmailSchema = z.email();
const DEFAULT_WORKSPACE = "~/work";

export interface AddUserOptions {
  name: string;
  email: string;
  fullName?: string;
  sshKey?: string;
  workspace?: string;
  /** nextSteps 안내용 호스트명. 기본 config.hostname. */
  hostname?: string;
}

export interface AddUserResult {
  created: boolean;
  nextSteps: string[];
}

export interface UserStatus {
  macUser: string;
  email: string;
  accountExists: boolean;
  socketAlive: boolean;
}

export function validateUserName(name: string): string {
  if (!USER_NAME_RE.test(name)) {
    throw new Error(`잘못된 사용자 이름: ${JSON.stringify(name)} (허용: ^[a-z_][a-z0-9_-]{0,30}$)`);
  }
  return name;
}

export function normalizeEmail(email: string): string {
  const parsed = EmailSchema.safeParse(email.trim());
  if (!parsed.success) throw new Error(`잘못된 이메일: ${JSON.stringify(email)}`);
  return parsed.data.toLowerCase();
}

/** 무작위 32자(base64url). 반환값은 sysadminctl 인자로만 쓰이고 어디에도 기록하지 않는다. */
export function randomPassword(): string {
  return randomBytes(24).toString("base64url").slice(0, 32);
}

/** `~/x` → `<home>/x`. 절대 경로는 그대로. */
export function expandWorkspace(workspace: string, home: string): string {
  if (workspace === "~") return home;
  if (workspace.startsWith("~/")) return join(home, workspace.slice(2));
  return workspace;
}

async function exists(fs: Awaited<ReturnType<typeof fsOf>>, path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function accountExists(deps: AdminDeps, name: string): Promise<boolean> {
  const r = await deps.exec("/usr/bin/dscl", [".", "-read", `/Users/${name}`]);
  return r.code === 0;
}

async function ensureAuthorizedKey(deps: AdminDeps, home: string, key: string): Promise<boolean> {
  const fs = await fsOf(deps);
  const sshDir = join(home, ".ssh");
  const file = join(sshDir, "authorized_keys");
  await fs.mkdir(sshDir, { recursive: true, mode: 0o700 });
  await fs.chmod(sshDir, 0o700);
  let current = "";
  try {
    current = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const wanted = key.trim();
  const lines = current.split("\n").map((l) => l.trim());
  if (lines.includes(wanted)) {
    await fs.chmod(file, 0o600);
    return false;
  }
  const next = current.length === 0 || current.endsWith("\n") ? current + wanted + "\n" : current + "\n" + wanted + "\n";
  await fs.writeFile(file, next, { mode: 0o600 });
  await fs.chmod(file, 0o600);
  return true;
}

async function upsertConfigUser(deps: AdminDeps, entry: RawUserEntry): Promise<Record<string, unknown>> {
  const fs = await fsOf(deps);
  const raw = await readConfigRaw(fs, deps.configPath);
  if (raw === null) throw new Error(`설정 파일이 없습니다: ${deps.configPath} — 먼저 'mam config init' 을 실행하세요`);
  const users = usersOf(raw);
  const idx = users.findIndex((u) => u.macUser === entry.macUser);
  const merged: RawUserEntry = idx >= 0 ? { ...users[idx], ...entry } : entry;
  if (idx >= 0) users[idx] = merged;
  else users.push(merged);
  const next = { ...raw, users };
  await writeConfigAtomic(fs, deps.configPath, next);
  return next;
}

/**
 * 사용자 추가(멱등). 계정 → 홈 → authorized_keys → 워크스페이스/.mam → 소유권 → 소켓 디렉토리 → config.
 * 비밀번호는 무작위로 생성해 sysadminctl 인자로만 넘기고 저장·출력하지 않는다.
 */
export async function addUser(deps: AdminDeps, opts: AddUserOptions): Promise<AddUserResult> {
  const name = validateUserName(opts.name);
  const email = normalizeEmail(opts.email);
  const fs = await fsOf(deps);
  const paths = resolvePaths(deps);
  const log = deps.logger;
  const home = join(paths.homeRoot, name);

  let created = false;
  if (await accountExists(deps, name)) {
    log?.info(`계정 ${name} 이(가) 이미 있습니다 — 생성 건너뜀`);
  } else {
    const r = await deps.exec("/usr/sbin/sysadminctl", [
      "-addUser", name,
      "-fullName", opts.fullName ?? name,
      "-password", randomPassword(),
      "-home", home,
      "-shell", "/bin/zsh",
    ]);
    if (r.code !== 0) throw new Error(`sysadminctl -addUser 실패 (exit ${r.code}): ${r.stderr.trim()}`);
    created = true;
    log?.info(`계정 ${name} 생성 (비관리자, /bin/zsh, ${home})`);
  }

  if (!(await exists(fs, home))) {
    const r = await deps.exec("/usr/sbin/createhomedir", ["-c", "-u", name]);
    if (r.code !== 0) log?.warn(`createhomedir 실패 (exit ${r.code}): ${r.stderr.trim()}`);
    await fs.mkdir(home, { recursive: true, mode: 0o755 });
  }

  const owned: string[] = [];
  if (opts.sshKey) {
    const added = await ensureAuthorizedKey(deps, home, opts.sshKey);
    log?.info(added ? "authorized_keys 에 공개키 추가" : "공개키가 이미 authorized_keys 에 있음");
    owned.push(join(home, ".ssh"));
  }

  const workspaceRoot = opts.workspace ?? DEFAULT_WORKSPACE;
  const workspace = expandWorkspace(workspaceRoot, home);
  await fs.mkdir(workspace, { recursive: true, mode: 0o755 });
  const mamDir = join(home, ".mam");
  await fs.mkdir(mamDir, { recursive: true, mode: 0o700 });
  await fs.chmod(mamDir, 0o700);
  owned.push(workspace, mamDir);

  const chown = await deps.exec("/usr/sbin/chown", ["-R", `${name}:staff`, ...owned]);
  if (chown.code !== 0) throw new Error(`chown 실패 (exit ${chown.code}): ${chown.stderr.trim()}`);

  const runDir = join(paths.runRoot, name);
  await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
  await fs.chmod(runDir, 0o700);
  const chownRun = await deps.exec("/usr/sbin/chown", [`${name}:staff`, runDir]);
  if (chownRun.code !== 0) throw new Error(`chown 실패 (exit ${chownRun.code}): ${chownRun.stderr.trim()}`);

  const config = await upsertConfigUser(deps, { macUser: name, email, workspaceRoot });
  const hostname = opts.hostname ?? (typeof config.hostname === "string" ? config.hostname : "<hostname>");

  const nextSteps = [
    `Tailscale: ${email} 계정을 tailnet 에 초대하거나 이 노드를 해당 사용자에게 공유하세요 (admin console → Machines → Share).`,
    `SSH: ssh ${name}@${hostname}  (공개키 전용, 비밀번호 로그인 없음)`,
    `Claude 로그인: SSH 세션에서 'claude login' 실행 (자격증명은 ~/.claude/.credentials.json 에 저장됨).`,
    `Codex 로그인: SSH 세션에서 'codex login' 실행하거나 앱의 device code 흐름 사용.`,
    `앱: https://${hostname} 을 MacAgent 앱에 입력하면 whois 신원으로 자동 매핑됩니다.`,
  ];
  return { created, nextSteps };
}

function socketAlive(path: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect(path);
    const done = (ok: boolean): void => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

export async function listUsers(deps: AdminDeps & { probeSocket?: (path: string) => Promise<boolean> }): Promise<UserStatus[]> {
  const fs = await fsOf(deps);
  const paths = resolvePaths(deps);
  const raw = await readConfigRaw(fs, deps.configPath);
  const users = raw ? usersOf(raw) : [];
  const probe = deps.probeSocket ?? socketAlive;
  const out: UserStatus[] = [];
  for (const u of users) {
    const sockPath = join(paths.runRoot, u.macUser, "agent.sock");
    out.push({
      macUser: u.macUser,
      email: u.email,
      accountExists: await accountExists(deps, u.macUser),
      socketAlive: (await exists(fs, sockPath)) && (await probe(sockPath)),
    });
  }
  return out;
}

export interface RemoveUserOptions {
  name: string;
  deleteAccount?: boolean;
  yes?: boolean;
}

/** config 에서 제거하고 소켓 디렉토리를 지운다. `deleteAccount` 는 `yes` 가 있어야 하며 홈은 보존한다(-keepHome). */
export async function removeUser(deps: AdminDeps, opts: RemoveUserOptions): Promise<void> {
  const name = validateUserName(opts.name);
  const fs = await fsOf(deps);
  const paths = resolvePaths(deps);
  const log = deps.logger;
  if (opts.deleteAccount && !opts.yes) {
    throw new Error(`--delete-account 는 macOS 계정 ${name} 을 삭제합니다. 확인하려면 --yes 를 함께 지정하세요`);
  }
  const raw = await readConfigRaw(fs, deps.configPath);
  if (raw) {
    const users = usersOf(raw).filter((u) => u.macUser !== name);
    await writeConfigAtomic(fs, deps.configPath, { ...raw, users });
    log?.info(`config users[] 에서 ${name} 제거`);
  }
  await fs.rm(join(paths.runRoot, name), { recursive: true, force: true });
  if (opts.deleteAccount) {
    if (!(await accountExists(deps, name))) {
      log?.info(`계정 ${name} 이(가) 없습니다 — 삭제 건너뜀`);
      return;
    }
    const r = await deps.exec("/usr/sbin/sysadminctl", ["-deleteUser", name, "-keepHome"]);
    if (r.code !== 0) throw new Error(`sysadminctl -deleteUser 실패 (exit ${r.code}): ${r.stderr.trim()}`);
    log?.info(`계정 ${name} 삭제 (홈 ${join(paths.homeRoot, name)} 은 보존)`);
  }
}
