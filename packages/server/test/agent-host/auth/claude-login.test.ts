import { EventEmitter } from "node:events";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startClaudeLogin, type PtyLike, type PtySpawn } from "../../../src/agent-host/auth/claude-login.js";
import { tokenPath } from "../../../src/agents/claude/credentials.js";
import { makeTmpHome, removeTmp } from "../../helpers/tmp-home.js";

const URL = "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&state=abc";
/** 관찰한 실제 출력 형태: Ink 는 단어 사이를 `ESC[nG` 커서 이동으로 채운다. */
const BANNER = "\x1b[38;2;215;119;87mWelcome\x1b[9Gto\x1b[12GClaude\x1b[19GCode\x1b[39m\r\r\n";
const PROMPT = `Browser didn't open? Use the url below to sign in (c to copy)\r\r\n\r\r\n${URL}\r\r\n\r\r\nPaste\x1b[7Gcode\x1b[12Ghere\x1b[17Gif\x1b[20Gprompted\x1b[29G>\r\r\n`;
const TOKEN = "sk-ant-oat01-" + "A".repeat(80);

class FakePty extends EventEmitter implements PtyLike {
  readonly written: string[] = [];
  readonly kill = vi.fn();
  onData(cb: (data: string) => void) {
    this.on("data", cb);
    return { dispose: () => this.off("data", cb) };
  }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void) {
    this.on("exit", cb);
    return { dispose: () => this.off("exit", cb) };
  }
  write(data: string) {
    this.written.push(data);
  }
  emitData(s: string) {
    this.emit("data", s);
  }
}

function makeSpawn(ptyInst: FakePty) {
  const calls: Array<{ file: string; args: string[]; opts: Parameters<PtySpawn>[2] }> = [];
  const ptySpawn: PtySpawn = (file, args, opts) => {
    calls.push({ file, args, opts });
    return ptyInst;
  };
  return { ptySpawn, calls };
}

const tmps: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const t of tmps.splice(0)) await removeTmp(t);
});

describe("startClaudeLogin", () => {
  it("URL 검출 → 코드 제출 → 토큰 0600 저장 → done, 토큰은 로그에 없다", async () => {
    const home = await makeTmpHome("mam-login-");
    tmps.push(home);
    const fake = new FakePty();
    const { ptySpawn, calls } = makeSpawn(fake);
    const logs: string[] = [];
    const logger = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) };
    const env = { PATH: "/usr/bin", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli" };
    const p = startClaudeLogin({ id: "flw_01J8ZQ4K5N7P9R3S6T8V0W2XF1", home, binPath: "/opt/claude", env, ptySpawn, logger });
    await new Promise((r) => setImmediate(r));
    fake.emitData(BANNER);
    fake.emitData(PROMPT.slice(0, 80));
    fake.emitData(PROMPT.slice(80));
    const flow = await p;
    expect(calls[0]?.file).toBe("/opt/claude");
    expect(calls[0]?.args).toEqual(["setup-token"]);
    expect(calls[0]?.opts.env).not.toHaveProperty("CLAUDECODE");
    expect(calls[0]?.opts.env).not.toHaveProperty("CLAUDE_CODE_ENTRYPOINT");
    expect(flow.url).toBe(URL);
    expect(flow.needsCode).toBe(true);
    expect(flow.status).toBe("pending");
    expect(flow.instructions).toContain("코드");

    await flow.submitCode!("  abc123#xyz \n");
    expect(fake.written).toEqual(["abc123#xyz\r"]);
    fake.emitData(`\r\r\nLong-lived\x1b[12Gtoken:\x1b[20G${TOKEN}\r\r\n`);
    await vi.waitFor(() => expect(flow.status).toBe("done"));
    const saved = await readFile(tokenPath(home), "utf8");
    expect(saved).toBe(TOKEN);
    expect((await stat(tokenPath(home))).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, ".mam", "secrets"))).mode & 0o777).toBe(0o700);
    expect(fake.kill).toHaveBeenCalled();
    expect(logs.join("\n")).not.toContain("sk-ant-oat01");
    expect(logs.join("\n")).not.toContain("abc123");
  });

  it("코드 제출 후 오류 문구가 보이면 error", async () => {
    const home = await makeTmpHome("mam-login-");
    tmps.push(home);
    const fake = new FakePty();
    const { ptySpawn } = makeSpawn(fake);
    const p = startClaudeLogin({ id: "flw_01J8ZQ4K5N7P9R3S6T8V0W2XF2", home, binPath: "/opt/claude", ptySpawn, logger: { info() {}, warn() {}, error() {} } });
    await new Promise((r) => setImmediate(r));
    fake.emitData(PROMPT);
    const flow = await p;
    await flow.submitCode!("bad");
    fake.emitData("\r\r\nError:\x1b[8Ginvalid\x1b[16Gauthorization\x1b[30Gcode\r\r\n");
    await vi.waitFor(() => expect(flow.status).toBe("error"));
    expect(flow.message).toMatch(/invalid/i);
    expect(fake.kill).toHaveBeenCalled();
  });

  it("URL 없이 프로세스가 끝나면 시작 실패", async () => {
    const home = await makeTmpHome("mam-login-");
    tmps.push(home);
    const fake = new FakePty();
    const { ptySpawn } = makeSpawn(fake);
    const p = startClaudeLogin({ id: "flw_01J8ZQ4K5N7P9R3S6T8V0W2XF3", home, binPath: "/opt/claude", ptySpawn, logger: { info() {}, warn() {}, error() {} } });
    await new Promise((r) => setImmediate(r));
    fake.emit("exit", { exitCode: 1 });
    await expect(p).rejects.toThrow(/setup-token/);
  });

  it("타임아웃이면 error + kill", async () => {
    vi.useFakeTimers();
    const home = await makeTmpHome("mam-login-");
    tmps.push(home);
    const fake = new FakePty();
    const { ptySpawn } = makeSpawn(fake);
    const p = startClaudeLogin({ id: "flw_01J8ZQ4K5N7P9R3S6T8V0W2XF4", home, binPath: "/opt/claude", ptySpawn, timeoutMs: 1000, logger: { info() {}, warn() {}, error() {} } });
    await vi.advanceTimersByTimeAsync(1);
    fake.emitData(PROMPT);
    const flow = await p;
    expect(flow.status).toBe("pending");
    await vi.advanceTimersByTimeAsync(1001);
    expect(flow.status).toBe("error");
    expect(flow.message).toMatch(/시간/);
    expect(fake.kill).toHaveBeenCalled();
  });
});
