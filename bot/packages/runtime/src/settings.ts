import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { BotError } from "./errors.js";
const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export function object(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BotError("INVALID_INPUT", `${label} must be an object.`);
  return value as Record<string, any>;
}
export async function readSettings(agentDir: string): Promise<Record<string, any>> {
  let value: Record<string, any>;
  try {
    if ((await stat(join(agentDir, "settings.json"))).size > 1024 * 1024) throw new BotError("INVALID_INPUT", "Pi settings.json exceeds 1 MiB.");
    value = object(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")), "Pi settings");
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (error instanceof BotError) throw error;
    throw new BotError("INVALID_INPUT", `Invalid Pi settings.json: ${String(error)}`, { cause: error });
  }
  for (const key of ["defaultModel", "defaultProvider"]) if (value[key] !== undefined && (typeof value[key] !== "string" || !value[key].trim())) throw new BotError("INVALID_INPUT", `${key} must be a non-empty string.`);
  if (value.defaultThinkingLevel !== undefined && !levels.has(value.defaultThinkingLevel)) throw new BotError("INVALID_INPUT", "Invalid defaultThinkingLevel.");
  if (value.modelThinkingLevels !== undefined) for (const level of Object.values(object(value.modelThinkingLevels, "modelThinkingLevels"))) if (typeof level !== "string" || !levels.has(level)) throw new BotError("INVALID_INPUT", "Invalid modelThinkingLevels entry.");
  for (const key of ["defaultTools", "extensions", "skills", "prompts", "themes"]) if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].some((entry: unknown) => typeof entry !== "string" || !entry.trim()))) throw new BotError("INVALID_INPUT", `${key} must be an array of non-empty strings.`);
  if (value.packages !== undefined && !Array.isArray(value.packages)) throw new BotError("INVALID_INPUT", "packages must be an array.");
  if (value.retry !== undefined) {
    const retry = object(value.retry, "retry");
    for (const [key, max] of [["maxRetries", 10], ["baseDelayMs", 60000], ["maxAgentDelayMs", 600000]] as const) if (retry[key] !== undefined && (!Number.isSafeInteger(retry[key]) || retry[key] < 0 || retry[key] > max)) throw new BotError("INVALID_INPUT", `retry.${key} is outside supported bounds (0–${max}).`);
    if (retry.enabled !== undefined && typeof retry.enabled !== "boolean") throw new BotError("INVALID_INPUT", "retry.enabled must be boolean.");
  }
  if (value.compaction !== undefined) {
    const check = (raw: unknown) => {
      const config = object(raw, "compaction");
      for (const key of ["reserveTokens", "keepRecentTokens", "backgroundTokens"]) if (config[key] !== undefined && (!Number.isSafeInteger(config[key]) || config[key] < 0)) throw new BotError("INVALID_INPUT", `compaction.${key} must be a non-negative safe integer.`);
      if (config.enabled !== undefined && typeof config.enabled !== "boolean") throw new BotError("INVALID_INPUT", "compaction.enabled must be boolean.");
    };
    check(value.compaction);
    if (value.compaction.modelOverrides !== undefined) for (const config of Object.values(object(value.compaction.modelOverrides, "compaction.modelOverrides"))) check(config);
  }
  return value;
}
