import { Type } from "typebox";
import { isAbsolute, relative } from "node:path";
import { expandPath } from "./definitions.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { draftInstructions, draftPreview, type DraftWorkflow } from "./drafts.ts";

const required = (value: string | undefined, field: string) => { if (!value?.trim()) throw new Error(`${field} is required.`); return value; };

export function registerDraftTools(pi: ExtensionAPI, drafts: DraftWorkflow, author?: string): void {
  pi.on("before_agent_start", async event => {
    const draft = await drafts.current();
    if (draft && draft.author === author) event.systemPromptOptions.sections.agent_creation = draftInstructions(draft);
    else delete event.systemPromptOptions.sections.agent_creation;
  });
  pi.on("tool_call", async (event, ctx) => {
    if (!["write", "edit"].includes(event.toolName) || !("path" in event.input) || typeof event.input.path !== "string") return;
    if (!await drafts.current()) return;
    const path = expandPath(event.input.path, ctx.cwd);
    const inside = (dir: string) => { const rel = relative(dir, path); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); };
    if (inside(drafts.store.root) && !inside(drafts.store.homes)) return { block: true, reason: "Creation proposals belong in agent_draft, not registry files. Only the human's /agent accept creates the agent." };
  });
  pi.registerTool({
    name: "agent_draft", label: "Agent creation draft", exposure: "model-only", executionMode: "sequential",
    description: "Collaborate on the user's /agent new draft. Show or propose a complete definition without creating an agent. Evaluate an exact revision on a task with success criteria; every eval asks the HUMAN for approval and uses fresh scratch history/home with real tools. Completed is NOT a passing grade. No accept/reject operation: only human slash commands can finish the workflow.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("show"), Type.Literal("propose"), Type.Literal("eval")]),
      definition: Type.Optional(Type.String()), revision: Type.Optional(Type.String()),
      task: Type.Optional(Type.String()), criteria: Type.Optional(Type.String()),
    }),
    async execute(_id, args, signal, onUpdate) {
      await drafts.forAuthor(author);
      if (args.action === "eval") {
        const evaluation = await drafts.evaluate(required(args.revision, "revision"), required(args.task, "task"), required(args.criteria, "criteria"), author, signal, event => {
          if (event.type === "tool_execution_start") onUpdate?.({ content: [{ type: "text", text: `Evaluation: ${event.toolName}` }], details: undefined });
        });
        const output = evaluation.result?.output ?? evaluation.error ?? "";
        return {
          content: [{ type: "text", text: JSON.stringify({ ...evaluation, result: evaluation.result ? { ...evaluation.result, output: output.slice(0, 24_000) + (output.length > 24_000 ? `\n[Truncated; read ${evaluation.result.sessionFile}]` : "") } : undefined }) + "\nAssess the actual output against the criteria. Execution completion alone does not establish success." }],
          details: evaluation, usage: evaluation.result?.usage,
        };
      }
      const draft = args.action === "propose" ? await drafts.propose(required(args.definition, "definition"), author) : await drafts.forAuthor(author);
      return { content: [{ type: "text", text: draftPreview(draft) }], details: draft };
    },
  });
}
