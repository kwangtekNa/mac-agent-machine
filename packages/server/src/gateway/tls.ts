import { readFile } from "node:fs/promises";
import { isIPv4 } from "node:net";
import type { Config } from "../config.js";
import { findTailscaleBin, runCommand, type ExecFn } from "./identity.js";

export async function loadTls(tls: Config["tls"]): Promise<{ cert: Buffer; key: Buffer }> {
  if (!tls) throw new Error("TLS 설정이 없습니다. config.tls.cert / config.tls.key 를 지정하세요 (tailscale cert 산출물)");
  const read = async (label: string, path: string): Promise<Buffer> => {
    try {
      return await readFile(path);
    } catch (err) {
      throw new Error(`TLS ${label} 파일을 읽을 수 없습니다: ${path} (${(err as Error).message})`);
    }
  };
  return { cert: await read("cert", tls.cert), key: await read("key", tls.key) };
}

export const TAILSCALE_IP_HINT = "tailnet IPv4 주소를 얻지 못했습니다. tailscale이 실행 중인지 확인하세요 (tailscale ip -4)";

/** `tailscale ip -4` 첫 줄. 못 얻으면 명확한 메시지로 실패한다. */
export async function tailscaleIPv4(exec: ExecFn = runCommand, tailscaleBin?: string): Promise<string> {
  const bin = tailscaleBin ?? findTailscaleBin() ?? "tailscale";
  let result: { stdout: string; code: number };
  try {
    result = await exec(bin, ["ip", "-4"]);
  } catch (err) {
    throw new Error(`${TAILSCALE_IP_HINT}: ${(err as Error).message}`);
  }
  const first = result.stdout.split("\n")[0]?.trim() ?? "";
  if (result.code !== 0 || !isIPv4(first)) throw new Error(TAILSCALE_IP_HINT);
  return first;
}
