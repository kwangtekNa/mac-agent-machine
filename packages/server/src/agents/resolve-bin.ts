import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export type BinaryName = "claude" | "codex";

const cache = new Map<BinaryName, Promise<string | null>>();

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 로그인 셸의 `command -v <name>`. name 은 리터럴 유니온이라 사용자 입력이 섞이지 않는다(CLAUDE.md CRITICAL 4 예외). */
function fromLoginShell(name: BinaryName, timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.env.SHELL ?? "/bin/zsh", ["-lc", `command -v ${name}`], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      const first = out.split("\n")[0]?.trim() ?? "";
      finish(code === 0 && isAbsolute(first) ? first : null);
    });
  });
}

function candidates(name: BinaryName): string[] {
  return [join(homedir(), ".local", "bin", name), `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`];
}

async function lookup(name: BinaryName): Promise<string | null> {
  const shell = await fromLoginShell(name);
  if (shell && (await isExecutable(shell))) return shell;
  for (const candidate of candidates(name)) {
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

/** 우선순위: envOverride → 사용자 로그인 셸의 `command -v` → 후보 경로. 없으면 null. 결과는 프로세스 수명 동안 캐시. */
export async function resolveBinary(name: BinaryName, envOverride?: string): Promise<string | null> {
  if (envOverride && envOverride.length > 0 && (await isExecutable(envOverride))) return envOverride;
  let pending = cache.get(name);
  if (!pending) {
    pending = lookup(name);
    cache.set(name, pending);
  }
  return pending;
}
