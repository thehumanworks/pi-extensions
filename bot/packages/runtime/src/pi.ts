import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { connectBot, type BotClient } from "./client.js";
import { createBot, editBot, archiveBot, listBots } from "./catalog.js";
import { botsRoot, expandHome, resolveSource } from "./paths.js";
import { inspectBot } from "./project.js";
import { createReplyPreview } from "./reply.js";
import type { BotHandle, BotInfo, BotRunRecord, OpenBotOptions, ThinkingLevel } from "./types.js";

/** All conversations belong to the SDK; the surrounding Pi session is a UI, not a second model loop. */
type Target = Pick<BotHandle, "info" | "submit" | "run" | "getRun" | "listSessions" | "watch" | "cancel" | "close">;
export interface PiBotOptions {
  openBot?: (source: string, options: OpenBotOptions) => Promise<BotHandle>;
  connectBot?: (url: string, options: { authToken?: string }) => BotClient;
  root?: () => string;
}
interface Selection { source: string; name: string; sessionId?: string; tokenEnv?: string; target?: Target }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const remote = (source: string) => /^https?:\/\//i.test(source);
const text = (content: string) => [{ type: "text" as const, text: content }];
const terminal = (run: BotRunRecord) => ["completed", "failed", "cancelled"].includes(run.status);
function describe(info: BotInfo): string {
  return `${info.name}: ${info.description}\nsource: ${info.sourceDir}\nstate: ${info.stateDir}\nmodel: ${info.model ?? "Pi user default"}\ninherit: ${info.inherit}\nrevision: ${info.revision}\ntools: ${info.tools.map(tool => tool.name).join(", ") || "none"}${info.diagnostics.length ? `\n${info.diagnostics.join("\n")}` : ""}`;
}

