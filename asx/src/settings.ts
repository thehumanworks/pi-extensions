import { availableParallelism } from "node:os";
import { WorkflowError } from "./errors.ts";

function number(env: NodeJS.ProcessEnv, key: string, fallback: number, minimum: number, integer = true): number {
  const raw = env[key];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < minimum || (integer && !Number.isInteger(value))) throw new WorkflowError("invalid_setting", `${key} must be ${integer ? "an integer" : "a number"} >= ${minimum}.`);
  return value;
}
export function workerSettings(env: NodeJS.ProcessEnv = process.env) {
  return {
    maxConcurrentAgents: number(env, "ASX_MAX_CONCURRENT_AGENTS", Math.min(availableParallelism(), 8), 1),
    maxDepth: number(env, "ASX_MAX_DEPTH", 1, 0),
    retryBackoffMs: number(env, "ASX_RETRY_BACKOFF_MS", 1000, 0),
    structuredRetries: number(env, "ASX_STRUCTURED_RETRIES", 1, 0),
    defaultRetries: number(env, "ASX_AGENT_RETRIES", 0, 0),
    defaultTimeoutMs: number(env, "ASX_AGENT_TIMEOUT_MS", 600_000, 1),
  };
}
