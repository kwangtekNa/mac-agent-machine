import { AgentUnavailableError } from "../../errors.js";
import type { AccountLoginCompletedNotification } from "../../agents/codex/generated/v2/AccountLoginCompletedNotification.js";
import type { CancelLoginAccountParams } from "../../agents/codex/generated/v2/CancelLoginAccountParams.js";
import type { LoginAccountParams } from "../../agents/codex/generated/v2/LoginAccountParams.js";
import type { LoginAccountResponse } from "../../agents/codex/generated/v2/LoginAccountResponse.js";
import { initializeAppServer, spawnCodexAppServer } from "../../agents/codex/process.js";
import { resolveBinary } from "../../agents/resolve-bin.js";
import type { LoginFlow } from "./flows.js";

type Logger = Pick<Console, "info" | "warn" | "error">;

export interface CodexLoginOptions {
  id: string;
  home: string;
  env?: NodeJS.ProcessEnv;
  /** 기본 `MAM_CODEX_BIN` → `resolveBinary('codex')`. */
  binPath?: string;
  spawnFn?: typeof spawnCodexAppServer;
  logger?: Logger;
  /** 기본 10분. */
  timeoutMs?: number;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** 임시 app-server 로 `account/login/start { type: 'chatgptDeviceCode' }` 를 요청하고 `account/login/completed` 로 완료를 확인한다(ADR-008). */
export async function startCodexLogin(opts: CodexLoginOptions): Promise<LoginFlow> {
  const logger = opts.logger ?? console;
  const env = opts.env ?? process.env;
  const binPath = opts.binPath ?? (await resolveBinary("codex", env.MAM_CODEX_BIN));
  if (!binPath) throw new AgentUnavailableError("codex 실행파일을 찾을 수 없습니다");
  const spawnFn = opts.spawnFn ?? spawnCodexAppServer;
  const proc = spawnFn({ binPath, cwd: opts.home, env, logger });

  let started: Extract<LoginAccountResponse, { type: "chatgptDeviceCode" }>;
  try {
    await initializeAppServer(proc.peer);
    const params: LoginAccountParams = { type: "chatgptDeviceCode" };
    const res = await proc.peer.request<LoginAccountResponse>("account/login/start", params);
    if (res.type !== "chatgptDeviceCode") throw new Error(`예상하지 못한 응답 type=${res.type}`);
    started = res;
  } catch (err) {
    proc.peer.close();
    await proc.kill(false);
    throw new AgentUnavailableError(`codex 로그인 시작 실패: ${errorMessage(err)}`);
  }
  const { loginId, verificationUrl, userCode } = started;

  let timer: NodeJS.Timeout | undefined;
  const flow: LoginFlow = {
    id: opts.id,
    agent: "codex",
    url: verificationUrl,
    instructions: `링크를 열고 코드 ${userCode} 를 입력하세요`,
    needsCode: false,
    status: "pending",
    createdAt: Date.now(),
    cancel: () => void cancel("취소되었습니다"),
  };

  const shutdown = (): void => {
    if (timer) clearTimeout(timer);
    unsubscribe();
    unsubscribeClose();
    proc.peer.close();
    proc.kill().catch(() => {});
  };
  const finish = (status: "done" | "error", message: string): void => {
    if (flow.status !== "pending") return;
    flow.status = status;
    flow.message = message;
    shutdown();
  };
  const cancel = async (message: string): Promise<void> => {
    if (flow.status !== "pending") return;
    const params: CancelLoginAccountParams = { loginId };
    try {
      await proc.peer.request("account/login/cancel", params, 5_000);
    } catch (err) {
      logger.warn(`[codex-login] cancel 실패: ${errorMessage(err)}`);
    }
    finish("error", message);
  };

  const unsubscribe = proc.peer.onNotification((method, params) => {
    if (method !== "account/login/completed") return;
    const n = params as AccountLoginCompletedNotification;
    if (n.loginId !== null && n.loginId !== loginId) return;
    if (n.success) {
      logger.info("[codex-login] 로그인 완료");
      finish("done", "로그인 완료");
    } else finish("error", `로그인 실패: ${n.error ?? "unknown"}`);
  });
  const unsubscribeClose = proc.peer.onClose(() => finish("error", "codex app-server 가 종료되었습니다"));
  timer = setTimeout(() => void cancel("시간 초과: 10분 안에 인증이 끝나지 않았습니다"), opts.timeoutMs ?? 10 * 60 * 1000);
  return flow;
}
