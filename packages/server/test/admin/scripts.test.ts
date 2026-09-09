import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const ROOT = new URL("../../../../", import.meta.url);

describe("shell scripts", () => {
  it.each(["scripts/setup-server.sh", "scripts/renew-cert.sh"])("%s passes bash -n, strict mode, no recursive rm", async (rel) => {
    const path = fileURLToPath(new URL(rel, ROOT));
    await execFileAsync("bash", ["-n", path]);
    const body = await readFile(path, "utf8");
    expect(body).toContain("set -euo pipefail");
    expect(body).not.toMatch(/rm\s+-rf/);
  });
  it("setup-server.sh refuses to run without root", async () => {
    const r = await execFileAsync("bash", [fileURLToPath(new URL("scripts/setup-server.sh", ROOT))], { encoding: "utf8" }).catch((e: { code: number; stderr: string }) => e);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("root");
  });
});