/** Register the transport-independent Pi UI adapter. Rendering belongs to the pi-bot package. */
export function registerPiBot(pi: ExtensionAPI, options: PiBotOptions = {}): void {
  const root = options.root ?? botsRoot;
  let selected: Selection | undefined;
  let startup = true;
  let startupError: string | undefined;
  let context: ExtensionContext | undefined;
  let lifetime = new AbortController();
  let admission = Promise.resolve();
  let handles = new Map<string, Promise<Target>>();
  const jobs = new Set<Promise<unknown>>();
  const pending = new Map<string, { target: Target; runId: string; selection: Selection }>();
  function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") {
    if (ctx.hasUI) ctx.ui.notify(message, level); else process.stderr.write(`bot: ${message}\n`);
  }
  function status() {
    if (context?.hasUI) context.ui.setStatus("pi-bot", selected ? `bot: ${selected.name}${selected.sessionId ? ` · ${selected.sessionId}` : ""}` : undefined);
  }
  function persist() { pi.appendEntry("bot.selection", selected ? { source: selected.source, name: selected.name, sessionId: selected.sessionId, tokenEnv: selected.tokenEnv } : { selected: false }); status(); }
  const localRef = (ref: string, cwd: string) => ref.includes("/") || ref.includes("\\") || ref.startsWith(".") || ref.startsWith("~") ? resolve(cwd, expandHome(ref)) : join(root(), ref);
  async function target(ref: string, cwd: string, tokenEnv?: string): Promise<Target> {
    const source = remote(ref) ? ref : await resolveSource(localRef(ref, cwd));
    if (tokenEnv && !remote(source)) throw new Error("authTokenEnv is only for a daemon URL; provider auth already uses Pi's user credentials.");
    const key = `${source}\n${tokenEnv ?? ""}`;
    const signal = lifetime.signal;
    let promise = handles.get(key);
    if (!promise) {
      const create = async (): Promise<Target> => {
        let handle: Target;
        if (remote(source)) {
          const authToken = tokenEnv === undefined ? undefined : process.env[tokenEnv];
          if (tokenEnv !== undefined && !authToken?.trim()) throw new Error(`Environment variable ${tokenEnv} does not contain a daemon token.`);
          handle = (options.connectBot ?? connectBot)(source, { authToken });
        } else {
          const open = options.openBot ?? (await import("./worker-client.js")).openBotProcess;
          handle = await open(source, { cwd });
        }
        if (signal.aborted) { await handle.close(); throw new Error("Pi session closed while opening the bot."); }
        return handle;
      };
      promise = create(); handles.set(key, promise);
      void promise.catch(() => { if (handles.get(key) === promise) handles.delete(key); });
    }
    return promise;
  }
  async function select(source: string, ctx: ExtensionContext, sessionId?: string, tokenEnv?: string) {
    const handle = await target(source, ctx.cwd, tokenEnv), info = await handle.info();
    selected = { source: remote(source) ? source : info.sourceDir, name: info.name, sessionId, tokenEnv, target: handle };
    startupError = undefined;
    persist();
    notify(ctx, `Talking to ${info.name}${remote(source) ? ` at ${source}` : ""}. Bot conversations are stored by the SDK. /bot exit returns to Pi; /bot stop cancels pending work.`);
  }
  async function awaitReply(slot: Selection, handle: Target, initial: BotRunRecord, ctx: ExtensionContext, signal: AbortSignal) {
    const key = `${slot.source}\n${initial.runId}`;
    pending.set(key, { target: handle, runId: initial.runId, selection: slot });
    try {
      let result = initial;
      while (!terminal(result)) {
        await delay(100, undefined, { signal });
        result = await handle.getRun(initial.runId);
      }
      if (!signal.aborted) pi.sendMessage({ customType: "bot-reply", content: result.output || result.error || "(no output)", display: true, details: result }, { triggerTurn: false });
    } catch (error) { if (!signal.aborted) notify(ctx, errorText(error), "error"); }
    finally { pending.delete(key); if (!signal.aborted && selected === slot && ctx.hasUI) ctx.ui.setWidget("pi-bot-progress", undefined); }
  }
  function chat(message: string, slot: Selection, ctx: ExtensionContext) {
    const signal = lifetime.signal;
    pi.sendMessage({ customType: "bot-input", content: message, display: true, details: { bot: slot.name } }, { triggerTurn: false });
    admission = admission.then(async () => {
      if (signal.aborted) return;
      const handle = slot.target ??= await target(slot.source, ctx.cwd, slot.tokenEnv);
      // Subscribe at admission, not after submit: a fast run may finish before watch attaches.
      const reply = createReplyPreview();
      const accepted = await handle.submit(message, { session: slot.sessionId, onEvent: event => {
        if (signal.aborted || selected !== slot || !ctx.hasUI) return;
        if (reply.apply(event)) ctx.ui.setWidget("pi-bot-progress", [
          `${slot.name} · ${event.runId ?? "queued"}`,
          ...reply.text.slice(-2_000).split("\n").filter(Boolean).slice(-6),
          ...reply.activity.split("\n").filter(Boolean),
        ]);
      } });
      slot.sessionId = accepted.sessionId;
      if (!signal.aborted && selected === slot) persist();
      if (signal.aborted) return;
      const work = awaitReply(slot, handle, accepted, ctx, signal);
      jobs.add(work); void work.finally(() => jobs.delete(work));
    }).catch(error => { if (!signal.aborted) notify(ctx, errorText(error), "error"); });
  }
  async function shutdown() {
    lifetime.abort();
    const currentHandles = handles; handles = new Map();
    await admission;
    await Promise.allSettled([...currentHandles.values()].map(async promise => (await promise).close()));
    await Promise.allSettled([...jobs]);
    pending.clear();
    if (context?.hasUI) { context.ui.setWidget("pi-bot-progress", undefined); context.ui.setStatus("pi-bot", undefined); }
    selected = undefined; context = undefined;
  }
  pi.registerFlag("bot", { type: "string", description: "Open a directory-defined bot in the interactive Pi UI (SDK-owned conversation)" });
  pi.on("session_start", async (_event, ctx) => {
    context = ctx; lifetime = new AbortController(); admission = Promise.resolve(); selected = undefined;
    const entry = [...ctx.sessionManager.getBranch()].reverse().find(entry => entry.type === "custom" && entry.customType === "bot.selection");
    if (entry?.type === "custom") {
      const data = entry.data as Partial<Selection> | undefined;
      if (data && typeof data.source === "string" && typeof data.name === "string") selected = { source: data.source, name: data.name, ...(typeof data.sessionId === "string" ? { sessionId: data.sessionId } : {}), ...(typeof data.tokenEnv === "string" ? { tokenEnv: data.tokenEnv } : {}) };
    }
    status();
    if (startup) {
      startup = false;
      const flag = pi.getFlag("bot");
      if (typeof flag === "string" && flag.trim()) {
        try {
          if (!ctx.hasUI) throw new Error("pi --bot requires an interactive UI. Use the standalone bot run/chat CLI for headless execution.");
          await select(flag.trim(), ctx);
        } catch (error) { startupError = errorText(error); notify(ctx, startupError, "error"); }
      }
    }
  });
  pi.on("session_shutdown", shutdown);
  pi.on("input", (event, ctx) => {
    if (startupError) { notify(ctx, `${startupError} /bot exit clears the selection.`, "error"); return { action: "handled" }; }
    if (!selected) return;
    if (!ctx.hasUI) { notify(ctx, "Direct /bot conversation mode requires an interactive Pi UI. Use the standalone bot run/chat CLI or the bot_run tool.", "error"); return { action: "handled" }; }
    if (event.images?.length) { notify(ctx, "Bot conversations currently accept text only.", "error"); return { action: "handled" }; }
    chat(event.text, selected, ctx);
    return { action: "handled" };
  });

  pi.registerTool({
    name: "bot_manage", label: "Bot manage",
    description: `List, inspect, create or edit directory-defined bots in ${root()}. Bots use Pi provider auth and have writable capabilities and durable memory. Create specialists when useful. Edit BOT.md via prompt/edits or a complete definition. skills are names, never paths: the bot's own skills/, then the workspace's .pi/skills or .agents/skills, then ~/.pi/agent/skills or ~/.agents/skills; missing names are skipped. Empty tools/skills means NONE; null restores discovery. Tool and persona changes activate automatically at a safe boundary. Deletion is human-only through /bot delete.`,
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("show"), Type.Literal("create"), Type.Literal("edit")]),
      name: Type.Optional(Type.String({ description: "Roster name or source directory (create takes a name)" })),
      description: Type.Optional(Type.String()), prompt: Type.Optional(Type.String()),
      model: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      thinking: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      inherit: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("global")])),
      tools: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
      excludeTools: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
      excludeExtensions: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
      excludeMcpServers: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
      builtinTools: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
      skills: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])), maintenance: Type.Optional(Type.Boolean()),
      edits: Type.Optional(Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() }))),
      definition: Type.Optional(Type.String()),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      if (params.action === "list") {
        const listing = await listBots(root());
        return { content: text([...listing.bots.map(bot => `${bot.name}: ${bot.description} (${bot.sourceDir})`), ...listing.errors].join("\n") || `No bots in ${root()}.`), details: listing };
      }
      if (!params.name) throw new Error(`${params.action} requires a name or source directory.`);
      const source = localRef(params.name, ctx.cwd);
      if (params.action === "show") {
        const info = await inspectBot(source);
        return { content: text(`${describe(info)}\n\n${await readFile(join(info.sourceDir, "BOT.md"), "utf8")}`), details: info };
      }
      if (params.action === "create") {
        if (params.thinking != null && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(params.thinking)) throw new Error("Invalid thinking level.");
        if (params.definition !== undefined || params.edits !== undefined) throw new Error("create accepts a persona and settings, not definition/edits.");
        const created = await createBot(params.name, { description: params.description, prompt: params.prompt, model: params.model ?? undefined, inherit: params.inherit }, root());
        const { tools, builtinTools, skills, maintenance, thinking, excludeTools, excludeExtensions, excludeMcpServers } = params;
        if ([tools, builtinTools, skills, maintenance, thinking, excludeTools, excludeExtensions, excludeMcpServers].some(value => value !== undefined)) await editBot(created.sourceDir, { tools, builtinTools, skills, maintenance, excludeTools, excludeExtensions, excludeMcpServers, thinking: thinking as ThinkingLevel | null | undefined });
        return { content: text(`Created ${params.name} at ${created.sourceDir}. Talk with /bot ${params.name}; delegate with bot_run.`), details: await inspectBot(created.sourceDir) };
      }
      const { action: _action, name: _name, thinking, ...patch } = params;
      if (!Object.values({ ...patch, thinking }).some(value => value !== undefined)) throw new Error("edit requires at least one change.");
      const result = await editBot(source, { ...patch, thinking: thinking as ThinkingLevel | null | undefined });
      return { content: text(`Edited ${result.sourceDir}/BOT.md. Valid changes activate at the next bot boundary without approval.`), details: result };
    },
  });
  pi.registerTool({
    name: "bot_run", label: "Bot run",
    description: "Delegate a self-contained request to a bot source directory, roster name, or daemon URL. Uses the bot SDK, not a child pi --bot process. The bot has its own tools, memory and durable conversation; it does not see this Pi conversation. Pass session to resume (or last); a resumed conversation keeps its workspace. Remote execution uses the server's workspace and Pi credentials. Daemon token is optional.",
    parameters: Type.Object({ bot: Type.String(), task: Type.String(), session: Type.Optional(Type.String()), cwd: Type.Optional(Type.String()), authTokenEnv: Type.Optional(Type.String({ description: "Optional environment variable containing a daemon token; never a provider credential" })) }),
    async execute(_id, params, signal, onUpdate, ctx) {
      if (remote(params.bot) && params.cwd !== undefined) throw new Error("A remote bot uses the server's workspace; cwd cannot be overridden.");
      const handle = await target(params.bot, ctx.cwd, params.authTokenEnv);
      const cwd = remote(params.bot) ? undefined : params.cwd ? resolve(ctx.cwd, expandHome(params.cwd)) : (!params.session || params.session === "new" || params.session === "last") ? ctx.cwd : undefined;
      const reply = createReplyPreview();
      const record = await handle.run(params.task, { session: params.session, ...(cwd ? { cwd } : {}), signal, onEvent: event => {
        reply.apply(event); const answer = reply.text.slice(-50_000);
        // Pi's tool renderer prefers details.output over content. Include activity there too,
        // while retaining answer-only text separately; the final result remains a BotRunRecord.
        const output = [reply.activity, answer].filter(Boolean).join("\n\n");
        onUpdate?.({ content: text(output || `${params.bot}: working…`), details: { bot: params.bot, output, answer, activity: reply.activity, event } });
      } });
      const body = record.output || record.error || "(no output)";
      const limited = body.length > 50_000 ? `${body.slice(0, 50_000)}\n[Output truncated; inspect run ${record.runId}.]` : body;
      const { usage } = record;
      return { content: text(`${limited}\n\n[${record.bot} · ${record.status} · session ${record.sessionId} · run ${record.runId}]`), details: record,
        ...(record.status === "completed" ? {} : { isError: true }),
        usage: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.cost } } };
    },
  });
  pi.registerCommand("bot", {
    description: "Talk to, resume or manage directory-defined bots (SDK-owned conversations)",
    getArgumentCompletions: async prefix => {
      const names = (await listBots(root())).bots.map(bot => bot.name);
      const values = ["list", "new", "resume", "info", "edit", "stop", "exit", "delete", "help", ...names].filter(value => value.startsWith(prefix));
      return values.length ? values.map(value => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      try {
        const [sub = "", ...rest] = args.trim().split(/\s+/); const arg = rest.join(" ");
        switch (sub) {
          case "help": notify(ctx, "/bot [name|directory|URL] — select a bot and route your text to its SDK conversation\n/bot new <name> — create a bot\n/bot resume [name|directory|URL] — choose a durable conversation\n/bot info [name] — capabilities and state\n/bot edit [name] — edit BOT.md\n/bot list — roster\n/bot stop — cancel this bot's pending chat requests\n/bot exit — return to ordinary Pi input\n/bot delete <name> — archive an idle bot after confirmation\nPi /model, /tree and /fork do not control SDK-owned bot conversations. Use bot run/chat from the shell for non-interactive or token-protected remote conversations."); return;
          case "": case "list": {
            const listing = await listBots(root());
            if (sub === "list" || !ctx.hasUI || !listing.bots.length) { notify(ctx, [...listing.bots.map(bot => `${bot.name}: ${bot.description}`), ...listing.errors].join("\n") || `No bots yet. /bot new <name> creates one.`); return; }
            const name = await ctx.ui.select("Talk to a bot", listing.bots.map(bot => bot.name));
            if (name) await select(name, ctx); return;
          }
          case "new": {
            if (!ctx.hasUI) throw new Error("Use bot init or bot_manage create without an interactive UI.");
            const name = arg || await ctx.ui.input("Bot name", "reviewer"); if (!name) return;
            const description = await ctx.ui.input("What does this bot do?", "Reviews code"); if (!description) return;
            const prompt = await ctx.ui.editor("Persona", `You are ${name}. ${description}\nImprove your own capabilities when useful.`); if (!prompt) return;
            const created = await createBot(name, { description, prompt }, root()); notify(ctx, `Created ${created.name} at ${created.sourceDir}. /bot ${name} starts a conversation.`); return;
          }
          case "exit": {
            const previous = selected;
            selected = undefined; startupError = undefined; persist(); if (ctx.hasUI) ctx.ui.setWidget("pi-bot-progress", undefined);
            await admission; // Do not close between accepting a prompt and recording its run.
            if (previous && ![...pending.values()].some(item => item.selection.source === previous.source)) {
              const key = `${previous.source}\n${previous.tokenEnv ?? ""}`, owned = handles.get(key);
              if (owned) { handles.delete(key); await (await owned).close(); }
            }
            notify(ctx, "Back to ordinary Pi input. Accepted bot work continues; results will appear here."); return;
          }
          case "stop": {
            const active = [...pending.values()].filter(item => item.selection === selected);
            await Promise.all(active.map(item => item.target.cancel(item.runId))); notify(ctx, active.length ? "Cancelled pending bot chat requests." : "No pending bot chat requests."); return;
          }
          case "info": {
            const ref = arg || selected?.source; if (!ref) throw new Error("Usage: /bot info <name|directory|URL>");
            const info = remote(ref) ? await (await target(ref, ctx.cwd)).info() : await inspectBot(localRef(ref, ctx.cwd)); notify(ctx, describe(info)); return;
          }
          case "resume": {
            if (!ctx.hasUI) throw new Error("Use bot run/chat --session without an interactive UI.");
            const ref = arg || selected?.source; if (!ref) throw new Error("Usage: /bot resume <name|directory|URL>");
            const handle = await target(ref, ctx.cwd), sessions = await handle.listSessions();
            if (!sessions.length) { notify(ctx, "No saved bot conversations."); return; }
            const labels = sessions.map(session => `${session.sessionId} · ${session.cwd} · ${session.title ?? ""}`);
            const chosen = await ctx.ui.select("Resume a bot conversation", labels); if (chosen) await select(ref, ctx, sessions[labels.indexOf(chosen)].sessionId); return;
          }
          case "edit": {
            if (!ctx.hasUI) throw new Error("Use bot_manage edit without an interactive UI.");
            const ref = arg || selected?.source; if (!ref || remote(ref)) throw new Error("/bot edit requires a local bot source.");
            const source = await resolveSource(localRef(ref, ctx.cwd)), current = await readFile(join(source, "BOT.md"), "utf8");
            const definition = await ctx.ui.editor(`Edit ${source}/BOT.md`, current); if (definition !== undefined && definition !== current) { await editBot(source, { definition }); notify(ctx, "Saved; valid changes reload automatically."); } return;
          }
          case "delete": {
            if (!ctx.hasUI || !arg || remote(arg)) throw new Error("Usage: /bot delete <local-name-or-directory> (interactive confirmation required)");
            const source = await resolveSource(localRef(arg, ctx.cwd));
            if (selected?.source === source) throw new Error("Exit this bot before archiving it.");
            if ([...pending.values()].some(item => item.selection.source === source)) throw new Error("Stop or finish this bot's pending work before archiving it.");
            const owned = handles.get(`${source}\n`);
            if (owned) { handles.delete(`${source}\n`); await (await owned).close(); }
            if (await ctx.ui.confirm(`Archive ${source}?`, "Moves the bot's source and colocated state into .archive. Close any running SDK instance first.")) notify(ctx, `Archived to ${await archiveBot(source)}.`); return;
          }
          default:
            if (!ctx.hasUI) throw new Error("Use the standalone bot run/chat CLI or bot_run tool without an interactive UI.");
            await select(args.trim(), ctx);
        }
      } catch (error) { notify(ctx, errorText(error), "error"); }
    },
  });
}
