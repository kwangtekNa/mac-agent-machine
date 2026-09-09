import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { renderPlist } from "../../src/admin/plist.js";

const execFileAsync = promisify(execFile);
const ROOT = new URL("../../../../", import.meta.url);

async function lint(xml: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mam-plist-"));
  try {
    const p = join(dir, "t.plist");
    await writeFile(p, xml);
    const { stdout } = await execFileAsync("plutil", ["-lint", p], { encoding: "utf8" });
    expect(stdout).toContain("OK");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("renderPlist", () => {
  it("renders gateway template into a valid plist", async () => {
    const out = renderPlist(await readFile(new URL("scripts/launchd/dev.mam.gateway.plist.tmpl", ROOT), "utf8"), { NODE: "/opt/homebrew/bin/node", MAM_CLI: "/opt/mam/packages/server/dist/cli.js" });
    expect(out).toContain("<string>/opt/homebrew/bin/node</string>");
    expect(out).toContain("<string>dev.mam.gateway</string>");
    expect(out).toContain("/var/log/mam/gateway.log");
    expect(out).not.toMatch(/__[A-Z_]+__/);
    await lint(out);
  });
  it("renders certrenew template (Sunday 04:00)", async () => {
    const out = renderPlist(await readFile(new URL("scripts/launchd/dev.mam.certrenew.plist.tmpl", ROOT), "utf8"), { RENEW_SCRIPT: "/opt/mam/scripts/renew-cert.sh", TAILSCALE: "/opt/homebrew/bin/tailscale", HOSTNAME: "mac.tail.ts.net" });
    expect(out).toContain("<key>Weekday</key>\n    <integer>0</integer>");
    expect(out).toContain("<string>mac.tail.ts.net</string>");
    await lint(out);
  });
  it("escapes XML and rejects missing placeholders", () => {
    expect(renderPlist("<string>__A__</string>", { A: "x&y<z>" })).toBe("<string>x&amp;y&lt;z&gt;</string>");
    expect(() => renderPlist("<string>__A__ __B__</string>", { A: "1" })).toThrow(/__B__/);
  });
});
