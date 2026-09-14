import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { FsListResponseSchema, FsMkdirRequestSchema, FsMkdirResponseSchema, FsReadResponseSchema, FsRenderResponseSchema, type FsMkdirRequest } from "@mam/protocol";
import { AgentUnavailableError } from "../../errors.js";
import { openDownload } from "../../fs/download.js";
import { listDirectory } from "../../fs/list.js";
import { makeDirectory } from "../../fs/mkdir.js";
import { readFileForClient } from "../../fs/read.js";
import { renderDocument } from "../../fs/render.js";
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

  // 원본 바이트 스트리밍(PDF·Office 문서를 폰이 QuickLook 으로 연다). 응답은 JSON 이 아니다.
  app.get("/fs/download", { preHandler: validate({ query: PathQuerySchema }) }, async (request, reply) => {
    const { path } = request.query as PathQuery;
    const { stream, size, contentType, disposition } = await openDownload(host.home, path);
    return reply
      .header("content-type", contentType)
      .header("content-length", String(size))
      .header("content-disposition", disposition)
      .header("cache-control", "no-store")
      .status(200)
      .send(stream);
  });

  // 한글(HWP/HWPX)은 iOS 가 못 열어 서버가 자체 완결 HTML 로 바꿔 준다.
  app.get("/fs/render", { preHandler: validate({ query: PathQuerySchema }) }, async (request, reply) => {
    const { path } = request.query as PathQuery;
    try {
      const rendered = await renderDocument(host.home, path, { logger: { warn: (m) => request.log.warn(m) } });
      return send(host, reply, FsRenderResponseSchema, rendered);
    } catch (err) {
      // 로그인 미지원 501 과 같은 규칙: 변환기가 설치돼 있지 않다는 뜻이다.
      if (err instanceof AgentUnavailableError) {
        return reply.code(501).send({ error: { code: "agent_unavailable", message: err.message } });
      }
      throw err;
    }
  });

  // CRITICAL 3: makeDirectory 가 조상과 결과를 resolveInsideHome 으로 확인한다.
  app.post("/fs/mkdir", { preHandler: validate({ body: FsMkdirRequestSchema }) }, async (request, reply) => {
    const { path } = request.body as FsMkdirRequest;
    return send(host, reply, FsMkdirResponseSchema, { entry: await makeDirectory(host.home, path) }, 201);
  });
}
