import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checkName, permitsTool } from "./definitions.ts";
import { draftInstructions, draftPreview, type DraftWorkflow } from "./drafts.ts";
import type { AgentStore } from "./store.ts";

interface Commands {
  pi: ExtensionAPI;
  drafts: DraftWorkflow;
  store: AgentStore;
  selected: () => string | undefined;
  busy: () => boolean;
  show: (ctx: ExtensionContext, text: string, error?: boolean) => Promise<void>;
}

/** Keep creation command parsing/review separate from definition administration. */
export async function handleDraftCommand(words: string[], ctx: ExtensionCommandContext, commands: Commands): Promise<boolean> {
  const { pi, drafts, store, selected, busy, show } = commands;
  const action = words[0];
  const current = await drafts.current();
  if (!["new", "draft", "accept", "eval"].includes(action) && !(action === "reject" && words.length === 1 && current)) return false;
  if (action === "draft") {
    await show(ctx, current ? draftPreview(current) : "No creation draft. Start with /agent new.");
    return true;
  }
  if (busy() || !ctx.isIdle()) throw new Error("Wait for the active agent, or /agent stop before changing the creation workflow.");
  if (action === "new") {
    if (current) throw new Error("A creation draft is already open. Iterate in chat, or /agent accept or /agent reject first.");
    if (!ctx.hasUI) throw new Error("/agent new requires a human UI for collaborative review.");
    const name = words[1] ? checkName(words[1]) : undefined;
    const author = selected();
    if (author) {
      const def = await store.ensure(author, ctx.isProjectTrusted() ? ctx.cwd : undefined);
      if (!permitsTool(def, "agent_draft")) throw new Error(`The selected agent '${author}' must allow agent_draft to author a draft. Enable that tool or /agent off to use the main Pi agent.`);
    }
    const purpose = words.slice(2).join(" ") || await ctx.ui.input("What should this agent do? Describe its purpose and what success looks like.");
    if (!purpose?.trim()) return true;
    if (selected() !== author || busy() || !ctx.isIdle()) throw new Error("The active agent changed while entering the description. Try /agent new again.");
    const draft = await drafts.start(purpose, name, author, ctx.isProjectTrusted() ? ctx.cwd : undefined);
    await show(ctx, "The active agent will propose a definition. Continue chatting to iterate or request evals. Nothing is created until /agent accept; /agent reject discards the draft.");
    pi.sendUserMessage(draftInstructions(draft));
    return true;
  }
  if (!current) throw new Error("No creation draft. Start with /agent new.");
  if (action === "eval") {
    if (selected() !== current.author) throw new Error("Resume this draft's original author before asking it for evaluations.");
    if (!current.source) throw new Error("Ask the active agent to propose a definition before evaluating it.");
    pi.sendUserMessage(`Please evaluate our agent creation draft (${current.revision}). ${words.slice(1).join(" ") || "Choose representative trial tasks and explicit success criteria for the stated purpose."}\nUse agent_draft eval for each trial; it asks me for approval before executing. Assess the actual evidence, report weaknesses, and propose improvements if necessary. Do not accept the draft for me.`);
    return true;
  }
  if (words.length > 1) throw new Error(`Use /agent ${action} without a name for the current creation draft.`);
  if (!ctx.hasUI) throw new Error("Accepting or rejecting a creation draft requires a human UI.");
  if (action === "accept" && (!current.source || !current.revision)) throw new Error("No definition has been proposed yet.");
  await show(ctx, draftPreview(current));
  if (!await ctx.ui.confirm(action === "accept" ? "Accept this agent definition?" : "Reject this agent creation draft?", `Review the full definition and revision-specific evaluation evidence above. Revision: ${current.revision ?? "none"}. ${action === "accept" ? "Only this exact definition will be saved; trial memory is not copied." : "No agent will be created. Draft/eval records remain for inspection."}`)) return true;
  if (action === "accept") {
    const name = await drafts.accept(current.id, current.revision!);
    await show(ctx, `Created ${store.file(name)}. Activate with /agent ${name}. Your current agent remains selected.`);
  } else {
    await drafts.reject(current.id, current.revision);
    await show(ctx, "Creation draft rejected. No agent was created. Start again with /agent new.");
  }
  return true;
}
