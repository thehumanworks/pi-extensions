import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
  ToolInfo,
  ToolLoadout,
} from "@earendil-works/pi-coding-agent";
import { management } from "./loadout.ts";

/** Ordinary worker tools go through the lead's real dispatch path, not a new
 * local bash/read implementation. This preserves live remote targets and hooks. */
export class LeadBridge {
  private delegate?: AgentTool;
  private readonly requests = new WeakMap<object, (ctx: ExtensionToolContext) => void>();
  private readonly worker = new AsyncLocalStorage<boolean>();
  constructor(pi: ExtensionAPI) {
    pi.on("tool_call", (e) => {
      if (this.worker.getStore() && management.has(e.toolName))
        return { block: true, reason: "Subagent management belongs to the lead." };
    });
  }
  capture(loadout: ToolLoadout) {
    this.delegate = loadout.registered.find((t) => t.name === "subagent_delegate");
    return undefined;
  }
  bind(params: object, ctx: ExtensionToolContext) {
    const receive = this.requests.get(params);
    if (!receive) return false;
    receive(ctx);
    return true;
  }
  async forWorker(id: string, signal: AbortSignal) {
    // session_start has no executeTool(). Ask our own bound definition for a
    // fresh Pi tool context, including on restart, without delegating a task.
    // Only this exact in-memory object can take the internal branch.
    if (!this.delegate) throw new Error("The lead's delegation tool is no longer enabled.");
    let context: ExtensionToolContext | undefined;
    const params = { task: "" };
    this.requests.set(params, (c) => {
      context = c;
    });
    try {
      await this.delegate.execute("worker-" + id, params, signal);
    } finally {
      this.requests.delete(params);
    }
    if (!context) throw new Error("Could not bind worker to the current lead session.");
    return context;
  }
  proxy(t: ToolInfo, ctx: ExtensionToolContext, source?: AgentTool): ToolDefinition {
    if (!source) throw new Error("Tool is no longer callable on the lead: " + t.name);
    return {
      ...t,
      label: source.label,
      outputSchema: source.outputSchema,
      constrainedSampling: source.constrainedSampling,
      executionMode: source.executionMode,
      execute: async (_id, args, signal, onUpdate) => {
        const outcome = await this.worker.run(true, () =>
          ctx.executeTool(t.name, args, { signal, onUpdate }),
        );
        return { ...outcome.result, isError: outcome.isError };
      },
    };
  }
}
