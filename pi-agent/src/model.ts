import type { Api, Model } from "@earendil-works/pi-ai";
import { resolveCliModel, type ExtensionAPI, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "./agent.ts";

export type ModelChoice = {
  /** The model to switch to, or undefined to keep the session's model. */
  model?: Model<Api>;
  thinkingLevel?: ThinkingLevel;
  warning?: string;
};

type ThinkingLevel = Parameters<ExtensionAPI["setThinkingLevel"]>[0];
type ModelRuntime = Parameters<typeof resolveCliModel>[0]["modelRuntime"];

/**
 * Resolves an agent's `model` and `effort` the way Pi resolves `--model` and `--thinking`:
 * `provider/id`, a bare id, or a fuzzy pattern such as Claude Code's `sonnet` alias, optionally
 * with a `:<thinking>` suffix. `inherit` keeps the session's model. A model that cannot be
 * resolved keeps the session's model with a warning, as Claude Code falls back to the inherited
 * model for a value it cannot use.
 */
export function resolveAgentModel(definition: AgentDefinition, registry: ModelRegistry): ModelChoice {
  const choice: ModelChoice = {};
  const reference = definition.model?.trim();
  if (reference && reference !== "inherit") {
    const result = resolveCliModel({ cliModel: reference, modelRuntime: registryRuntime(registry) });
    if (result.model) {
      choice.model = result.model;
      choice.thinkingLevel = result.thinkingLevel;
      choice.warning = result.warning;
    } else {
      choice.warning = `model "${reference}" is not available, keeping the current model: ${result.error}`;
    }
  }
  if (definition.effort) choice.thinkingLevel = definition.effort;
  return choice;
}

// resolveCliModel reads only the model list and which providers have credentials.
function registryRuntime(registry: ModelRegistry): ModelRuntime {
  return {
    getModels: () => registry.getAll(),
    hasConfiguredAuth: (provider: string) => registry.getAvailable().some((model) => model.provider === provider),
  } as unknown as ModelRuntime;
}
