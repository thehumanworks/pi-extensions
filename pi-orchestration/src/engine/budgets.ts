import { createHash } from "node:crypto";
import { defineExtension, GenerationTask, hook, UsageDoc } from "@earendil-works/pi-durable";
import type { Engine } from "./index.ts";
import type { AgentOptions } from "../index.ts";
import { AgentMeta } from "./store.ts";

/** afterResponse runs before classification, so an over-budget response cannot launch another tool round. */
export function budgetExtension(engine: () => Engine) {
  return defineExtension({ name: "workflow.budgets", hooks: [hook(GenerationTask, {
    afterResponse: async (message, api, ctx) => {
      const metadata = await api.snapshot(AgentMeta, api.conversationId, ctx);
      if (!metadata?.runId) return;
      const options = metadata.options as AgentOptions;
      if (!options.budget) return;
      const task = await engine().harness.getTask(api.taskId, ctx);
      const position = createHash("sha256").update(JSON.stringify({ task: api.taskId, state: task?.state })).digest("hex");
      const previous = await api.snapshot(UsageDoc, api.conversationId, ctx);
      const cost = Object.values(previous?.models ?? {}).reduce((sum, value) => sum + value.cost.total, 0) + message.usage.cost.total;
      let failure: string | undefined;
      await engine().root.commit(async tx => {
        const meta = await tx.doc(AgentMeta, api.conversationId);
        if (!meta.seenResponses.includes(position)) { meta.seenResponses.push(position); meta.turns++; }
        if (options.budget?.maxCostUsd !== undefined && cost > options.budget.maxCostUsd)
          failure = `Agent exceeded maxCostUsd=${options.budget.maxCostUsd}.`;
        if (options.budget?.maxTurns !== undefined && (meta.turns > options.budget.maxTurns || meta.turns >= options.budget.maxTurns && message.stopReason === "toolUse"))
          failure = `Agent reached maxTurns=${options.budget.maxTurns}.`;
        if (failure) meta.budgetError = failure;
      }, ctx);
      if (failure) {
        // Keep the provider usage on this response; the harness records it even though classification fails.
        message.stopReason = "error"; message.errorMessage = `budget_exceeded: ${failure}`;
      }
    },
  })] });
}
