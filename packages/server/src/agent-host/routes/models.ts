import type { FastifyInstance } from "fastify";
import { ModelsQuerySchema, ModelsResponseSchema, type ModelOption, type ModelsQuery } from "@mam/protocol";
import type { AgentAdapter, AgentModel } from "../../agents/types.js";
import { AgentUnavailableError } from "../../errors.js";
import { send, validate, type AgentHostRuntime } from "../http.js";

export const MODELS_CACHE_MS = 5 * 60_000;

const cache = new WeakMap<AgentAdapter, { at: number; models: AgentModel[] }>();

/** 5분 캐시된 `listModels()`. 실패는 캐시하지 않는다. */
export async function listModelsCached(adapter: AgentAdapter, now = Date.now()): Promise<AgentModel[]> {
  const hit = cache.get(adapter);
  if (hit && now - hit.at < MODELS_CACHE_MS) return hit.models;
  const models = await adapter.listModels();
  cache.set(adapter, { at: now, models });
  return models;
}

function toModelOption(m: AgentModel): ModelOption {
  return { id: m.id, displayName: m.displayName, description: m.description, isDefault: m.isDefault, efforts: [...m.efforts], defaultEffort: m.defaultEffort };
}

export function registerModelsRoutes(app: FastifyInstance, host: AgentHostRuntime): void {
  app.get("/models", { preHandler: validate({ query: ModelsQuerySchema }) }, async (request, reply) => {
    const { agent } = request.query as ModelsQuery;
    const adapter = host.adapters[agent];
    if (!adapter) throw new AgentUnavailableError(`${agent} 어댑터를 사용할 수 없습니다`);
    let models: AgentModel[];
    try {
      models = await listModelsCached(adapter);
    } catch (err) {
      throw new AgentUnavailableError(`모델 목록 조회 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
    return send(host, reply, ModelsResponseSchema, { models: models.map(toModelOption) });
  });
}
