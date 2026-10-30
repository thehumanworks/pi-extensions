import { join, resolve } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checkName, expandPath } from "./src/definitions.ts";
import { AgentStore } from "./src/store.ts";
import { printResult } from "./src/output.ts";
import { AgentRuntime, isAgentChild } from "./src/runtime.ts";
import { LoopStore, Scheduler } from "./src/loops.ts";
import { registerAgentTools, type Services } from "./src/tools.ts";
import { DraftWorkflow, draftPreview } from "./src/drafts.ts";
import { registerDraftTools } from "./src/draft-tools.ts";
import { handleDraftCommand } from "./src/draft-commands.ts";

const selectionEntry = "pi-agent.selection";
const draftEntry = "pi-agent.creation-draft";
const help = `/agent [activate] <name> — continue an agent's conversation\n/agent list | new [name] [purpose] | edit <name> | approve <name> | reject <name>\n/agent draft | eval [request] | accept | reject — collaboratively design a new agent\n/agent delete <name> — human-confirmed archive; leaves home files intact\n/agent loops — inspect schedules (manage them with agent_loop)\n/agent stop | off — cancel direct conversation / return to normal Pi\n\nAgents run in their own homes and native SDK sessions. /model, /tree and !shell belong to outer Pi, not the selected agent. Use /agent stop to cancel; Escape and RPC abort target outer Pi. Loops run only while Pi is alive.`;

function registerRoster(pi: ExtensionAPI, store: AgentStore): void {
  pi.on("before_agent_start", async (event, ctx) => {
    const roster = await store.list(ctx.isProjectTrusted() ? ctx.cwd : undefined);
    const text = roster.agents.map(a => `- ${a.name}: ${a.description || "(no description)"}`).join("\n");
    event.systemPromptOptions.sections.specialist_agents = `Use agent_manage to inspect/create agents and agent_run to delegate self-contained tasks.\n${text.slice(0, 24_000)}\nUse agent_manage list for the full roster. Definition approval and agent deletion are HUMAN-only.`;
  });
}

