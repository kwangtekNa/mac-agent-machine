import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatDoctorTable, parseNotAfter, runDoctor, type DoctorDeps } from "../../src/admin/doctor.js";
import type { ExecResult } from "../../src/admin/exec.js";
import { makeTmpHome, removeTmp } from "../helpers/tmp-home.js";

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const bad = (): ExecResult => ({ code: 1, stdout: "", stderr: "boom" });
const ts = (state = "Running", dns = "mac.tail.ts.net."): string => JSON.stringify({ BackendState: state, Self: { DNSName: dns, TailscaleIPs: ["100.64.0.1"] } });

describe("runDoctor", () => {
  let root: string;
  let configPath: string;
  const NOW = Date.parse("2026-09-09T00:00:00Z");
  beforeEach(async () => {
    root = await makeTmpHome("mam-doctor-");
    await mkdir(join(root, "tls"), { recursive: true });
    await writeFile(join(root, "tls/cert.pem"), "x");
    await writeFile(join(root, "tls/key.pem"), "x");
    await mkdir(join(root, "Users/alice/work"), { recursive: true });
    await mkdir(join(root, "run/alice"), { recursive: true });
    await writeFile(join(root, "mam.conf"), "PasswordAuthentication no\n");
    configPath = join(root, "config.json");
    await writeFile(configPath, JSON.stringify({ hostname: "mac.tail.ts.net", tls: { cert: join(root, "tls/cert.pem"), key: join(root, "tls/key.pem") }, users: [{ macUser: "alice", email: "alice@example.com" }], paths: { node: process.execPath, mamCli: process.execPath } }));
  });
  afterEach(() => removeTmp(root));
  const deps = (handler: (bin: string) => ExecResult, uid = 0): DoctorDeps => ({ exec: async (bin) => handler(bin), configPath, uid, tailscaleBin: "/fake/tailscale", now: () => NOW, paths: { homeRoot: join(root, "Users"), runRoot: join(root, "run"), sshdConf: join(root, "mam.conf") } });

  it("all green when every command succeeds", async () => {
    const r = await runDoctor(deps((bin) => {
      if (bin === "/fake/tailscale") return ok(ts());
      if (bin === "openssl") return ok("notAfter=Dec 31 00:00:00 2026 GMT\n");
      if (bin === "/usr/bin/sudo") return ok(JSON.stringify({ claude: { available: true, version: "2.1.266", loggedIn: true, account: "a@b.co" }, codex: { available: true, version: "0.153.4", loggedIn: true, account: "a@b.co" } }));
      return ok();
    }));
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => c.name)).toEqual(["root", "config", "tailscale", "tailscale.ipv4", "tailscale.dns", "tls", "paths", "sshd", "sshd.hardening", "runRoot", "user:alice", "agents:alice", "gateway.launchd"]);
    expect(r.checks.find((c) => c.name === "agents:alice")).toMatchObject({ status: "ok", detail: expect.stringContaining("claude 2.1.266 로그인됨(a@b.co)") });
    expect(r.checks.find((c) => c.name === "tls")!.detail).toMatch(/113일/);
    expect(formatDoctorTable(r)).toContain("doctor: OK");
  });

  it("warns on cert <14d and non-root; fails on NeedsLogin, dns mismatch, missing sshd", async () => {
    const r = await runDoctor(deps((bin) => {
      if (bin === "/fake/tailscale") return ok(ts("NeedsLogin", "other.tail.ts.net."));
      if (bin === "openssl") return ok("notAfter=Sep 15 00:00:00 2026 GMT\n");
      if (bin === "/bin/launchctl") return bad();
      return ok();
    }, 501));
    const by = Object.fromEntries(r.checks.map((c) => [c.name, c]));
    expect(r.ok).toBe(false);
    expect(by.root!.status).toBe("warn");
    expect(by.tls).toMatchObject({ status: "warn", detail: expect.stringContaining("6일") });
    expect(by.tailscale!.status).toBe("fail");
    expect(by["tailscale.dns"]!.status).toBe("fail");
    expect(by.sshd!.status).toBe("fail");
    expect(by["agents:alice"]!.status).toBe("warn");
    expect(formatDoctorTable(r)).toContain("doctor: FAIL");
  });

  it("fails on unreadable config and skips config-dependent checks", async () => {
    const seen: string[] = [];
    const r = await runDoctor({ ...deps((bin) => { seen.push(bin); return ok(); }), configPath: join(root, "nonexistent.json") });
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === "config")!.status).toBe("fail");
    expect(seen).not.toContain("/fake/tailscale");
  });

  it("parses openssl enddate", () => {
    expect(parseNotAfter("notAfter=Sep 30 12:00:00 2026 GMT\n")?.toISOString()).toBe("2026-09-30T12:00:00.000Z");
    expect(parseNotAfter("garbage")).toBeNull();
  });
});
