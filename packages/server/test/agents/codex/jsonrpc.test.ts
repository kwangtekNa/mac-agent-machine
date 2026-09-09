import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { JsonRpcError, JsonRpcPeer } from "../../../src/agents/codex/jsonrpc.js";

interface Msg { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } }

function setup(opts: { requestTimeoutMs?: number } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const lines: Msg[] = [];
  let buf = "";
  output.on("data", (c: Buffer) => {
    buf += c.toString();
    let i = buf.indexOf("\n");
    while (i >= 0) {
      lines.push(JSON.parse(buf.slice(0, i)) as Msg);
      buf = buf.slice(i + 1);
      i = buf.indexOf("\n");
    }
  });
  const peer = new JsonRpcPeer(input, output, { logger, ...opts });
  const tick = () => new Promise((r) => setTimeout(r, 5));
  return { input, output, peer, lines, logger, tick };
}

describe("JsonRpcPeer", () => {
  it("request 는 {id,method,params} 한 줄을 쓰고 응답 result 로 resolve 한다", async () => {
    const { input, peer, lines, tick } = setup();
    const p = peer.request<{ ok: boolean }>("initialize", { a: 1 });
    await tick();
    expect(lines[0]).toEqual({ id: 1, method: "initialize", params: { a: 1 } });
    input.write(JSON.stringify({ id: 1, result: { ok: true } }) + "\n");
    await expect(p).resolves.toEqual({ ok: true });
  });

  it("응답 error 는 JsonRpcError 로 reject 한다", async () => {
    const { input, peer, tick } = setup();
    const p = peer.request("x");
    await tick();
    input.write(JSON.stringify({ id: 1, error: { code: -32601, message: "no such method" } }) + "\n");
    await expect(p).rejects.toBeInstanceOf(JsonRpcError);
    await expect(p).rejects.toThrow(/no such method/);
  });

  it("notify 는 id 없이 쓰고, 알림은 onNotification 으로 전달된다", async () => {
    const { input, peer, lines, tick } = setup();
    peer.notify("initialized");
    await tick();
    expect(lines[0]).toEqual({ method: "initialized" });
    const got: Array<[string, unknown]> = [];
    const off = peer.onNotification((m, p) => got.push([m, p]));
    input.write(JSON.stringify({ method: "turn/started", params: { t: 1 }, emittedAtMs: 5 }) + "\n");
    await tick();
    expect(got).toEqual([["turn/started", { t: 1 }]]);
    off();
    input.write(JSON.stringify({ method: "turn/started", params: { t: 2 } }) + "\n");
    await tick();
    expect(got).toHaveLength(1);
  });

  it("서버 요청은 onRequest 반환값을 {id,result} 로, throw 는 {id,error:{code:-32000}} 로 회신한다", async () => {
    const { input, peer, lines, tick } = setup();
    peer.onRequest(async (method, params) => {
      if (method === "boom") throw new Error("nope");
      return { echo: params };
    });
    input.write(JSON.stringify({ id: "s1", method: "ask", params: { q: 1 } }) + "\n");
    input.write(JSON.stringify({ id: "s2", method: "boom", params: {} }) + "\n");
    await tick();
    expect(lines).toContainEqual({ id: "s1", result: { echo: { q: 1 } } });
    expect(lines).toContainEqual({ id: "s2", error: { code: -32000, message: "nope" } });
  });

  it("타임아웃이면 reject 한다", async () => {
    const { peer } = setup({ requestTimeoutMs: 20 });
    await expect(peer.request("slow")).rejects.toThrow(/타임아웃/);
  });

  it("부분 청크를 버퍼링하고 잘못된 JSON 줄은 경고 후 무시한다", async () => {
    const { input, peer, logger, tick } = setup();
    const p = peer.request("x");
    await tick();
    input.write("this is not json\n");
    input.write('{"id":1,"res');
    await tick();
    input.write('ult":5}\n');
    await expect(p).resolves.toBe(5);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("close 는 대기 중 요청을 전부 reject 한다", async () => {
    const { peer } = setup();
    const a = peer.request("a");
    const b = peer.request("b");
    peer.close();
    await expect(a).rejects.toBeInstanceOf(JsonRpcError);
    await expect(b).rejects.toBeInstanceOf(JsonRpcError);
    await expect(peer.request("c")).rejects.toBeInstanceOf(JsonRpcError);
  });
});