export default function piAgent(pi: ExtensionAPI): void {
  if (isAgentChild()) return;
  const agentDir = getAgentDir();
  const root = process.env.PI_AGENT_HOME ? expandPath(process.env.PI_AGENT_HOME, process.cwd()) : join(agentDir, "agents");
  const store = new AgentStore(resolve(root), agentDir);
  const loops = new LoopStore(store.root);
  let services: Services;
  const runtime = new AgentRuntime(store, {
    extension: (name, chain, run) => child => {
      // Delegates do not receive authoring tools, but must retain the review guard.
      registerAgentTools(child, { store, loops, runtime, drafts }, name, chain);
      registerRoster(child, store);
      if (run.drafting) registerDraftTools(child, drafts, name);
    },
  });
  const drafts = new DraftWorkflow(store, runtime, {
    changed: id => pi.appendEntry(draftEntry, { id: id ?? null }),
    confirmEvaluation: async (draft, task, criteria, signal) => {
      const ctx = lastContext;
      if (closing || !ctx?.hasUI) throw new Error("Evaluation requires human approval in the active Pi UI.");
      await show(ctx, `${draftPreview(draft)}\n\nPROPOSED TRIAL\nTask: ${task}\nSuccess criteria: ${criteria}`);
      return ctx.ui.confirm("Run this draft evaluation?", "This runs the exact draft in a fresh scratch home/history with real model/tool access and provider costs. Tools may affect other directories or external services; it is not a sandbox. Management/delegation/loop tools are disabled. Review the definition, task and success criteria above.", { signal });
    },
  });
  services = { store, loops, runtime, drafts };
  registerAgentTools(pi, services);
  registerDraftTools(pi, drafts);
  registerRoster(pi, store);
  pi.registerFlag("agent", { type: "string", description: "Activate a specialist agent by name (persistent home and conversation)." });

  let selected: string | undefined;
  let direct: AbortController | undefined;
  let scheduler: Scheduler | undefined;
  let lastContext: ExtensionContext | undefined;
  let closing = false;

  const show = async (ctx: ExtensionContext, text: string, error = false) => {
    if (ctx.mode === "print") {
      await printResult(text, error);
      if (error) process.exitCode = 1;
    } else pi.sendMessage({ customType: "pi-agent", content: text, display: true, details: { selected, error } });
  };
  const persist = (ctx: ExtensionContext) => {
    pi.appendEntry(selectionEntry, { name: selected ?? null });
    ctx.ui.setStatus("pi-agent", selected ? `agent: ${selected}` : undefined);
  };

  pi.on("session_start", async (event, ctx) => {
    lastContext = ctx;
    const saved = ctx.sessionManager.getBranch().findLast(e => e.type === "custom" && e.customType === selectionEntry);
    const value = saved?.type === "custom" ? (saved.data as { name?: string | null })?.name : undefined;
    const flag = event.reason === "startup" ? pi.getFlag("agent") : undefined;
    selected = typeof flag === "string" && flag ? flag : value ?? undefined;
    const savedDraft = ctx.sessionManager.getBranch().findLast(e => e.type === "custom" && e.customType === draftEntry);
    const draftId = savedDraft?.type === "custom" ? (savedDraft.data as { id?: string | null })?.id : undefined;
    await drafts.restore(draftId ?? undefined);
    // Retain invalid selections: subsequent input must fail closed, never use the outer model.
    if (selected) {
      try { await store.ensure(selected, ctx.isProjectTrusted() ? ctx.cwd : undefined); persist(ctx); }
      catch (e) { await show(ctx, `Cannot activate agent '${selected}': ${String(e)}`, true); }
    }
    scheduler = new Scheduler(loops, (loop, signal) => runtime.run(loop.agent, loop.task, { signal }), message => {
      if (!closing) lastContext?.ui.notify(message, message.includes("Error") ? "error" : "info");
    });
    scheduler.start();
  });

  pi.on("input", async (event, ctx) => {
    if (!selected) return { action: "continue" };
    const name = selected;
    try {
      if (direct) throw new Error("Agent is busy. Wait for its reply or use /agent stop.");
      const controller = new AbortController();
      direct = controller;
      // Input interception precedes the outer turn, so its normal abort signal may not
      // exist. /agent stop handles UI/RPC cancellation; OS signals must also stop print runs.
      const onSignal = () => controller.abort(new Error("Agent interrupted by process signal"));
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
      let progress = "";
      try {
        const reply = await runtime.run(name, event.text, {
          cwd: ctx.isProjectTrusted() ? ctx.cwd : undefined, images: event.images,
          drafting: (await drafts.current())?.author === name,
          signal: ctx.signal ? AbortSignal.any([controller.signal, ctx.signal]) : controller.signal,
          onEvent: e => {
            if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") {
              progress = (progress + e.assistantMessageEvent.delta).slice(-4000);
              if (ctx.hasUI) ctx.ui.setWidget("pi-agent-progress", [`${name}…`, ...progress.split("\n").slice(-12)]);
            }
            if (e.type === "tool_execution_start" && ctx.hasUI) ctx.ui.setStatus("pi-agent", `agent: ${name} · ${e.toolName}`);
          },
        });
        if (!closing) {
          await show(ctx, `${reply.agent}\n${reply.output}\n\nsession: ${reply.sessionFile}${reply.warnings.length ? `\n${reply.warnings.join("\n")}` : ""}`);
          pi.appendEntry("pi-agent.run", { agent: reply.agent, sessionFile: reply.sessionFile, usage: reply.usage });
        }
      } finally {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        if (direct === controller) direct = undefined;
        if (!closing && ctx.hasUI) { ctx.ui.setWidget("pi-agent-progress", undefined); ctx.ui.setStatus("pi-agent", selected ? `agent: ${selected}` : undefined); }
      }
    } catch (e) {
      try { if (!closing) await show(ctx, `Agent '${name}' failed: ${String(e)}`, true); } catch { /* A stale UI must not allow fallback to the outer model. */ }
    }
    return { action: "handled" };
  });

  pi.registerCommand("agent", {
    description: "Activate, list, create and administer specialist agents; /agent help for usage",
    getArgumentCompletions: prefix => ["list", "new", "draft", "eval", "accept", "activate", "edit", "approve", "reject", "delete", "loops", "stop", "off", "help"].filter(v => v.startsWith(prefix)).map(v => ({ value: v, label: v })),
    async handler(args, ctx) {
      try {
        lastContext = ctx;
        const words = args.trim().split(/\s+/).filter(Boolean);
        if (await handleDraftCommand(words, ctx, { pi, drafts, store, selected: () => selected, busy: () => !!direct, show })) return;
        let action = words[0] ?? "list";
        let name = words[1];
        const commands = ["list", "new", "activate", "edit", "approve", "reject", "delete", "loops", "stop", "off", "help"];
        if (!commands.includes(action)) { name = action; action = "activate"; }
        if (words.length > (action === "activate" && !commands.includes(words[0]) ? 1 : 2)) throw new Error("Unexpected arguments. Use /agent help.");
        if (action === "help") { await show(ctx, help); return; }
        if (action === "list") {
          const roster = await store.list(ctx.isProjectTrusted() ? ctx.cwd : undefined);
          await show(ctx, roster.agents.map(a => `${a.name}${a.name === selected ? " *" : ""} — ${a.description || "(no description)"}\n  home: ${a.home}\n  ${a.file}`).join("\n") || "No agents. Use /agent new <name>.");
          if (roster.diagnostics.length) await show(ctx, roster.diagnostics.join("\n"));
          return;
        }
        if (action === "loops") { await show(ctx, JSON.stringify(await loops.list(), null, 2)); return; }
        if (action === "stop") { drafts.stop(); direct?.abort(new Error("Stopped by user")); ctx.abort(); return; }
        const draft = await drafts.current();
        if (action === "off") {
          if (draft?.author) throw new Error("Accept or reject the creation draft before leaving its author.");
          direct?.abort(new Error("Agent deactivated")); selected = undefined; persist(ctx); return;
        }
        name = checkName(name ?? selected ?? "");
        if (draft && ((action === "activate" && name !== draft.author) || (action === "delete" && name === draft.author))) throw new Error("Accept or reject the creation draft before switching/deleting its author.");
        const def = await store.ensure(name, ctx.isProjectTrusted() ? ctx.cwd : undefined);
        if (action === "activate") {
          if (direct) throw new Error("Wait for the current agent, or /agent stop first.");
          selected = name; persist(ctx);
          await show(ctx, `Activated ${name}. Home: ${def.home}. Continuing its own conversation. Use /agent stop to cancel (not Escape/RPC abort).\n${def.warnings.join("\n")}`);
          return;
        }
        if (!ctx.hasUI) throw new Error("Definition approval, editing and agent deletion require a human UI.");
        if (action === "edit") {
          const source = await ctx.ui.editor(`Edit ${name}`, (await store.candidate(name))?.source ?? await store.source(name));
          if (source === undefined) return;
          await store.propose(name, source);
          await show(ctx, `Proposal staged. Review and approve with /agent approve ${name}.`);
          return;
        }
        if (action === "approve" || action === "reject") {
          const candidate = await store.candidate(name);
          if (!candidate) { await show(ctx, "No pending changes."); return; }
          const preview = `CURRENT:\n${await store.source(name)}\n\nPROPOSED (${candidate.revision}):\n${candidate.source}`;
          // Full text is displayed, never only a model-authored summary of the change.
          await show(ctx, preview);
          if (!await ctx.ui.confirm(`${action === "approve" ? "Approve" : "Discard"} definition for ${name}?`, `Review the full current/proposed definitions above. Revision: ${candidate.revision}`)) return;
          if (action === "approve") await store.approve(name, candidate.revision); else await store.reject(name, candidate.revision);
          await show(ctx, `${action === "approve" ? "Approved; applies on the next run" : "Discarded"}: ${name}`);
          return;
        }
        if (action === "delete") {
          if (!await ctx.ui.confirm(`Delete agent ${name}?`, `Archive definition/history and remove its schedules. Home files at ${def.home} are NOT deleted.`)) return;
          const archive = await store.archive(name);
          await loops.remove(name);
          if (selected === name) { selected = undefined; persist(ctx); }
          await show(ctx, `Archived ${name} at ${archive}. Home retained: ${def.home}`);
        }
      } catch (e) { await show(ctx, String(e), true); }
    },
  });

  pi.on("session_shutdown", async () => {
    closing = true;
    direct?.abort(new Error("Pi session closed"));
    await Promise.all([scheduler?.stop(), drafts.close(), runtime.close()]);
    lastContext = undefined;
  });
}
