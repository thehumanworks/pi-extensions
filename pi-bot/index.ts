import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, SessionManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  archiveBot, botForSessionDir, botPaths, botsRoot, createBot, expandHome, isInside, listBots, loadBot, parseBot, scaffoldHome,
  THINKING_LEVELS, updateBot, validateName, validateThinking, writeDefinition, type Bot, type ThinkingLevel,
} from "./src/bots.ts";
import { modelRef, resolveModel } from "./src/models.ts";
import { botSections, openTasks, rosterSection } from "./src/prompt.ts";
import { currentDepth, failed, MAX_DEPTH, runBot, type RunResult } from "./src/run.ts";
import { defaultSessionDir, describeSession, findSession, freshSessionFile, listSessions, sessionFileForId } from "./src/sessions.ts";

const EXTENSION_PATH = fileURLToPath(import.meta.url);
/** Granted to every bot, limited to its home when its tools allowlist omits them, so it can always keep its memory. */
const HOME_TOOLS = ["read", "write", "edit"];
const OUTPUT_LIMIT = 50_000;
const SUBCOMMANDS = ["list", "new", "edit", "info", "resume", "exit", "delete", "help"];

type Notify = Pick<ExtensionContext, "hasUI" | "ui">;
function notify(ctx: Notify, message: string, level: "info" | "warning" | "error" = "info") {
  if (ctx.hasUI) ctx.ui.notify(message, level); else process.stderr.write(`pi-bot: ${message}\n`);
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const isPathLike = (entry: string) => entry.includes("/") || entry.startsWith("~") || entry.startsWith(".");
const resolveFrom = (cwd: string, path: string) => resolve(cwd, expandHome(path.replace(/^@/, "")));
const samePath = (a: string | undefined, b: string) => !!a && resolve(a) === resolve(b);
const splitList = (text: string) => text.split(",").map(item => item.trim()).filter(Boolean);

export function matchTools(patterns: string[], names: string[]): { selected: string[]; unknown: string[] } {
  const selected: string[] = [], unknown: string[] = [];
  for (const pattern of patterns) {
    const regex = new RegExp(`^${pattern.split("*").map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    const hits = names.filter(name => regex.test(name));
    if (!hits.length) unknown.push(pattern);
    for (const hit of hits) if (!selected.includes(hit)) selected.push(hit);
  }
  return { selected, unknown };
}

export function allowedSkill(skill: { name: string; filePath: string }, bot: Bot, cwd: string): boolean {
  if (isInside(skill.filePath, bot.home) || !bot.skills) return true;
  return bot.skills.some(entry => isPathLike(entry) ? isInside(skill.filePath, resolveFrom(cwd, entry)) : entry === skill.name);
}

function personaTemplate(name: string, description: string): string {
  return `You are ${name}. ${description}

## Expertise
- 

## Standards
- 

## Working style
- 
`;
}

async function count(dir: string, filter: (name: string) => boolean = () => true): Promise<number> {
  try { return (await readdir(dir)).filter(name => !name.startsWith(".") && filter(name)).length; } catch { return 0; }
}

async function describeBot(bot: Bot): Promise<string> {
  const paths = botPaths(bot.home);
  const [memories, skills, scripts, sessions, tasks] = await Promise.all([
    count(paths.memory, name => name.endsWith(".md")), count(paths.skills), count(paths.scripts, name => name !== "README.md"),
    count(paths.sessions, name => name.endsWith(".jsonl")), openTasks(bot),
  ]);
  return [
    `${bot.name}: ${bot.description}`,
    `home: ${bot.home}`,
    `model: ${bot.model ?? "inherit"} · thinking: ${bot.thinking ?? "inherit"}`,
    `tools: ${bot.tools?.join(", ") ?? "session default"}`,
    `skills: ${bot.skills?.join(", ") ?? "all"} (+ its own skills/)`,
    `memories: ${memories} · skills: ${skills} · scripts: ${scripts} · open tasks: ${tasks.length} · sessions: ${sessions}`,
  ].join("\n");
}

function progressText(result: RunResult): string {
  return `${result.bot}: ${result.usage.turns} turn${result.usage.turns === 1 ? "" : "s"}, ${result.toolCalls} tool call${result.toolCalls === 1 ? "" : "s"}${result.output ? `\n\n${result.output}` : " (working…)"}`;
}

export default function piBot(pi: ExtensionAPI): void {
  let active: Bot | undefined;
  /** HOME_TOOLS added to the active bot's allowlist, and therefore limited to its home. */
  let homeOnly: string[] = [];

  pi.registerFlag("bot", { type: "string", description: "Run the session as this pi-bot (launch with `pi-bot <name>` to keep its history in the bot's home)" });

  async function applyModel(bot: Bot, ctx: ExtensionContext) {
    if (bot.model) {
      const model = resolveModel(ctx.modelRegistry, bot.model);
      const current = ctx.model ? modelRef(ctx.model) : "the default model";
      if (!model) notify(ctx, `${bot.name}: model "${bot.model}" was not found; using ${current}.`, "warning");
      else if (!(await pi.setModel(model))) notify(ctx, `${bot.name}: no credentials for ${modelRef(model)}; using ${current}.`, "warning");
    }
    if (bot.thinking) pi.setThinkingLevel(bot.thinking);
  }

  function applyTools(bot: Bot, ctx: ExtensionContext) {
    if (!bot.tools) return;
    const names = pi.getAllTools().map(tool => tool.name);
    const { selected, unknown } = matchTools(bot.tools, names);
    if (unknown.length) notify(ctx, `${bot.name}: no tools match ${unknown.join(", ")} from its allowlist.`, "warning");
    for (const tool of HOME_TOOLS) {
      if (!selected.includes(tool) && names.includes(tool)) { selected.push(tool); homeOnly.push(tool); }
    }
    // Every agent can create and edit bots, whatever its allowlist.
    if (!selected.includes("bot_manage") && names.includes("bot_manage")) selected.push("bot_manage");
    pi.setActiveTools(selected);
  }

  pi.on("session_start", async (event, ctx) => {
    active = undefined;
    homeOnly = [];
    const sessions = ctx.sessionManager, file = sessions.getSessionFile();
    let name = botForSessionDir(file ? dirname(file) : sessions.getSessionDir());
    const flag = pi.getFlag("bot");
    // --bot pins the startup session only; later session switches follow the session's location.
    const pinned = !name && typeof flag === "string" && !!flag.trim() && (event.reason === "startup" || event.reason === "reload");
    if (pinned) name = (flag as string).trim();
    if (!name) {
      if (ctx.hasUI) ctx.ui.setStatus("pi-bot", undefined);
      return;
    }
    try { active = await loadBot(name); }
    catch (error) {
      notify(ctx, errorText(error), "error");
      return;
    }
    await scaffoldHome(active.home);
    if (pinned && file) notify(ctx, `${name}: this conversation is saved in ${sessions.getSessionDir()}, not in the bot's home. Start with \`pi-bot ${name}\` or /bot ${name} to keep the history with the bot.`, "warning");
    const fresh = !sessions.getEntries().some(entry => entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant"));
    if (fresh) await applyModel(active, ctx);
    applyTools(active, ctx);
    if (ctx.hasUI) ctx.ui.setStatus("pi-bot", `bot: ${name}`);
  });

  pi.on("resources_discover", (_event, ctx) => {
    if (!active) return;
    const extra = (active.skills ?? []).filter(isPathLike).map(entry => resolveFrom(ctx.cwd, entry));
    const skillPaths = [botPaths(active.home).skills, ...extra].filter(path => existsSync(path));
    return skillPaths.length ? { skillPaths } : undefined;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const options = event.systemPromptOptions;
    if (active) {
      // Re-read BOT.md so persona edits apply on the next prompt; keep the last valid version on errors.
      try { active = await loadBot(active.name); }
      catch (error) { notify(ctx, `${active.name}: ${errorText(error)}`, "warning"); }
      const bot = active;
      Object.assign(options.sections, await botSections(bot, ctx.cwd, homeOnly));
      options.skills = options.skills.filter(skill => allowedSkill(skill, bot, ctx.cwd));
    }
    if (pi.getActiveTools().includes("bot_run")) {
      const others = (await listBots()).bots.filter(bot => bot.name !== active?.name);
      if (others.length) options.sections.bots = rosterSection(others);
    }
  });

  pi.on("tool_call", (event, ctx) => {
    if (!active || !homeOnly.includes(event.toolName)) return;
    const path = (event.input as { path?: unknown }).path;
    if (typeof path === "string" && isInside(resolveFrom(ctx.cwd, path), active.home)) return;
    return { block: true, reason: `${active.name} may use ${event.toolName} only inside its home (${active.home}); ${event.toolName} is not in its tools allowlist.` };
  });

  const normalizeModel = (registry: ExtensionContext["modelRegistry"], value: string | undefined): string | null | undefined => {
    if (value === undefined) return undefined;
    if (!value.trim() || value.trim() === "inherit") return null;
    const model = resolveModel(registry, value);
    if (!model) throw new Error(`Unknown or ambiguous model "${value}". Use provider/model-id as listed by \`pi --list-models\`.`);
    return modelRef(model);
  };
  const normalizeThinking = (value: string | undefined): ThinkingLevel | null | undefined =>
    value === undefined ? undefined : !value.trim() || value.trim() === "inherit" ? null : validateThinking(value.trim());

  pi.registerTool({
    name: "bot_manage",
    label: "Bot manage",
    description: `List, inspect, create or edit persistent pi-bots: custom agents with their own persona (system prompt), model, thinking level, optional tool and skill allowlists, and a home directory under ${botsRoot()}/<name>/ that holds their memory, skills, scripts, task state and conversation history.
Create a bot when the user asks for one, or when a reusable specialist would clearly help with recurring work. Write a focused persona covering the role, expertise, standards and working style; the persistence protocol for the home is added automatically.
edit changes only what you pass: description, model, thinking, tools, skills, and either prompt (full replacement) or edits (exact oldText/newText replacements in the persona; use show first to see the current text). Model or thinking "inherit" and an empty tools or skills list clear the setting. To rewrite BOT.md as a whole, including extra frontmatter, pass definition on its own.
This tool cannot delete bots; only the human can, with /bot delete. Use bot_run to delegate work to a bot.`,
    promptSnippet: "Create, edit, list and inspect persistent pi-bots",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("show"), Type.Literal("create"), Type.Literal("edit")]),
      name: Type.Optional(Type.String({ description: "Bot name: lowercase letters, digits, - or _" })),
      description: Type.Optional(Type.String({ description: "One-line job description, used when choosing whom to delegate to" })),
      prompt: Type.Optional(Type.String({ description: "Persona system prompt: role, expertise, standards, working style" })),
      model: Type.Optional(Type.String({ description: "provider/model-id, or \"inherit\" for the session model" })),
      thinking: Type.Optional(Type.String({ description: `Reasoning effort: ${THINKING_LEVELS.join(", ")}, or "inherit"` })),
      tools: Type.Optional(Type.Array(Type.String(), { description: "Tool allowlist (names or * globs); empty for the session's default tools" })),
      skills: Type.Optional(Type.Array(Type.String(), { description: "Shared skill allowlist (skill names or paths); empty for all skills. The bot's own skills always load" })),
      edits: Type.Optional(Type.Array(Type.Object({
        oldText: Type.String({ description: "Exact persona text to replace; must match once" }),
        newText: Type.String({ description: "Replacement text" }),
      }), { description: "For edit: targeted replacements in the persona, instead of a full prompt" })),
      definition: Type.Optional(Type.String({ description: "For edit: complete new BOT.md (frontmatter and persona); use without other fields" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.action === "list") {
        const { bots, errors } = await listBots();
        const lines = bots.map(bot => `- ${bot.name}: ${bot.description} (model: ${bot.model ?? "inherit"}, thinking: ${bot.thinking ?? "inherit"})`);
        const text = [bots.length ? `Bots in ${botsRoot()}:\n${lines.join("\n")}` : `No bots yet in ${botsRoot()}.`, ...errors.map(error => `Invalid: ${error}`)].join("\n");
        return { content: [{ type: "text", text }], details: { bots: bots.map(({ name, description, model, thinking, tools, skills, home }) => ({ name, description, model, thinking, tools, skills, home })), errors } };
      }
      if (!params.name) throw new Error(`${params.action} requires a bot name.`);
      if (params.action === "show") {
        const bot = await loadBot(params.name);
        const text = `${await describeBot(bot)}\n\n${bot.file}:\n${await readFile(bot.file, "utf8")}`;
        return { content: [{ type: "text", text }], details: { name: bot.name, home: bot.home } };
      }
      const fields = (["description", "prompt", "model", "thinking", "tools", "skills", "edits"] as const).filter(key => params[key] !== undefined);
      let bot: Bot;
      if (params.action === "create") {
        if (params.edits || params.definition !== undefined) throw new Error("create takes description, prompt and settings; edits and definition are for edit.");
        const model = normalizeModel(ctx.modelRegistry, params.model);
        const thinking = normalizeThinking(params.thinking);
        bot = await createBot({
          name: validateName(params.name), description: params.description ?? "", prompt: params.prompt ?? "",
          model: model ?? undefined, thinking: thinking ?? undefined,
          tools: params.tools?.length ? params.tools : undefined, skills: params.skills?.length ? params.skills : undefined,
        });
      } else if (params.definition !== undefined) {
        if (fields.length) throw new Error(`definition replaces BOT.md as a whole; do not combine it with ${fields.join(", ")}.`);
        const { model } = parseBot(params.definition, params.name);
        if (model && !resolveModel(ctx.modelRegistry, model)) throw new Error(`Unknown or ambiguous model "${model}" in definition; BOT.md was not changed.`);
        bot = await writeDefinition(params.name, params.definition);
      } else {
        if (!fields.length) throw new Error("edit needs at least one change: description, prompt, edits, model, thinking, tools, skills or definition.");
        bot = await updateBot(params.name, {
          description: params.description, prompt: params.prompt, edits: params.edits,
          model: normalizeModel(ctx.modelRegistry, params.model), thinking: normalizeThinking(params.thinking), tools: params.tools, skills: params.skills,
        });
      }
      const unknown = matchTools((bot.tools ?? []).filter(tool => !tool.includes("*")), pi.getAllTools().map(tool => tool.name)).unknown;
      const lines = [
        `${params.action === "create" ? "Created" : "Edited"} bot ${bot.name}.`,
        await describeBot(bot),
        ...(unknown.length ? [`Warning: no loaded tool is named ${unknown.join(", ")}; the bot will not have it unless an extension or MCP server provides it.`] : []),
        params.action === "create"
          ? `The human can talk to it with /bot ${bot.name}; delegate to it with bot_run.`
          : "Persona and skill-name changes apply on the bot's next prompt; model, thinking, tool and skill-path changes apply to its new conversations.",
      ];
      return { content: [{ type: "text", text: lines.join("\n") }], details: { name: bot.name, home: bot.home } };
    },
  });

  pi.registerTool({
    name: "bot_run",
    label: "Bot run",
    description: `Delegate a task to a persistent pi-bot. The bot runs as a separate Pi agent in the working directory with its own persona, model, tools, skills and memory, and saves the conversation in its home.
It does not see this conversation, so write a self-contained task with the needed context and the expected result.
Returns the bot's final answer and a session id. Pass that id as session to continue the same conversation, or "last" to continue its latest conversation in this directory.`,
    promptSnippet: "Delegate a self-contained task to a persistent pi-bot",
    parameters: Type.Object({
      bot: Type.String({ description: "Bot name" }),
      task: Type.String({ description: "Self-contained task, with context and the expected result" }),
      session: Type.Optional(Type.String({ description: "\"new\" (default), \"last\", or a session id returned by an earlier bot_run" })),
      cwd: Type.Optional(Type.String({ description: "Working directory (default: the current one)" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const depth = currentDepth();
      if (depth >= MAX_DEPTH) throw new Error(`Bot delegation is already ${depth} levels deep; do this work directly instead of delegating further.`);
      const bot = await loadBot(params.bot);
      const cwd = params.cwd ? resolveFrom(ctx.cwd, params.cwd) : ctx.cwd;
      const sessionsDir = botPaths(bot.home).sessions;
      await mkdir(sessionsDir, { recursive: true });
      let session: { path: string; fork: boolean } | undefined;
      const ref = params.session?.trim();
      if (ref && ref !== "new") {
        const sessions = await listSessions(sessionsDir);
        const found = ref === "last" ? sessions.find(s => samePath(s.cwd, cwd)) : findSession(sessions, ref);
        if (!found && ref !== "last") throw new Error(`Bot ${bot.name} has no session "${ref}".`);
        // A session from another directory is forked so the bot keeps its history but works here.
        if (found) session = { path: found.path, fork: !samePath(found.cwd, cwd) };
      }
      const result = await runBot({
        bot: bot.name, task: params.task, cwd, sessionsDir, extension: EXTENSION_PATH, session, depth, signal,
        onProgress: progress => onUpdate?.({ content: [{ type: "text", text: progressText(progress) }], details: { ...progress } }),
      });
      if (result.aborted) throw new Error(`bot_run ${bot.name} was aborted.`);
      if (result.sessionId) result.sessionFile = await sessionFileForId(sessionsDir, result.sessionId);
      const body = failed(result)
        ? `Bot ${bot.name} failed${result.stopReason ? ` (${result.stopReason})` : ` (exit ${result.exitCode})`}: ${result.errorMessage || result.stderr.trim().slice(-2_000) || result.output || "(no output)"}`
        : result.output || "(no output)";
      const output = body.length > OUTPUT_LIMIT ? `${body.slice(0, OUTPUT_LIMIT)}\n\n[Output truncated; the full transcript is in ${result.sessionFile ?? sessionsDir}.]` : body;
      const footer = result.sessionId
        ? `[${bot.name} · session ${result.sessionId} · ${result.usage.turns} turns${result.model ? ` · ${result.model}` : ""}] Continue this conversation with bot_run session "${result.sessionId}".`
        : `[${bot.name} · no session recorded]`;
      const { usage } = result;
      return {
        content: [{ type: "text", text: `${output}\n\n${footer}` }],
        details: result,
        usage: {
          input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite,
          totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.cost },
        },
        ...(failed(result) ? { isError: true } : {}),
      };
    },
    renderCall(args, theme) {
      const task = (args.task ?? "").replace(/\s+/g, " ");
      const session = args.session && args.session !== "new" ? theme.fg("muted", ` [${args.session}]`) : "";
      return new Text(`${theme.fg("toolTitle", theme.bold("bot_run "))}${theme.fg("accent", args.bot ?? "…")}${session}\n  ${theme.fg("dim", task.length > 100 ? `${task.slice(0, 100)}…` : task)}`, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as RunResult | undefined;
      const fallback = result.content[0]?.type === "text" ? result.content[0].text : "";
      if (!details?.bot) return new Text(fallback, 0, 0);
      const icon = isPartial ? theme.fg("warning", "⏳") : failed(details) ? theme.fg("error", "✗") : theme.fg("success", "✓");
      const stats = `${details.usage.turns} turns · ${details.toolCalls} tool calls${details.model ? ` · ${details.model}` : ""}${details.usage.cost ? ` · $${details.usage.cost.toFixed(4)}` : ""}`;
      const body = (failed(details) && !isPartial ? details.errorMessage || details.stderr.trim() || details.output : details.output) || (isPartial ? "(working…)" : "(no output)");
      const lines = body.split("\n");
      const shown = expanded ? body : lines.slice(0, 8).join("\n") + (lines.length > 8 ? `\n${theme.fg("muted", `… ${lines.length - 8} more lines (Ctrl+O to expand)`)}` : "");
      const session = details.sessionId ? theme.fg("dim", `\nsession ${details.sessionId}`) : "";
      return new Text(`${icon} ${theme.fg("toolTitle", theme.bold(details.bot))} ${theme.fg("dim", stats)}\n${theme.fg("toolOutput", shown)}${session}`, 0, 0);
    },
  });

  async function startSession(ctx: ExtensionCommandContext, bot: Bot) {
    const dir = botPaths(bot.home).sessions;
    const path = await freshSessionFile(dir, ctx.cwd);
    await ctx.switchSession(path, {
      withSession: async next => { next.ui.notify(`Talking to ${bot.name}. The conversation is saved in ${dir}.`, "info"); },
    });
  }

  async function resumeSession(ctx: ExtensionCommandContext, bot: Bot) {
    const dir = botPaths(bot.home).sessions;
    const sessions = await listSessions(dir);
    if (!sessions.length) {
      ctx.ui.notify(`${bot.name} has no conversations yet. Start one with /bot ${bot.name}.`, "info");
      return;
    }
    let chosen = sessions[0]!;
    if (ctx.hasUI) {
      const labels = sessions.map(describeSession);
      const label = await ctx.ui.select(`Resume a conversation with ${bot.name}`, labels);
      if (label === undefined) return;
      chosen = sessions[labels.indexOf(label)]!;
    }
    let path = chosen.path;
    if (!samePath(chosen.cwd, ctx.cwd)) {
      const fork = `Continue here, in ${ctx.cwd} (copies the history)`, open = `Open in its original directory, ${chosen.cwd}`;
      const choice = ctx.hasUI && chosen.cwd && existsSync(chosen.cwd) ? await ctx.ui.select(`That conversation ran in ${chosen.cwd}`, [fork, open]) : fork;
      if (choice === undefined) return;
      if (choice === fork) path = SessionManager.forkFrom(chosen.path, ctx.cwd, dir).getSessionFile() ?? chosen.path;
    }
    await ctx.switchSession(path, { withSession: async next => { next.ui.notify(`Resumed a conversation with ${bot.name}.`, "info"); } });
  }

  async function newBot(ctx: ExtensionCommandContext, initialName: string) {
    if (!ctx.hasUI) throw new Error("/bot new needs an interactive UI. Ask the agent to create the bot with bot_manage instead.");
    const name = (initialName || (await ctx.ui.input("Bot name", "lowercase, e.g. reviewer")) || "").trim();
    if (!name) return;
    validateName(name);
    if (existsSync(botPaths(resolve(botsRoot(), name)).definition)) throw new Error(`Bot ${name} already exists. Edit it with /bot edit ${name}.`);
    const description = (await ctx.ui.input(`What is ${name}'s job?`, "one line, e.g. Reviews diffs for security and correctness"))?.trim();
    if (!description) return;
    let model: string | undefined;
    for (;;) {
      const answer = await ctx.ui.input("Model (provider/model-id; leave blank to use the session model)", ctx.model ? modelRef(ctx.model) : "");
      if (answer === undefined) return;
      if (!answer.trim()) break;
      const resolved = resolveModel(ctx.modelRegistry, answer);
      if (resolved) { model = modelRef(resolved); break; }
      ctx.ui.notify(`Unknown or ambiguous model "${answer}".`, "warning");
    }
    const level = await ctx.ui.select("Thinking level (reasoning effort)", ["inherit", ...THINKING_LEVELS]);
    if (level === undefined) return;
    const tools = await ctx.ui.input("Tool allowlist (comma-separated; leave blank for the default tools)", pi.getActiveTools().join(", "));
    if (tools === undefined) return;
    const skills = await ctx.ui.input("Skill allowlist (comma-separated names or paths; leave blank for all skills)", "");
    if (skills === undefined) return;
    const prompt = await ctx.ui.editor(`Persona for ${name} (system prompt)`, personaTemplate(name, description));
    if (!prompt?.trim()) return;
    const bot = await createBot({
      name, description, prompt, model, thinking: level === "inherit" ? undefined : level as ThinkingLevel,
      tools: splitList(tools).length ? splitList(tools) : undefined, skills: splitList(skills).length ? splitList(skills) : undefined,
    });
    ctx.ui.notify(`Created ${bot.name} at ${bot.home}.`, "info");
    if (await ctx.ui.confirm(`Talk to ${bot.name} now?`, "Starts a new conversation with the bot in this directory.")) await startSession(ctx, bot);
  }

  async function exitBot(ctx: ExtensionCommandContext) {
    if (!active) {
      ctx.ui.notify("This session is not a bot session.", "info");
      return;
    }
    const dir = defaultSessionDir(ctx.cwd, getAgentDir(), pi.getSettings().sessionDir);
    const path = await freshSessionFile(dir, ctx.cwd);
    await ctx.switchSession(path);
  }

  async function command(args: string, ctx: ExtensionCommandContext) {
    const [sub = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
    const arg = rest.join(" ");
    const named = (usage: string) => {
      const name = arg || active?.name;
      if (!name) throw new Error(`Usage: /bot ${usage} <name>`);
      return loadBot(name);
    };
    switch (sub) {
      case "help":
        ctx.ui.notify(`/bot — list bots and pick one to talk to
/bot <name> — start a new conversation with a bot in this directory
/bot resume [name] — continue one of the bot's conversations
/bot new [name] — create a bot step by step (or ask the agent to create one)
/bot edit [name] — edit BOT.md: persona, model, thinking, tools, skills
/bot info [name] — show a bot's home, settings and state
/bot exit — leave the bot and start a normal session
/bot delete <name> — archive a bot's home
Bots live in ${botsRoot()}. From a shell: pi-bot <name> [pi options].`, "info");
        return;
      case "":
      case "list": {
        const { bots, errors } = await listBots();
        if (!bots.length) {
          ctx.ui.notify(`No bots yet. Create one with /bot new, or ask the agent to create one.${errors.length ? `\nInvalid: ${errors.join("; ")}` : ""}`, "info");
          return;
        }
        if (sub === "" && ctx.hasUI) {
          const labels = bots.map(bot => `${bot.name} — ${bot.description}`);
          const label = await ctx.ui.select("Talk to a bot", labels);
          if (label !== undefined) await startSession(ctx, bots[labels.indexOf(label)]!);
          return;
        }
        ctx.ui.notify([...bots.map(bot => `${bot.name} — ${bot.description}`), ...errors.map(error => `Invalid: ${error}`)].join("\n"), "info");
        return;
      }
      case "new":
      case "create":
        await newBot(ctx, arg);
        return;
      case "edit": {
        if (!ctx.hasUI) throw new Error("/bot edit needs an interactive UI.");
        const bot = await named("edit");
        const current = await readFile(bot.file, "utf8");
        const edited = await ctx.ui.editor(`Edit ${bot.file}`, current);
        if (edited === undefined || edited === current) return;
        await writeDefinition(bot.name, edited);
        ctx.ui.notify(`Saved ${bot.name}. Persona changes apply on the next prompt; model, thinking, tools and skill paths apply to new sessions.`, "info");
        return;
      }
      case "info":
      case "show":
        ctx.ui.notify(await describeBot(await named("info")), "info");
        return;
      case "resume":
        await resumeSession(ctx, await named("resume"));
        return;
      case "exit":
        await exitBot(ctx);
        return;
      case "delete": {
        if (!arg) throw new Error("Usage: /bot delete <name>");
        const bot = await loadBot(arg);
        if (active?.name === bot.name) throw new Error(`Leave ${bot.name} first with /bot exit.`);
        if (!ctx.hasUI) throw new Error("/bot delete needs an interactive UI to confirm.");
        if (!(await ctx.ui.confirm(`Archive ${bot.name}?`, `Moves ${bot.home} (memory, skills, scripts and history) to ${botsRoot()}/.archive/.`))) return;
        ctx.ui.notify(`Archived ${bot.name} to ${await archiveBot(bot.name)}.`, "info");
        return;
      }
      default:
        if (rest.length) throw new Error(`Unknown /bot command "${sub}". Run /bot help.`);
        await startSession(ctx, await loadBot(sub));
    }
  }

  pi.registerCommand("bot", {
    description: "Talk to, create, resume or manage persistent pi-bots",
    getArgumentCompletions: async prefix => {
      const parts = prefix.trimStart().split(/\s+/);
      const names = (await listBots().catch(() => ({ bots: [] as Bot[] }))).bots.map(bot => bot.name);
      if (parts.length <= 1) {
        const items = [...SUBCOMMANDS, ...names].filter(value => value.startsWith(parts[0] ?? ""));
        return items.length ? items.map(value => ({ value, label: value, description: SUBCOMMANDS.includes(value) ? undefined : "start a conversation" })) : null;
      }
      if (parts.length === 2 && ["resume", "edit", "info", "delete"].includes(parts[0]!)) {
        const items = names.filter(name => name.startsWith(parts[1]!));
        return items.length ? items.map(name => ({ value: `${parts[0]} ${name}`, label: name })) : null;
      }
      return null;
    },
    handler: async (args, ctx) => {
      try { await command(args, ctx); }
      catch (error) { ctx.ui.notify(errorText(error), "error"); }
    },
  });
}
