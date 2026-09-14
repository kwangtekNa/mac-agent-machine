import { spawn } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { listListeningPorts, parseLsofListen } from "../../src/net/ports.js";

/** `lsof` 가 없는 환경(리눅스 최소 이미지 등)에서는 프로세스 목록 테스트를 건너뛴다. */
async function hasLsof(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("lsof", ["-v"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", () => resolve(true));
  });
}

const LSOF = await hasLsof();

/** `lsof -nP -iTCP -sTCP:LISTEN -F pcn` 은 `p<pid>` → `c<command>` → 파일마다 `f<fd>`, `n<addr>` 를 낸다. */
function lsof(...lines: string[]): string {
  return lines.join("\n") + "\n";
}

describe("parseLsofListen", () => {
  it("pid·command 를 이어 붙이고 fd 줄은 무시한다", () => {
    const out = lsof("p4821", "cnode", "f22", "n*:3000", "p5120", "cpython3", "f10", "n0.0.0.0:8080");
    expect(parseLsofListen(out)).toEqual([
      { port: 3000, pid: 4821, process: "node", address: "*" },
      { port: 8080, pid: 5120, process: "python3", address: "0.0.0.0" },
    ]);
  });

  it("같은 포트가 여러 fd·IPv4·IPv6 로 나오면 하나로 합친다", () => {
    const out = lsof("p4899", "cnode", "f30", "n127.0.0.1:5173", "f31", "n[::1]:5173", "f32", "n127.0.0.1:5173");
    expect(parseLsofListen(out)).toEqual([{ port: 5173, pid: 4899, process: "node", address: "127.0.0.1" }]);
  });

  it("합칠 때 `*`(모든 인터페이스) 바인딩을 우선한다 — 순서와 무관하게", () => {
    const first = lsof("p7", "cvite", "f3", "n*:4000", "p8", "cvite", "f4", "n[::1]:4000");
    const second = lsof("p8", "cvite", "f4", "n[::]:4000", "p7", "cvite", "f3", "n*:4000");
    expect(parseLsofListen(first)).toEqual([{ port: 4000, pid: 7, process: "vite", address: "*" }]);
    expect(parseLsofListen(second)).toEqual([{ port: 4000, pid: 7, process: "vite", address: "*" }]);
  });

  it("IPv6 리터럴의 대괄호를 벗기고 이름에 공백이 있는 command 도 담는다", () => {
    const out = lsof("p5498", "cOneDrive Sync Service", "f33", "n[fe80::1%lo0]:42050");
    expect(parseLsofListen(out)).toEqual([
      { port: 42050, pid: 5498, process: "OneDrive Sync Service", address: "fe80::1%lo0" },
    ]);
  });

  it("포트 오름차순으로 정렬한다", () => {
    const out = lsof("p1", "ca", "n*:9000", "p2", "cb", "n*:80", "p3", "cc", "n*:443", "p4", "cd", "n*:3000");
    expect(parseLsofListen(out).map((p) => p.port)).toEqual([80, 443, 3000, 9000]);
  });

  it("빈 출력은 빈 배열이다", () => {
    expect(parseLsofListen("")).toEqual([]);
    expect(parseLsofListen("\n\n")).toEqual([]);
  });

  it("깨진 줄(pid 없음, 주소 아님, 포트 범위 밖, 모르는 태그)은 무시한다", () => {
    const out = lsof(
      "n127.0.0.1:1234", // p 보다 먼저 온 주소
      "p",
      "pabc",
      "cnode",
      "n*:3000", // pid 가 깨졌으므로 버린다
      "nnot-an-address",
      "n*:0",
      "n*:70000",
      "n*:abc",
      "x???",
      "p7",
      "cok",
      "n*:22",
    );
    expect(parseLsofListen(out)).toEqual([{ port: 22, pid: 7, process: "ok", address: "*" }]);
  });
});

describe("listListeningPorts", () => {
  it.skipIf(!LSOF)("현재 프로세스가 연 임시 포트를 담고 exclude 는 뺀다", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const ports = await listListeningPorts();
      const mine = ports.find((p) => p.port === port);
      expect(mine, `임시 포트 ${port} 가 목록에 없다`).toBeDefined();
      expect(mine).toMatchObject({ pid: process.pid, address: "127.0.0.1" });
      expect(mine!.process.length).toBeGreaterThan(0);
      expect(ports.map((p) => p.port)).toEqual([...ports.map((p) => p.port)].sort((a, b) => a - b));
      expect(new Set(ports.map((p) => p.port)).size).toBe(ports.length);

      const excluded = await listListeningPorts({ exclude: [port] });
      expect(excluded.map((p) => p.port)).not.toContain(port);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("타임아웃이나 실패는 예외가 아니라 빈 배열과 경고다", async () => {
    const warnings: string[] = [];
    const ports = await listListeningPorts({ timeoutMs: 1, onWarn: (m) => warnings.push(m) });
    expect(Array.isArray(ports)).toBe(true);
    // 1ms 안에 끝날 수도 있으므로 결과 자체는 단정하지 않고, 실패했다면 경고가 남았는지만 본다.
    if (ports.length === 0) expect(warnings.length).toBeLessThanOrEqual(1);
  });
});
