import { spawn } from "node:child_process";

/** `lsof` 가 이 시간 안에 끝나지 않으면 SIGKILL 하고 빈 목록으로 본다. */
export const LSOF_TIMEOUT_MS = 5_000;

export interface ListeningPort {
  port: number;
  pid: number;
  process: string;
  address: string;
}

export interface ListListeningPortsOptions {
  /** 목록에서 뺄 포트(gateway 자신의 포트 등). 라우트가 넘긴다. */
  exclude?: readonly number[];
  timeoutMs?: number;
  /** 실패·타임아웃 사유. 라우트가 서버 로그로 넘긴다(CRITICAL 6: 포트 목록 자체는 로그에 남기지 않는다). */
  onWarn?: (message: string) => void;
}

/** `n` 필드의 `<addr>:<port>`. `[::1]:5173` 같은 IPv6 리터럴은 대괄호를 벗긴다. 포트가 1~65535 밖이면 null. */
function splitAddress(raw: string): { address: string; port: number } | null {
  const colon = raw.lastIndexOf(":");
  if (colon <= 0) return null;
  const digits = raw.slice(colon + 1);
  if (!/^\d+$/.test(digits)) return null;
  const port = Number(digits);
  if (port < 1 || port > 65535) return null;
  let address = raw.slice(0, colon);
  if (address.startsWith("[") && address.endsWith("]")) address = address.slice(1, -1);
  return address === "" ? null : { address, port };
}

/**
 * `lsof -nP -iTCP -sTCP:LISTEN -F pcn` 출력을 파싱한다(순수 함수, 테스트용).
 *
 * 필드 출력은 줄마다 태그 한 글자로 시작한다: `p<pid>`(프로세스 시작), `c<command>`, `f<fd>`(파일 시작), `n<addr:port>`.
 * 같은 포트가 여러 fd 나 IPv4·IPv6 로 두 번 나오면 하나로 합치고 `address` 는 `*`(모든 인터페이스)를 우선한다.
 * 결과는 포트 오름차순이며, 태그를 모르거나 값이 깨진 줄은 조용히 버린다.
 */
export function parseLsofListen(output: string): ListeningPort[] {
  const byPort = new Map<number, ListeningPort>();
  let pid: number | null = null;
  let command = "";

  for (const line of output.split("\n")) {
    if (line.length < 2) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      pid = /^\d+$/.test(value) ? Number(value) : null;
      command = "";
    } else if (tag === "c") {
      command = value;
    } else if (tag === "n") {
      if (pid === null) continue;
      const parsed = splitAddress(value);
      if (parsed === null) continue;
      const entry: ListeningPort = { port: parsed.port, pid, process: command === "" ? "?" : command, address: parsed.address };
      const existing = byPort.get(entry.port);
      if (existing === undefined || (existing.address !== "*" && entry.address === "*")) byPort.set(entry.port, entry);
    }
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

/**
 * CRITICAL 4: 셸을 거치지 않고 고정 인자 배열로만 띄운다(사용자 입력이 섞이지 않는다).
 * 실패·타임아웃이면 예외 대신 null 을 돌려준다.
 */
function runLsof(timeoutMs: number, onWarn: (message: string) => void): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      env: { ...process.env, LC_ALL: "C" },
    });
    const out: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.on("error", (err) => {
      onWarn(`lsof 실행 실패: ${err.message}`);
      resolve(null);
    });
    child.on("close", (code, signal) => {
      if (signal !== null) {
        onWarn(`lsof 가 ${signal} 로 종료되었습니다 (타임아웃 ${timeoutMs}ms)`);
        resolve(null);
        return;
      }
      const text = Buffer.concat(out).toString("utf8");
      // lsof 는 일부 항목을 못 읽어도 1 로 끝나면서 나머지를 출력한다. 출력이 있으면 그대로 쓴다.
      if (code !== 0 && text === "") {
        onWarn(`lsof 가 exit ${code} 로 끝났습니다`);
        resolve(null);
        return;
      }
      resolve(text);
    });
  });
}

/**
 * 이 프로세스의 사용자가 TCP 로 LISTEN 중인 포트 목록(PROTOCOL 1절 `GET /net/ports`).
 *
 * `lsof` 는 기본적으로 실행한 사용자의 프로세스만 보여 주므로 다른 사용자의 포트는 들어오지 않는다(root 를 쓰지 않는다).
 * agent-host 자신은 유닉스 소켓에서만 listen 하므로 이 목록에 나오지 않는다. 실패하면 던지지 않고 빈 배열이다.
 */
export async function listListeningPorts(opts: ListListeningPortsOptions = {}): Promise<ListeningPort[]> {
  const output = await runLsof(opts.timeoutMs ?? LSOF_TIMEOUT_MS, opts.onWarn ?? (() => {}));
  if (output === null) return [];
  const exclude = new Set(opts.exclude ?? []);
  return parseLsofListen(output).filter((p) => !exclude.has(p.port));
}
