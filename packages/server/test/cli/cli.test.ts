import { describe, expect, it } from "vitest";
import { createProgram, devPortOverride } from "../../src/cli/program.js";
import type { CliIo } from "../../src/cli/common.js";

class ExitError extends Error { constructor(readonly code: number) { super(`exit ${code}`); } }

async function run(args: string[], uid = 501): Promise<{ code: number; out: string; err: string }> {
  const outs: string[] = [];
  const errs: string[] = [];
  const io: CliIo = { uid, out: (l) => outs.push(l), err: (l) => errs.push(l), exit: (code) => { throw new ExitError(code); } };
  const program = createProgram(io).exitOverride();
  let help = "";
  const cfg = { writeOut: (s: string) => (help += s), writeErr: (s: string) => errs.push(s) };
  program.configureOutput(cfg);
  for (const cmd of program.commands) { cmd.exitOverride().configureOutput(cfg); for (const sub of cmd.commands) sub.exitOverride().configureOutput(cfg); }
  let code = 0;
  try { await program.parseAsync(["node", "mam", ...args]); } catch (err) {
    if (err instanceof ExitError) code = err.code;
    else if ((err as { exitCode?: number }).exitCode !== undefined) code = (err as { exitCode: number }).exitCode;
    else throw err;
  }
  return { code, out: help + outs.join("\n"), err: errs.join("\n") };
}

describe("mam cli", () => {
  it("--help lists every subcommand", async () => {
    const r = await run(["--help"]);
    for (const name of ["gateway", "agent-host", "user", "doctor", "config"]) expect(r.out).toContain(name);
    const u = await run(["user", "--help"]);
    for (const name of ["add", "list", "remove"]) expect(u.out).toContain(name);
  });
  it("no args prints version", async () => { expect((await run([])).out).toBe("mam 0.1.0"); });
  it("user add / config init without root exit 1 with a message", async () => {
    const r = await run(["user", "add", "alice", "--email", "alice@example.com"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("sudo mam user add");
    expect((await run(["config", "init"])).code).toBe(1);
  });
  it("doctor with nonexistent config exits 1 without crashing", async () => {
    const r = await run(["doctor", "--config", "/nonexistent/config.json", "--json"]);
    expect(r.code).toBe(1);
    const json = JSON.parse(r.out);
    expect(json.ok).toBe(false);
    expect(json.checks.find((c: { name: string }) => c.name === "config").status).toBe("fail");
  });
  it("devPortOverride reads MAM_DEV_PORT for `gateway --dev` (scripts/dev-smoke.sh 포트 충돌 회피)", () => {
    expect(devPortOverride({})).toEqual({});
    expect(devPortOverride({ MAM_DEV_PORT: "8080" })).toEqual({ port: 8080 });
    expect(devPortOverride({ MAM_DEV_PORT: "not-a-number" })).toEqual({});
  });
});
