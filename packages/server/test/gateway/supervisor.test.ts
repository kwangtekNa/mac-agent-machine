import { EventEmitter } from "node:events";
import { stat } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { devConfig, type Config } from "../../src/config.js";
import { AgentHostSupervisor, CHILD_PATH, SupervisorBackoffError } from "../../src/gateway/supervisor.js";
import { makeTmpHome, removeTmp } from "../helpers/tmp-home.js";

class FakeChild extends EventEmitter {
  pid = 4242;
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: string[] = [];
  server?: Server;
  exitOnKill = true;
  kill(sig: string): boolean {
    this.signals.push(sig);
    if (this.exitOnKill) this.crash(null, sig);
    return true;
  }
  crash(code: number | null, sig: string | null = null): void {
    this.server?.close();
    this.emit("exit", code, sig);
  }
}

function fakeSpawn(listen: boolean) {
  const calls: Array<{ bin: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const children: FakeChild[] = [];
  const spawnFn = ((bin: string, args: string[], o: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ bin, args, env: o.env ?? {} });
    const child = new FakeChild();
    if (bin === "/usr/bin/id") {
      setImmediate(() => {
        child.stdout.write(`${args[0] === "-u" ? process.getuid!() : process.getgid!()}\n`);
        child.emit("close", 0, null);
      });
      return child;
    }
    children.push(child);
    if (listen) {
      child.server = createServer();
      child.server.listen(args[args.indexOf("--socket") + 1]);
    }
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  return { calls, children, spawnFn };
}

const alice = { macUser: "alice", email: "alice@example.com", workspaceRoot: "~/work" };
let tmp: string;
let config: Config;
beforeEach(async () => {
  tmp = await makeTmpHome("mam-sup-");
  config = devConfig({ users: [alice], paths: { node: "/nodebin", mamCli: "/cli.js" }, agentHost: { idleTimeoutMinutes: 1 } });
});
afterEach(() => removeTmp(tmp));

describe("supervisor", () => {
  it("prod: sudo -u … -H -n -- node cli agent-host …, minimal env, 0700 dir", async () => {
    const f = fakeSpawn(true);
    const sup = new AgentHostSupervisor({ config, dev: false, spawnFn: f.spawnFn, socketRoot: tmp, env: { PATH: "/x", SECRET: "y", MAM_FAKE_AGENT: "1" } });
    const sock = join(tmp, "alice", "agent.sock");
    expect(await sup.ensure(alice)).toEqual({ socketPath: sock });
    expect(f.calls.slice(0, 2).map((c) => [c.bin, ...c.args])).toEqual([["/usr/bin/id", "-u", "alice"], ["/usr/bin/id", "-g", "alice"]]);
    const main = f.calls[2]!;
    expect(main.bin).toBe("/usr/bin/sudo");
    expect(main.args).toEqual(["-u", "alice", "-H", "-n", "--preserve-env=MAM_FAKE_AGENT", "--", "/nodebin", "/cli.js", "agent-host", "--socket", sock, "--workspace", "~/work", "--email", "alice@example.com"]);
    expect(main.env).toEqual({ PATH: CHILD_PATH, MAM_FAKE_AGENT: "1" });
    expect((await stat(join(tmp, "alice"))).mode & 0o777).toBe(0o700);
    await sup.ensure(alice);
    expect(f.children).toHaveLength(1); // 이미 ready 면 재생성 안 함
    expect(sup.status()).toEqual([{ macUser: "alice", pid: 4242, state: "ready", restarts: 0 }]);
    await sup.shutdown();
    expect(f.children[0]!.signals).toEqual(["SIGTERM"]);
  });
  it("prod without MAM_* has no --preserve-env; dev spawns node directly", async () => {
    const f = fakeSpawn(true);
    const sup = new AgentHostSupervisor({ config, dev: false, spawnFn: f.spawnFn, socketRoot: tmp, env: {} });
    await sup.ensure(alice);
    expect(f.calls[2]!.args.slice(0, 5)).toEqual(["-u", "alice", "-H", "-n", "--"]);
    await sup.shutdown();
    const g = fakeSpawn(true);
    const dev = new AgentHostSupervisor({ config, dev: true, spawnFn: g.spawnFn, socketRoot: tmp, env: { HOME: "/h", MAM_X: "1", SECRET: "y" } });
    await dev.ensure(alice);
    expect(g.calls.map((c) => c.bin)).toEqual(["/nodebin"]);
    expect(g.calls[0]!.args.slice(0, 4)).toEqual(["/cli.js", "agent-host", "--socket", join(tmp, "alice", "agent.sock")]);
    expect(g.calls[0]!.env).toEqual({ PATH: CHILD_PATH, MAM_X: "1", HOME: "/h" });
    await dev.shutdown();
  });
  it("ready timeout kills the child and enters backoff", async () => {
    const f = fakeSpawn(false);
    const sup = new AgentHostSupervisor({ config, dev: true, spawnFn: f.spawnFn, socketRoot: tmp, readyTimeoutMs: 250 });
    await expect(sup.ensure(alice)).rejects.toMatchObject({ code: "agent_unavailable" });
    expect(f.children[0]!.signals).toEqual(["SIGKILL"]);
    expect(sup.status()[0]).toMatchObject({ state: "backoff", restarts: 1 });
    await sup.shutdown();
  });
  it("crash → exponential backoff (1s, 2s), next ensure restarts; logs are prefixed", async () => {
    const f = fakeSpawn(true);
    const lines: string[] = [];
    let t = 1_000_000;
    const sup = new AgentHostSupervisor({ config, dev: true, spawnFn: f.spawnFn, socketRoot: tmp, now: () => t, logger: { info: (m: string) => lines.push(m), warn() {}, error() {} } });
    await sup.ensure(alice);
    f.children[0]!.stdout.write("hello\nwor");
    f.children[0]!.stdout.write("ld\n");
    expect(lines).toContain("[agent-host:alice] hello");
    expect(lines).toContain("[agent-host:alice] world");
    f.children[0]!.crash(1);
    await expect(sup.ensure(alice)).rejects.toBeInstanceOf(SupervisorBackoffError);
    t += 1000;
    await sup.ensure(alice);
    expect(f.children).toHaveLength(2);
    f.children[1]!.crash(1);
    t += 1000;
    await expect(sup.ensure(alice)).rejects.toBeInstanceOf(SupervisorBackoffError);
    t += 1000;
    await sup.ensure(alice);
    expect(f.children).toHaveLength(3);
    expect(sup.status()[0]).toMatchObject({ state: "ready", restarts: 2 });
    await sup.shutdown();
  });
  it("idle sweep stops only when timed out and no live connection; shutdown escalates to SIGKILL", async () => {
    const f = fakeSpawn(true);
    let t = 0;
    const sup = new AgentHostSupervisor({ config, dev: true, spawnFn: f.spawnFn, socketRoot: tmp, now: () => t, shutdownTimeoutMs: 30 });
    await sup.ensure(alice);
    const release = sup.trackConnection("alice");
    t += 61_000;
    sup.sweepIdle();
    expect(f.children[0]!.signals).toEqual([]);
    release();
    sup.sweepIdle(); // release 가 활동 시각을 갱신
    expect(f.children[0]!.signals).toEqual([]);
    t += 61_000;
    sup.sweepIdle();
    expect(f.children[0]!.signals).toEqual(["SIGTERM"]);
    expect(sup.status()[0]!.state).toBe("stopped");
    await sup.ensure(alice);
    expect(f.children).toHaveLength(2);
    f.children[1]!.exitOnKill = false;
    await sup.shutdown();
    expect(f.children[1]!.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});
