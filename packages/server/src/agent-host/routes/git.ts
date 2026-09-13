import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { GitDiffResponseSchema, GitInitRequestSchema, GitInitResponseSchema, GitStatusResponseSchema, type GitInitRequest } from "@mam/protocol";
import { InvalidRequestError } from "../../errors.js";
import { SandboxError, resolveInsideHome, statResolved } from "../../fs/sandbox.js";
import { gitDiff } from "../../git/diff.js";
import { initRepository } from "../../git/init.js";
import { gitStatus } from "../../git/status.js";
import { send, validate, type AgentHostRuntime } from "../http.js";

const StatusQuerySchema = z.object({ cwd: z.string().min(1) });
const DiffQuerySchema = StatusQuerySchema.extend({
  path: z.string().min(1).optional(),
  staged: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => v === "true" || v === "1"),
});
type StatusQuery = z.infer<typeof StatusQuerySchema>;
type DiffQuery = z.infer<typeof DiffQuerySchema>;

async function resolveCwd(home: string, cwd: string): Promise<string> {
  const resolved = await resolveInsideHome(home, cwd);
  if (!(await statResolved(resolved)).isDirectory()) throw new InvalidRequestError("cwd 는 디렉토리여야 합니다");
  return resolved;
}

export function registerGitRoutes(app: FastifyInstance, host: AgentHostRuntime): void {
  app.get("/git/status", { preHandler: validate({ query: StatusQuerySchema }) }, async (request, reply) => {
    const { cwd } = request.query as StatusQuery;
    return send(host, reply, GitStatusResponseSchema, await gitStatus(await resolveCwd(host.home, cwd)));
  });

  app.get("/git/diff", { preHandler: validate({ query: DiffQuerySchema }) }, async (request, reply) => {
    const { cwd, path, staged } = request.query as DiffQuery;
    const resolved = await resolveCwd(host.home, cwd);
    // 절대/`~/` 경로는 샌드박스를 거쳐 홈 안임을 확인한다. 상대경로는 git 이 cwd 기준으로 해석한다.
    const target = path !== undefined && (path.startsWith("/") || path.startsWith("~")) ? await resolveInsideHome(host.home, path) : path;
    return send(host, reply, GitDiffResponseSchema, await gitDiff(resolved, { path: target, staged }));
  });

  // 2026-09-13 추가. cwd 는 resolveCwd(홈 안 + 디렉토리)를 거친 realpath 만 넘긴다(CRITICAL 3). 없는 경로는 404 가 아니라 400.
  app.post("/git/init", { preHandler: validate({ body: GitInitRequestSchema }) }, async (request, reply) => {
    const { cwd, dryRun } = request.body as GitInitRequest;
    let resolved: string;
    try {
      resolved = await resolveCwd(host.home, cwd);
    } catch (err) {
      if (err instanceof SandboxError && err.code === "not_found") throw new InvalidRequestError("cwd 가 존재하지 않습니다");
      throw err;
    }
    const result = await initRepository(resolved, { dryRun: dryRun === true });
    return send(host, reply, GitInitResponseSchema, result, dryRun === true ? 200 : 201);
  });
}
