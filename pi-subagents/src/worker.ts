import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  type ExtensionContext,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { Board, Job, Outcome } from "./board.ts";
import type { LeadBridge } from "./bridge.ts";
import { accessible, management, resources } from "./loadout.ts";

export async function runWorker(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  board: Board,
  job: Job,
  signal: AbortSignal,
  bridge: LeadBridge,
): Promise<Outcome> {
  signal.throwIfAborted();
  const model = ctx.modelRegistry.find(job.provider, job.model);
  if (!model) throw new Error("Assigned Pi model is unavailable: " + job.provider + "/" + job.model);
  const lead = await bridge.forWorker(job.id, signal);
  const inherited = accessible(pi);
  const active = pi.getActiveTools().filter((n) => !management.has(n));
  const systemPrompt =
    (job.systemPrompt ?? ctx.getSystemPrompt()) +
    "\nYou are a background worker speaking only to the lead. Use the provided tools. Return your result as your final answer. If blocked, start the final answer with BLOCKED: followed by what you need." +
    (job.depth < board.limits().depth
      ? " To delegate one narrower task and wait for its result, return DELEGATE: followed by the full assignment."
      : " Further delegation is disabled.");
  const { settingsManager, resourceLoader } = await resources(pi, ctx, inherited, systemPrompt);
  settingsManager.setRetryEnabled(false); // The task board owns retries.
  settingsManager.setCacheWarmingMode("off");
  const manager = SessionManager.inMemory(ctx.cwd, { id: job.id }, job.entries);
  const entries = () => [manager.getHeader()!, ...manager.getEntries()];
  for (const m of job.entries ? [] : job.history) {
    if (m.role === "assistant" || m.role === "user" || m.role === "toolResult") manager.appendMessage(m);
  }
  const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
  const provider = ctx.modelRegistry.getProvider(job.provider);
  if (provider) runtime.registerNativeProvider(provider);
  const callable = new Map(lead.tools.map((tool) => [tool.name, tool]));
  const { session } = await createAgentSession({
    cwd: ctx.cwd,
    model,
    modelRuntime: runtime,
    sessionManager: manager,
    settingsManager,
    resourceLoader,
    thinkingLevel: job.reasoningEffort ?? ctx.thinkingLevel,
    tools: inherited.map((t) => t.name),
    excludeTools: [...management],
    customTools: inherited
      .filter((t) => t.exposure !== "model-only")
      .map((t) => bridge.proxy(t, lead, callable.get(t.name))),
  });
  const abort = () => {
    void session.abort();
  };
  try {
    signal.throwIfAborted();
    signal.addEventListener("abort", abort, { once: true });
    await session.bindExtensions({ mode: ctx.mode, uiContext: ctx.ui });
    session.setActiveToolsByName(active);
    const local = session.getAllTools();
    for (const t of inherited.filter((t) => t.exposure === "model-only")) {
      if (
        !local.some(
          (other) =>
            other.name === t.name &&
            other.exposure === t.exposure &&
            other.sourceInfo.path === t.sourceInfo.path,
        )
      )
        throw new Error("Cannot recreate lead's model-only tool: " + t.name + " (" + t.sourceInfo.path + ")");
    }
    const allowed = new Set(inherited.map((t) => t.name));
    const extra = session.getCallableToolNames().filter((n) => !allowed.has(n));
    if (extra.length)
      throw new Error("Worker loadout contains tools absent from the lead: " + extra.join(", "));
    // Preserve dispatch-time provider selection and the lead's request-time auth.
    session.agent.streamFunction = (m, c, o) => ctx.modelRegistry.streamSimple(m, c, o);
    const before = session.agent.beforeToolCall;
    session.agent.beforeToolCall = async (call, s) => {
      signal.throwIfAborted();
      if (!accessible(pi).some((t) => t.name === call.toolCall.name))
        return { block: true, reason: "This tool is no longer available to the lead." };
      const decision = await before?.(call, s);
      if (!decision?.block) board.markMutation(job.id, call.toolCall.name);
      return decision;
    };
    session.agent.subscribe((e) => {
      if (e.type === "turn_end" && e.toolResults.length && !signal.aborted)
        board.checkpoint(job.id, [], entries());
    });
    signal.throwIfAborted();
    // The model and credentials are bound above. The SDK agent uses the session's
    // projection, hidden declarations, native tool_call/tool_result hooks and registry.
    await session.prompt(
      job.prompt || "Continue from the last recorded tool result without repeating the operation.",
      { expandPromptTemplates: false },
    );
    signal.throwIfAborted();
    const last = session.messages.at(-1);
    if (last?.role !== "assistant" || last.stopReason !== "stop")
      throw new Error(
        last?.role === "assistant" ? (last.errorMessage ?? last.stopReason) : "No final answer.",
      );
    const answer = last.content
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join("\n")
      .trim();
    if (!answer) throw new Error("Worker returned an empty answer.");
    const match = /^(BLOCKED|DELEGATE):\s*([\s\S]+)$/.exec(answer);
    return {
      kind: match ? (match[1] === "BLOCKED" ? "blocked" : "delegate") : "done",
      text: match?.[2] ?? answer,
      history: [],
      entries: entries(),
    };
  } finally {
    signal.removeEventListener("abort", abort);
    try {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      session.dispose();
    }
  }
}
