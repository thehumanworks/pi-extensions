import { clampThinkingLevel, StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ScopedModel } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { WorkerConfig } from "./board.ts";

export const delegateParameters = Type.Object({
  task: Type.String({ minLength: 1 }),
  model: Type.Optional(
    Type.String({
      description:
        "Exact <provider>/<model> from the lead's /scoped-models. Omit to use the lead's active model.",
      minLength: 1,
    }),
  ),
  reasoningEffort: Type.Optional(
    StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, {
      description: "Pi thinking level for this worker. Omit to use the session or selected model's default.",
    }),
  ),
  systemPrompt: Type.Optional(
    Type.String({
      description:
        "Literal worker system prompt in place of the lead's prompt. Worker reporting and tool rules still apply.",
      minLength: 1,
      pattern: "\\S",
    }),
  ),
});

const modelName = ({ provider, id }: ScopedModel["model"]) => `${provider}/${id}`;

export function scopedModelChoices(scope: readonly ScopedModel[]) {
  const names = scope.slice(0, 20).map(({ model }) => modelName(model));
  if (names.length < scope.length) names.push(`… (${scope.length - names.length} more in /scoped-models)`);
  return names.join(", ");
}

/** Resolve once, before queueing. An explicit model is an allowlist lookup, not a registry search. */
export function resolveWorkerConfig(
  { model: reference, reasoningEffort, systemPrompt }: Static<typeof delegateParameters>,
  ctx: Pick<ExtensionContext, "model" | "scopedModels" | "thinkingLevel">,
  settings: Pick<ReturnType<ExtensionAPI["getSettings"]>, "defaultThinkingLevel" | "modelThinkingLevels">,
): WorkerConfig {
  const scope = ctx.scopedModels ?? [];
  const selected =
    reference === undefined ? undefined : scope.find(({ model }) => modelName(model) === reference);
  if (reference !== undefined && !selected) {
    if (!scope.length)
      throw new Error("No scoped models for worker overrides. Configure /scoped-models or omit model.");
    throw new Error(`Use an exact scoped <provider>/<model>. Choices: ${scopedModelChoices(scope)}`);
  }
  const model = selected?.model ?? ctx.model;
  if (!model) throw new Error("Select a Pi model first.");
  const leadLevel = ctx.thinkingLevel;
  const effort =
    reasoningEffort ??
    (selected ? selected.thinkingLevel : leadLevel) ??
    settings.modelThinkingLevels?.[modelName(model)] ??
    settings.defaultThinkingLevel ??
    leadLevel;
  return {
    provider: model.provider,
    model: model.id,
    reasoningEffort: effort === undefined ? undefined : clampThinkingLevel(model, effort),
    systemPrompt,
  };
}
