import { access, chmod, constants, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { IPtyForkOptions } from "node-pty";
import { AgentUnavailableError } from "../../errors.js";
import { tokenPath } from "../../agents/claude/credentials.js";
import { resolveBinary } from "../../agents/resolve-bin.js";
import type { LoginFlow } from "./flows.js";

type Logger = Pick<Console, "info" | "warn" | "error">;

/** `node-pty` 의 `IPty` 중 쓰는 부분. 테스트는 EventEmitter 기반 가짜를 넣는다. */
export interface PtyLike {
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  kill(signal?: string): void;
}
export type PtySpawn = (file: string, args: string[], options: IPtyForkOptions) => PtyLike;

export interface ClaudeLoginOptions {
  id: string;
  home: string;
  env?: NodeJS.ProcessEnv;
  /** 기본 `MAM_CLAUDE_BIN` → `resolveBinary('claude')`. SDK 는 실행파일을 번들하지 않는다(README 참고). */
  binPath?: string;
  ptySpawn?: PtySpawn;
  logger?: Logger;
  /** URL 검출 대기. 기본 30초. */
  urlTimeoutMs?: number;
  /** 플로우 전체. 기본 10분. */
  timeoutMs?: number;
}

export const CLAUDE_LOGIN_INSTRUCTIONS = "링크를 열어 로그인한 뒤 표시되는 코드를 붙여넣으세요";
/** 관찰한 접두어(README). 토큰 본문은 URL-safe base64. */
const TOKEN_RE = /sk-ant-oat01-[A-Za-z0-9_-]{20,}/;
const URL_RE = /https:\/\/[^\s"'<>]+/;
const ERROR_RE = /^.*\b(invalid|expired|error|failed)\b.*$/im;
const MAX_BUFFER = 64 * 1024;

/**
 * Ink 출력 정리: `ESC[nG`(커서 열 이동) 는 단어 사이 공백 대용이라 공백으로 바꾸고, 나머지 CSI/OSC 는 제거한다.
 * `\r` 은 버리고, 200열 이상에서 줄바꿈된 URL 은 그대로 두되 URL 추출 시 이어 붙인다.
 */
export function cleanTerminalOutput(raw: string): string {
  return raw
    .replace(/\x1b\[\d*G/g, " ")
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][A-Za-z0-9]/g, "")
    .replace(/\x1b[=>78]/g, "")
    .replace(/\r/g, "");
}

/**
 * 첫 `https://` URL. 터미널 폭에서 줄바꿈된 조각(빈 줄 없이 이어지는 줄)은 이어 붙인다.
 * pty 청크가 URL 중간에서 끊길 수 있으므로 URL 뒤에 공백/줄바꿈이 와야(끝이 확정돼야) 반환한다.
 */
export function extractUrl(text: string): string | null {
  const m = URL_RE.exec(text);
  if (!m) return null;
  let url = m[0];
  let rest = text.slice(m.index + m[0].length);
  while (rest.startsWith("\n") && !rest.startsWith("\n\n")) {
    const next = /^\n([^\s"'<>]+)/.exec(rest);
    if (!next) break;
    url += next[1];
    rest = rest.slice(next[0].length);
  }
  return rest.length > 0 ? url : null;
}

/** node-pty 1.1.0 prebuild 의 spawn-helper 에 실행 비트가 없어 posix_spawnp 가 실패한다(README). 가능하면 고친다. */
async function ensureSpawnHelperExecutable(logger: Logger): Promise<void> {
  try {
    const require = createRequire(import.meta.url);
    const helper = join(dirname(require.resolve("node-pty/package.json")), "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
    try {
      await access(helper, constants.X_OK);
    } catch {
      await chmod(helper, 0o755);
      logger.info("[claude-login] node-pty spawn-helper 에 실행 권한을 부여했습니다");
    }
  } catch (err) {
    logger.warn(`[claude-login] spawn-helper 확인 실패: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function saveToken(home: string, token: string): Promise<void> {
  const path = tokenPath(home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  await writeFile(path, token, { mode: 0o600 });
  await chmod(path, 0o600);
}

/** `claude setup-token` 을 pty 에서 띄워 URL 을 돌려주고, 코드를 stdin 에 써서 토큰을 `~/.mam/secrets/claude-oauth-token` 에 저장한다(ADR-008). */
export async function startClaudeLogin(opts: ClaudeLoginOptions): Promise<LoginFlow> {
  const logger = opts.logger ?? console;
  const baseEnv = opts.env ?? process.env;
  const binPath = opts.binPath ?? (await resolveBinary("claude", baseEnv.MAM_CLAUDE_BIN));
  if (!binPath) throw new AgentUnavailableError("claude 실행파일을 찾을 수 없습니다");
  let ptySpawn = opts.ptySpawn;
  if (!ptySpawn) {
    await ensureSpawnHelperExecutable(logger);
    ptySpawn = (await import("node-pty")).spawn as unknown as PtySpawn;
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(baseEnv)) if (v !== undefined) env[k] = v;
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  env.HOME = opts.home;

  let term: PtyLike;
  try {
    // URL 이 330자 안팎이라 200열에서는 줄바꿈된다. 400열이면 한 줄에 들어오고 extractUrl 이 줄바꿈도 이어 붙인다.
    term = ptySpawn(binPath, ["setup-token"], { name: "xterm-256color", cols: 400, rows: 50, cwd: opts.home, env });
  } catch (err) {
    throw new AgentUnavailableError(`claude setup-token 실행 실패: ${err instanceof Error ? err.message : String(err)}`);
  }

  let raw = "";
  let codeOffset = -1;
  let exited = false;
  let flowTimer: NodeJS.Timeout | undefined;
  const flow: LoginFlow = {
    id: opts.id,
    agent: "claude",
    url: "",
    instructions: CLAUDE_LOGIN_INSTRUCTIONS,
    needsCode: true,
    status: "pending",
    createdAt: Date.now(),
    cancel: () => finish("error", "취소되었습니다"),
    submitCode: async (code: string) => {
      if (flow.status !== "pending") throw new Error("플로우가 이미 끝났습니다");
      codeOffset = cleanTerminalOutput(raw).length;
      term.write(`${code.trim()}\r`);
    },
  };

  const finish = (status: "done" | "error", message: string): void => {
    if (flow.status !== "pending") return;
    flow.status = status;
    flow.message = message;
    raw = "";
    if (flowTimer) clearTimeout(flowTimer);
    if (!exited) term.kill();
  };

  const urlFound = new Promise<void>((resolve, reject) => {
    const urlTimer = setTimeout(() => reject(new AgentUnavailableError("claude setup-token 이 URL 을 출력하지 않았습니다")), opts.urlTimeoutMs ?? 30_000);
    term.onData((chunk) => {
      raw = (raw + chunk).slice(-MAX_BUFFER);
      const text = cleanTerminalOutput(raw);
      if (!flow.url) {
        const url = extractUrl(text);
        if (!url) return;
        flow.url = url;
        clearTimeout(urlTimer);
        logger.info("[claude-login] 로그인 URL 검출");
        resolve();
        return;
      }
      if (flow.status !== "pending") return;
      const tokenMatch = TOKEN_RE.exec(text);
      if (tokenMatch) {
        const token = tokenMatch[0];
        raw = "";
        saveToken(opts.home, token).then(
          () => {
            logger.info("[claude-login] 토큰 저장 완료");
            finish("done", "로그인 완료");
          },
          (err: unknown) => finish("error", `토큰 저장 실패: ${err instanceof Error ? err.message : String(err)}`),
        );
        return;
      }
      if (codeOffset >= 0) {
        const after = text.slice(codeOffset);
        const errLine = ERROR_RE.exec(after);
        if (errLine) finish("error", errLine[0].trim().slice(0, 200));
      }
    });
    term.onExit((e) => {
      exited = true;
      clearTimeout(urlTimer);
      if (!flow.url) reject(new AgentUnavailableError(`claude setup-token 이 종료되었습니다 (exit ${e.exitCode})`));
      else finish("error", `claude setup-token 이 종료되었습니다 (exit ${e.exitCode})`);
    });
  });

  try {
    await urlFound;
  } catch (err) {
    raw = "";
    if (!exited) term.kill();
    throw err;
  }
  flowTimer = setTimeout(() => finish("error", "시간 초과: 10분 안에 코드가 입력되지 않았습니다"), opts.timeoutMs ?? 10 * 60 * 1000);
  return flow;
}
