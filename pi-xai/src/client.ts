import { type ClientOptions, SpaceXAI } from "@xai-official/sdk";
import { getApiKey } from "./secret.ts";
import type { ToolkitContext } from "./module.ts";

export interface ToolkitOptions {
  client?: SpaceXAI;
  apiKey?: string | (() => string | Promise<string>);
  clientOptions?: Omit<ClientOptions, "apiKey">;
  /** Host-specific, non-secret credential guidance for capability discovery. */
  authenticationDescription?: string;
}

/** Key suppliers are checked per call; clients are reused while the key matches. */
export function createClientProvider(
  options: ToolkitOptions = {},
): ToolkitContext {
  let pending: Promise<SpaceXAI> | undefined;
  let cached: { apiKey: string; client: SpaceXAI } | undefined;
  return {
    getClient() {
      if (options.client) return Promise.resolve(options.client);
      if (cached && typeof options.apiKey !== "function") {
        return Promise.resolve(cached.client);
      }
      if (!pending) {
        pending = (async () => {
          const apiKey =
            typeof options.apiKey === "function"
              ? await options.apiKey()
              : (options.apiKey ?? (await getApiKey()));
          if (!cached || cached.apiKey !== apiKey) {
            cached = {
              apiKey,
              client: new SpaceXAI({ ...options.clientOptions, apiKey }),
            };
          }
          return cached.client;
        })().finally(() => {
          pending = undefined;
        });
      }
      return pending;
    },
  };
}
