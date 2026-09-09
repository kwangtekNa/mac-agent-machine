import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export type LoginSource = "mam-token" | "credentials-file" | "claude-json" | null;

export interface LoginInfo {
  loggedIn: boolean;
  account: string | null;
  source: LoginSource;
  warning?: string;
}

/** setup-token 으로 얻은 OAuth 토큰 파일(ADR-008). 0600. */
export function tokenPath(home: string): string {
  return join(home, ".mam", "secrets", "claude-oauth-token");
}

export async function readOauthToken(home: string): Promise<string | null> {
  try {
    const text = (await readFile(tokenPath(home), "utf8")).trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const TOKEN_WARN_AGE_MS = 330 * 24 * 60 * 60 * 1000;

/**
 * 순서: (1) `~/.mam/secrets/claude-oauth-token`, (2) `<configDir>/.credentials.json` 의 `claudeAiOauth`,
 * (3) `~/.claude.json` 의 `oauthAccount.emailAddress`. Keychain 은 조회하지 않는다(ADR-008).
 */
export async function detectLogin(home: string, env: NodeJS.ProcessEnv = process.env): Promise<LoginInfo> {
  const configDir = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.length > 0 ? env.CLAUDE_CONFIG_DIR : join(home, ".claude");
  const claudeJsonPath = configDir === join(home, ".claude") ? join(home, ".claude.json") : join(configDir, ".claude.json");
  const claudeJson = await readJson(claudeJsonPath);
  const oauthAccount = claudeJson?.oauthAccount;
  const email =
    oauthAccount && typeof oauthAccount === "object" && typeof (oauthAccount as { emailAddress?: unknown }).emailAddress === "string"
      ? ((oauthAccount as { emailAddress: string }).emailAddress)
      : null;

  const tokenFile = tokenPath(home);
  try {
    const info = await stat(tokenFile);
    const token = await readOauthToken(home);
    if (token) {
      const result: LoginInfo = { loggedIn: true, account: email, source: "mam-token" };
      if (Date.now() - info.mtimeMs >= TOKEN_WARN_AGE_MS) result.warning = "토큰 만료 임박";
      return result;
    }
  } catch {
    // 토큰 파일 없음
  }

  const credentials = await readJson(join(configDir, ".credentials.json"));
  if (credentials && credentials.claudeAiOauth && typeof credentials.claudeAiOauth === "object") {
    return { loggedIn: true, account: email, source: "credentials-file" };
  }

  if (email) return { loggedIn: true, account: email, source: "claude-json" };
  return { loggedIn: false, account: null, source: null };
}
