import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdminDeps, ExecResult } from "../../src/admin/exec.js";
import { addUser, listUsers, removeUser } from "../../src/admin/users.js";
import { makeTmpHome, removeTmp } from "../helpers/tmp-home.js";

interface Call { bin: string; args: string[] }
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyExampleKey alice@laptop";

describe("addUser", () => {
  let root: string;
  let deps: AdminDeps;
  let calls: Call[];
  let logs: string[];
  const accounts = new Set<string>();

  beforeEach(async () => {
    root = await makeTmpHome("mam-admin-");
    accounts.clear();
    calls = [];
    logs = [];
    const exec = async (bin: string, args: string[]): Promise<ExecResult> => {
      calls.push({ bin, args });
      if (bin === "/usr/bin/dscl") return { code: accounts.has(args[2]!.replace("/Users/", "")) ? 0 : 1, stdout: "", stderr: "" };
      if (bin === "/usr/sbin/sysadminctl" && args[0] === "-addUser") accounts.add(args[1]!);
      if (bin === "/usr/sbin/sysadminctl" && args[0] === "-deleteUser") accounts.delete(args[1]!);
      return { code: 0, stdout: "", stderr: "" };
    };
    await mkdir(join(root, "etc"), { recursive: true });
    await writeFile(join(root, "etc/config.json"), JSON.stringify({ port: 443, hostname: "mac.tail.ts.net", users: [] }));
    const push = (...a: unknown[]): number => logs.push(a.join(" "));
    deps = { exec, configPath: join(root, "etc/config.json"), paths: { homeRoot: join(root, "Users"), runRoot: join(root, "run") }, logger: { info: push, warn: push, error: push }, uid: 0 };
  });
  afterEach(() => removeTmp(root));

  it("creates account with random password never logged; sets up home, keys, ownership, config", async () => {
    const r = await addUser(deps, { name: "alice", email: "Alice@Example.com", sshKey: KEY });
    expect(r.created).toBe(true);
    const add = calls.find((c) => c.bin === "/usr/sbin/sysadminctl")!;
    expect(add.args.slice(0, 2)).toEqual(["-addUser", "alice"]);
    expect(add.args).not.toContain("-admin");
    expect(add.args).toContain("/bin/zsh");
    const pw = add.args[add.args.indexOf("-password") + 1]!;
    expect(pw).toHaveLength(32);
    expect(logs.join("\n")).not.toContain(pw);
    expect(r.nextSteps.join("\n")).not.toContain(pw);
    expect(r.nextSteps.join("\n")).toContain("ssh alice@mac.tail.ts.net");
    expect(calls.some((c) => c.bin === "/usr/sbin/createhomedir" && c.args.includes("alice"))).toBe(true);
    const home = join(root, "Users/alice");
    expect((await stat(join(home, ".mam"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(home, "work"))).isDirectory()).toBe(true);
    expect(await readFile(join(home, ".ssh/authorized_keys"), "utf8")).toBe(KEY + "\n");
    expect((await stat(join(home, ".ssh/authorized_keys"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, "run/alice"))).mode & 0o777).toBe(0o700);
    const chown = calls.filter((c) => c.bin === "/usr/sbin/chown");
    expect(chown[0]!.args).toEqual(["-R", "alice:staff", join(home, ".ssh"), join(home, "work"), join(home, ".mam")]);
    expect(chown[1]!.args).toEqual(["alice:staff", join(root, "run/alice")]);
    const cfg = JSON.parse(await readFile(deps.configPath, "utf8"));
    expect(cfg.users).toEqual([{ macUser: "alice", email: "alice@example.com", workspaceRoot: "~/work" }]);
    expect(cfg.hostname).toBe("mac.tail.ts.net");
    expect((await readdir(join(root, "etc"))).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("is idempotent: no recreate, no duplicate key, config entry updated", async () => {
    await addUser(deps, { name: "alice", email: "alice@example.com", sshKey: KEY });
    calls.length = 0;
    const r = await addUser(deps, { name: "alice", email: "new@example.com", sshKey: KEY, workspace: "~/code" });
    expect(r.created).toBe(false);
    expect(calls.some((c) => c.bin === "/usr/sbin/sysadminctl" || c.bin === "/usr/sbin/createhomedir")).toBe(false);
    expect(await readFile(join(root, "Users/alice/.ssh/authorized_keys"), "utf8")).toBe(KEY + "\n");
    expect(JSON.parse(await readFile(deps.configPath, "utf8")).users).toEqual([{ macUser: "alice", email: "new@example.com", workspaceRoot: "~/code" }]);
    expect((await stat(join(root, "Users/alice/code"))).isDirectory()).toBe(true);
  });

  it("rejects invalid names/emails before touching the system; needs config", async () => {
    for (const name of ["Alice", "1abc", "a b", "../x", "a".repeat(32), ""]) await expect(addUser(deps, { name, email: "a@b.co" })).rejects.toThrow(/잘못된 사용자 이름/);
    await expect(addUser(deps, { name: "alice", email: "not-an-email" })).rejects.toThrow(/잘못된 이메일/);
    expect(calls).toEqual([]);
    await expect(addUser({ ...deps, configPath: join(root, "nope.json") }, { name: "alice", email: "a@b.co" })).rejects.toThrow(/config init/);
  });

  it("listUsers reports state; removeUser needs --yes for account deletion and keeps home", async () => {
    await addUser(deps, { name: "alice", email: "alice@example.com" });
    expect(await listUsers({ ...deps, probeSocket: async () => true })).toEqual([{ macUser: "alice", email: "alice@example.com", accountExists: true, socketAlive: false }]);
    await expect(removeUser(deps, { name: "alice", deleteAccount: true })).rejects.toThrow(/--yes/);
    await removeUser(deps, { name: "alice", deleteAccount: true, yes: true });
    expect(calls.at(-1)).toEqual({ bin: "/usr/sbin/sysadminctl", args: ["-deleteUser", "alice", "-keepHome"] });
    expect(JSON.parse(await readFile(deps.configPath, "utf8")).users).toEqual([]);
    await expect(stat(join(root, "run/alice"))).rejects.toThrow();
  });
});
