import type { UsageProvider } from "../types.ts";
import { createOpenAIProvider } from "./openai.ts";
import { createClaudeProvider } from "./claude.ts";

// Add an adapter here; commands, collection, and rendering remain provider-neutral.
export function createUsageProviders(): UsageProvider[] {
  return [createOpenAIProvider(), createClaudeProvider()];
}
