import { homedir } from "node:os";
import { resolve } from "node:path";

export interface MemoryConfig {
  enabled: boolean;
  mode: "inject" | "agent" | "both";
  dir: string;
  capture: { enabled: boolean; model?: string; onCompact: boolean };
  retrieval: { model?: string; maxItems: number; budgetTokens: number; timeoutMs: number; strategy: "baseline" | "improved" };
  digest: { budgetTokens: number };
  scope: { projectLocation: "home" | "repo" };
  consolidation: { everyCaptures: number };
}

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Memory settings must be objects");
  return value as ObjectValue;
}
function number(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(`Memory setting must be an integer between ${min} and ${max}`);
  return value;
}
function bool(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error("Memory setting must be boolean");
  return value;
}
function model(value: unknown): string | undefined {
  if (value === undefined || value === "off") return undefined;
  if (typeof value !== "string" || !/^[^/\s]+\/[^\s]+$/.test(value)) throw new Error("Memory models use provider/modelId, or off");
  return value;
}

export function readConfig(settings: unknown, agentDir: string, flags: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = process.env): MemoryConfig {
  const root = object(settings), m = object(root.memory), capture = object(m.capture), retrieval = object(m.retrieval);
  const digest = object(m.digest), scope = object(m.scope), consolidation = object(m.consolidation);
  const mode = flags["memory-mode"] ?? env.PI_MEMORY_MODE ?? m.mode ?? "inject";
  if (mode !== "inject" && mode !== "agent" && mode !== "both") throw new Error("memory.mode must be inject, agent, or both");
  const dir = flags["memory-dir"] ?? env.PI_MEMORY_DIR ?? m.dir ?? `${agentDir}/memory`;
  if (typeof dir !== "string" || !dir.trim()) throw new Error("memory.dir must be a nonempty path");
  const location = scope.projectLocation ?? "home";
  if (location !== "home" && location !== "repo") throw new Error("memory.scope.projectLocation must be home or repo");
  const strategy = env.PI_MEMORY_STRATEGY ?? "improved";
  if (!["baseline", "improved", "ranked"].includes(strategy)) throw new Error("Unknown PI_MEMORY_STRATEGY");
  return {
    enabled: flags["no-memory"] !== true && !/^(1|true|yes)$/i.test(env.PI_MEMORY_DISABLED ?? "") && bool(m.enabled, true),
    mode, dir: resolve(dir.replace(/^~(?=\/|$)/, homedir())),
    capture: { enabled: env.PI_MEMORY_CAPTURE !== "0" && capture.model !== "off" && bool(capture.enabled, true), model: model(flags["memory-model"] ?? env.PI_MEMORY_MODEL ?? capture.model), onCompact: bool(capture.onCompact, true) },
    retrieval: { model: model(env.PI_MEMORY_RETRIEVAL_MODEL ?? retrieval.model), maxItems: number(retrieval.maxItems, 8, 1, 32), budgetTokens: number(env.PI_MEMORY_TOKEN_BUDGET === undefined ? retrieval.budgetTokens : Number(env.PI_MEMORY_TOKEN_BUDGET), 1200, 128, 8000), timeoutMs: number(retrieval.timeoutMs, 2500, 100, 30000), strategy: strategy === "baseline" ? "baseline" : "improved" },
    digest: { budgetTokens: number(digest.budgetTokens, 1200, 0, 8000) },
    scope: { projectLocation: location },
    consolidation: { everyCaptures: number(consolidation.everyCaptures, 20, 1, 10000) },
  };
}
