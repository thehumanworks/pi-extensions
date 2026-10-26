import type { Api, Model } from "@earendil-works/pi-ai";

interface Registry {
  getAll(): Model<Api>[];
  getAvailable(): Model<Api>[];
  find(provider: string, id: string): Model<Api> | undefined;
}

export const modelRef = (model: Model<Api>) => `${model.provider}/${model.id}`;

/**
 * Resolve `provider/id`, an exact id, or a unique partial id/name. Exact and partial id matches
 * prefer models with configured credentials, as `pi --model` does.
 */
export function resolveModel(registry: Registry, spec: string): Model<Api> | undefined {
  const text = spec.trim();
  if (!text) return undefined;
  const slash = text.indexOf("/");
  if (slash > 0) {
    const exact = registry.find(text.slice(0, slash), text.slice(slash + 1));
    if (exact) return exact;
  }
  const available = registry.getAvailable(), all = registry.getAll();
  const lower = text.toLowerCase();
  for (const pool of [available, all]) {
    const exact = pool.filter(m => m.id.toLowerCase() === lower || modelRef(m).toLowerCase() === lower);
    if (exact.length) return exact[0];
  }
  for (const pool of [available, all]) {
    const partial = pool.filter(m => m.id.toLowerCase().includes(lower) || m.name?.toLowerCase().includes(lower));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) return undefined;
  }
  return undefined;
}
