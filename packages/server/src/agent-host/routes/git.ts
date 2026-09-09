import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { GitDiffResponseSchema, GitStatusResponseSchema } from "@mam/protocol";
import { InvalidRequestError } from "../../errors.js";
import { resolveInsideHome, statResolved } from "../../fs/sandbox.js";
import { gitDiff } from "../../git/diff.js";
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
}
