import { createHash } from "node:crypto";
import { defineExtension, defineTool, type Extension, type Registry, type ToolRegistration } from "@earendil-works/pi-durable";
import type { TSchema } from "typebox";
import { json, StructuredResult } from "./store.ts";

export function structuredTool(registry: Registry, runId: string, key: string, schema: TSchema): { extension: Extension; tool: ToolRegistration } {
  const name = `workflow.result.${runId}.${createHash("sha256").update(JSON.stringify({ key, schema })).digest("hex").slice(0, 16)}`;
  const existing = registry.snapshot().extension(name);
  if (existing) return { extension: existing, tool: existing.tools![0] };
  const tool = defineTool({
    name: "submit_result", description: "Finish this task by submitting the complete schema-valid result. This ends the agent turn.",
    parameters: schema, replay: "safe",
    execute: async (args, api, ctx) => {
      await api.commit(async tx => {
        const result = await tx.doc(StructuredResult, api.conversationId);
        if (!result.submitted) { result.submitted = true; result.value = json(args); }
      }, ctx);
      return { output: [{ type: "text", text: "Result accepted." }], control: { terminate: true } };
    },
  });
  const extension = defineExtension({ name, tools: [tool] });
  registry.install(extension);
  return { extension, tool };
}
