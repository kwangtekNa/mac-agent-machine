import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { FsListResponseSchema, FsMkdirRequestSchema, FsMkdirResponseSchema, FsReadResponseSchema, type FsMkdirRequest } from "@mam/protocol";
import { listDirectory } from "../../fs/list.js";
import { makeDirectory } from "../../fs/mkdir.js";
import { readFileForClient } from "../../fs/read.js";
import { resolveInsideHome } from "../../fs/sandbox.js";
import { findRepoRoot, gitStatusMap } from "../../git/status.js";
import { send, validate, type AgentHostRuntime } from "../http.js";

const PathQuerySchema = z.object({ path: z.string().min(1) });
type PathQuery = z.infer<typeof PathQuerySchema>;

export function registerFsRoutes(app: FastifyInstance, host: AgentHostRuntime): void {
  app.get("/fs/list", { preHandler: validate({ query: PathQuerySchema }) }, async (request, reply) => {
    const { path } = request.query as PathQuery;
    const resolved = await resolveInsideHome(host.home, path);
    const repoRoot = await findRepoRoot(resolved);
    const gitStatus = repoRoot ? await gitStatusMap(resolved) : undefined;
    return send(host, reply, FsListResponseSchema, await listDirectory(host.home, path, { gitStatus }));
  });

  app.get("/fs/read", { preHandler: validate({ query: PathQuerySchema }) }, async (request, reply) => {
    const { path } = request.query as PathQuery;
    return send(host, reply, FsReadResponseSchema, await readFileForClient(host.home, path));
  });

  // CRITICAL 3: makeDirectory 가 조상과 결과를 resolveInsideHome 으로 확인한다.
  app.post("/fs/mkdir", { preHandler: validate({ body: FsMkdirRequestSchema }) }, async (request, reply) => {
    const { path } = request.body as FsMkdirRequest;
    return send(host, reply, FsMkdirResponseSchema, { entry: await makeDirectory(host.home, path) }, 201);
  });
}
