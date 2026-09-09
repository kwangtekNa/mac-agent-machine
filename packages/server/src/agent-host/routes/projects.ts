import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { ProjectsResponseSchema, type Project } from "@mam/protocol";
import { findRepoRoot } from "../../git/status.js";
import { send, type AgentHostRuntime } from "../http.js";

async function workspaceDirs(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => join(root, e.name));
  } catch {
    return [];
  }
}

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    return (await findRepoRoot(dir)) !== null;
  } catch {
    return false;
  }
}

export function registerProjectsRoutes(app: FastifyInstance, host: AgentHostRuntime): void {
  app.get("/projects", async (_request, reply) => {
    const byPath = new Map<string, { lastSessionAt: string | null; sessionCount: number }>();
    for (const dir of await workspaceDirs(host.workspaceRoot)) byPath.set(dir, { lastSessionAt: null, sessionCount: 0 });
    for (const session of host.manager.list()) {
      const entry = byPath.get(session.cwd) ?? { lastSessionAt: null, sessionCount: 0 };
      entry.sessionCount += 1;
      if (entry.lastSessionAt === null || session.updatedAt > entry.lastSessionAt) entry.lastSessionAt = session.updatedAt;
      byPath.set(session.cwd, entry);
    }
    const projects: Project[] = await Promise.all(
      [...byPath.entries()].map(async ([path, entry]) => ({
        path,
        name: basename(path),
        isGitRepo: await isGitRepo(path),
        ...entry,
      })),
    );
    projects.sort((a, b) => {
      if (a.lastSessionAt !== b.lastSessionAt) {
        if (a.lastSessionAt === null) return 1;
        if (b.lastSessionAt === null) return -1;
        return a.lastSessionAt < b.lastSessionAt ? 1 : -1;
      }
      return a.name.localeCompare(b.name);
    });
    return send(host, reply, ProjectsResponseSchema, { projects });
  });
}
