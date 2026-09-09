import { chmod, mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectLogin, readOauthToken, tokenPath } from "../../../src/agents/claude/credentials.js";
import { makeTmpHome, removeTmp } from "../../helpers/tmp-home.js";

let home: string;

beforeEach(async () => {
  home = await makeTmpHome("mam-cred-");
});
afterEach(async () => {
  await removeTmp(home);
});

async function writeToken(text: string): Promise<string> {
  const path = tokenPath(home);
  await mkdir(join(home, ".mam", "secrets"), { recursive: true, mode: 0o700 });
  await writeFile(path, text, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

describe("detectLogin", () => {
  it("로그인 흔적이 없으면 loggedIn=false", async () => {
    await expect(detectLogin(home, {})).resolves.toEqual({ loggedIn: false, account: null, source: null });
  });

  it("(1) 토큰 파일 → mam-token, 내용 trim, 330일 이상이면 warning", async () => {
    const path = await writeToken("sk-ant-oat01-abc\n");
    await expect(readOauthToken(home)).resolves.toBe("sk-ant-oat01-abc");
    let info = await detectLogin(home, {});
    expect(info).toEqual({ loggedIn: true, account: null, source: "mam-token" });
    const old = new Date(Date.now() - 340 * 24 * 60 * 60 * 1000);
    await utimes(path, old, old);
    info = await detectLogin(home, {});
    expect(info.source).toBe("mam-token");
    expect(info.warning).toBe("토큰 만료 임박");
  });

  it("(2) <configDir>/.credentials.json 의 claudeAiOauth → credentials-file, CLAUDE_CONFIG_DIR 존중", async () => {
    const configDir = join(home, "cfg");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "x" } }));
    await expect(detectLogin(home, {})).resolves.toMatchObject({ loggedIn: false });
    await expect(detectLogin(home, { CLAUDE_CONFIG_DIR: configDir })).resolves.toEqual({
      loggedIn: true,
      account: null,
      source: "credentials-file",
    });
  });

  it("(3) ~/.claude.json 의 oauthAccount.emailAddress → claude-json, account 로 쓴다", async () => {
    await writeFile(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "alice@example.com" } }));
    await expect(detectLogin(home, {})).resolves.toEqual({ loggedIn: true, account: "alice@example.com", source: "claude-json" });
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: {} }));
    await expect(detectLogin(home, {})).resolves.toEqual({ loggedIn: true, account: "alice@example.com", source: "credentials-file" });
  });

  it("빈 토큰 파일은 없는 것으로 본다", async () => {
    await writeToken("   \n");
    await expect(readOauthToken(home)).resolves.toBeNull();
    await expect(detectLogin(home, {})).resolves.toMatchObject({ loggedIn: false });
  });
});
