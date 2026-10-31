import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  getAgentDir, getDocsPath, getMarkdownTheme, parseFrontmatter, SessionManager, SettingsManager,
  type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

/**
 * A bot is a directory that Pi runs in. The body of its BOT.md is the system prompt; its settings,
 * extensions, skills, context files and sessions are ordinary Pi project behaviour for that directory.
 */

const EXTENSION_PATH = fileURLToPath(import.meta.url);
const NAME = /^[a-z0-9][a-z0-9_-]*$/;
const SUBCOMMANDS = ["list", "new", "edit", "exit", "reload", "help"];
const MAX_DEPTH = 3;
const OUTPUT_LIMIT = 50_000;
const HELP = `/bot — pick a bot to talk to
/bot <name> — continue the bot's latest session in its home
/bot list | new [name] | edit [name] | exit | reload
pi --bot <name> — start Pi as the bot, continuing its latest session

A bot session is a normal Pi session whose working directory is the bot's home; /new starts a fresh one there. BOT.md's body is its system prompt; .pi/ in the home holds its settings, extensions and skills.`;

type Input = string | (TextContent | ImageContent)[];

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const expandHome = (path: string) => path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
const samePath = (a: string, b: string) => resolve(a) === resolve(b);
function notify(ctx: Pick<ExtensionContext, "hasUI" | "ui">, message: string, level: "info" | "warning" | "error" = "info") {
  if (ctx.hasUI) ctx.ui.notify(message, level); else process.stderr.write(`pi-bot: ${message}\n`);
}

export interface Bot { name: string; description: string; home: string; prompt: string }

export const botsRoot = () => resolve(expandHome(process.env.PI_BOT_HOME || join(getAgentDir(), "bots")));

function checkName(name: string): void {
  if (!NAME.test(name) || SUBCOMMANDS.includes(name)) {
    throw new Error(`"${name}" cannot be a bot name: use lowercase letters, digits, "-" and "_", and none of ${SUBCOMMANDS.join(", ")}.`);
  }
}

export async function loadBot(name: string): Promise<Bot> {
  if (!NAME.test(name)) throw new Error(`"${name}" is not a bot name.`);
  const home = join(botsRoot(), name), file = join(home, "BOT.md");
  if (!existsSync(file)) throw new Error(`No bot named "${name}": ${file} does not exist. Create it with /bot new ${name}.`);
  const { frontmatter, body } = parseFrontmatter(await readFile(file, "utf8"));
  const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
  return { name, home, description, prompt: body.trim() };
}

/** The bot whose home is `cwd`, if any. */
export function botAt(cwd: string): string | undefined {
  const name = relative(botsRoot(), resolve(cwd));
  return NAME.test(name) && existsSync(join(cwd, "BOT.md")) ? name : undefined;
}

export async function listBots(): Promise<{ bots: Bot[]; errors: string[] }> {
  const entries = await readdir(botsRoot(), { withFileTypes: true }).catch(() => []);
  const bots: Bot[] = [], errors: string[] = [];
  for (const entry of entries.filter(entry => entry.isDirectory() && NAME.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!existsSync(join(botsRoot(), entry.name, "BOT.md"))) continue;
    try { bots.push(await loadBot(entry.name)); } catch (error) { errors.push(`${entry.name}: ${errorText(error)}`); }
  }
  return { bots, errors };
}

export async function createBot(name: string, description: string, prompt: string): Promise<Bot> {
  checkName(name);
  if (!description.trim()) throw new Error("A bot needs a one-line description.");
  const home = join(botsRoot(), name);
  if (existsSync(home)) throw new Error(`${home} already exists.`);
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "BOT.md"), `---\ndescription: ${JSON.stringify(description.trim())}\n---\n\n${prompt.trim()}\n`, { flag: "wx" });
  return loadBot(name);
}

/** Where Pi keeps sessions for `cwd`: the configured session directory, else Pi's per-directory default. */
function sessionDir(cwd: string): string | undefined {
  const dir = process.env.PI_CODING_AGENT_SESSION_DIR || SettingsManager.create(cwd, getAgentDir()).getSessionDir();
  return dir ? resolve(expandHome(dir)) : undefined;
}

/**
 * A session file for `cwd`: its latest session when resuming, else a new one. Pi opens a missing
 * file in its own process directory and only writes it after the first reply, so a new session
 * elsewhere gets its header now. The session_shutdown handler removes it if no message followed.
 */
export async function sessionFile(cwd: string, resume: boolean): Promise<string> {
  const dir = sessionDir(cwd);
  const sessions = resume ? SessionManager.continueRecent(cwd, dir) : SessionManager.create(cwd, dir);
  const file = sessions.getSessionFile()!;
  if (!existsSync(file) && !samePath(cwd, process.cwd())) await writeFile(file, `${JSON.stringify(sessions.getHeader())}\n`, { flag: "wx" });
  return file;
}

function botSection(bot: Bot, sessions: string): string {
  const started = samePath(process.cwd(), bot.home) ? "" : ` The user started Pi in ${process.cwd()}.`;
  return [
    `You are the bot "${bot.name}". Your home, ${bot.home}, is your working directory in every session; work on other directories through absolute paths.${started}`,
    ...(sessions ? [`Your conversations are Pi session files (JSONL) in ${sessions}. Search them when asked about an earlier conversation.`] : []),
    `Your instructions are the body of ${join(bot.home, "BOT.md")}, whose frontmatter description says what you do. Edit it to change how you work; edits apply from your next turn.`,
    `Your environment is the Pi project in your home: AGENTS.md for standing context, .pi/settings.json (for example defaultProvider, defaultModel, defaultThinkingLevel, defaultTools), .pi/extensions/, .pi/skills/, .pi/prompts/ and .pi/mcp.json. They load in each new session; after changing them, call bot_reload. Read ${getDocsPath()}/configuration.md, settings.md, extensions.md and skills.md before changing them.`,
    `Other bots are directories in ${botsRoot()}. List or create them with bot_manage; delegate a self-contained task to one with bot_run.`,
  ].join("\n");
}

export interface RunResult {
  bot: string;
  home: string;
  sessionId?: string;
  /** Text of the last finished reply. */
  output: string;
  /** Text of the reply being generated. */
  live: string;
  /** The latest tool call. */
  activity: string;
  turns: number;
  cost: number;
  stopReason?: string;
  errorMessage?: string;
  stderr: string;
  exitCode: number;
}

const depth = () => Number.parseInt(process.env.PI_BOT_DEPTH ?? "", 10) || 0;
const textOf = (message: { content?: unknown }) => typeof message.content === "string" ? message.content
  : Array.isArray(message.content) ? message.content.filter(part => part?.type === "text").map(part => part.text).join("\n").trim() : "";
function brief(args: unknown): string {
  const values = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const key = ["command", "path", "pattern", "query", "url", "bot"].find(key => typeof values[key] === "string");
  return (key ? String(values[key]) : JSON.stringify(args ?? "")).replace(/\s+/g, " ").slice(0, 120);
}

/** How to start the Pi that is running this extension: its script under node or bun, or a compiled binary. */
function piCommand(): [string, string[]] {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/") && /\.[cm]?[jt]s$/.test(script) && existsSync(script)) return [process.execPath, [script]];
  return /^(node|bun)(\.exe)?$/i.test(basename(process.execPath)) ? ["pi", []] : [process.execPath, []];
}

/** Whether Pi got this extension from -e rather than from settings, in which case a child Pi needs it too. */
const explicitlyLoaded = () => process.argv.some((arg, index) =>
  ["-e", "--extension"].includes(process.argv[index - 1]) && [EXTENSION_PATH, dirname(EXTENSION_PATH)].includes(resolve(arg)));

/** Run one task as `pi --mode json` in the bot's home and collect its reply. */
export function runBot(bot: Bot, task: string, options: { session?: string; signal?: AbortSignal; onProgress?: (result: RunResult) => void } = {}): Promise<RunResult> {
  const result: RunResult = { bot: bot.name, home: bot.home, output: "", live: "", activity: "", turns: 0, cost: 0, stderr: "", exitCode: -1 };
  const [command, prefix] = piCommand();
  const args = [...prefix, "--mode", "json", ...(explicitlyLoaded() ? ["-e", EXTENSION_PATH] : []),
    ...(options.session === "last" ? ["--continue"] : options.session ? ["--session", options.session] : []), "--", task];
  // JSON mode frames records with LF only; readline would also split on Unicode line separators.
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  const record = (line: string) => {
    let event: any;
    try { event = JSON.parse(line); } catch { return; }
    if (event.type === "session") result.sessionId = event.id;
    else if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") result.live += event.assistantMessageEvent.delta ?? "";
    else if (event.type === "tool_execution_start") result.activity = `${event.toolName} ${brief(event.args)}`;
    else if (event.type === "message_end" && event.message?.role === "assistant") {
      const message = event.message;
      result.turns++;
      result.cost += message.usage?.cost?.total ?? 0;
      result.stopReason = message.stopReason;
      result.errorMessage = message.errorMessage;
      result.output = textOf(message) || result.output;
      result.live = "";
    } else return;
    options.onProgress?.(result);
  };
  return new Promise(done => {
    const child = spawn(command, args, { cwd: bot.home, env: { ...process.env, PI_BOT_DEPTH: String(depth() + 1) }, stdio: ["ignore", "pipe", "pipe"] });
    let killTimer: NodeJS.Timeout | undefined;
    const abort = () => { child.kill("SIGTERM"); killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000); };
    if (options.signal?.aborted) abort(); else options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", chunk => {
      buffer += decoder.write(chunk);
      for (let index; (index = buffer.indexOf("\n")) >= 0; buffer = buffer.slice(index + 1)) record(buffer.slice(0, index).replace(/\r$/, ""));
    });
    child.stderr.on("data", chunk => { result.stderr = (result.stderr + chunk).slice(-8_000); });
    let finished = false;
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      record(buffer + decoder.end());
      result.exitCode = code;
      done(result);
    };
    child.on("error", error => { result.stderr += `\n${error.message}`; finish(1); });
    child.on("close", code => finish(code ?? 1));
  });
}

export default function piBot(pi: ExtensionAPI): void {
  /** Set while `--bot` waits to leave the startup directory; input is held for the bot's session. */
  let starting: { name: string; scheduled: boolean; inputs: Input[] } | undefined;
  /** Why this session refuses input: a bot requested at startup could not be opened. */
  let blocked: string | undefined;
  /** The last BOT.md that parsed, so a broken edit does not drop the bot's instructions. */
  let lastGood: Bot | undefined;
  let reloadRegistered = false;

  pi.registerFlag("bot", { type: "string", description: "Start as this bot: a Pi session in the bot's home directory" });

  // Bot homes hold the bot's own extensions and settings; a headless bot_run cannot answer a trust prompt.
  pi.on("project_trust", event => ({ trusted: botAt(event.cwd) ? "yes" : "undecided" }));

  pi.on("session_start", async (event, ctx) => {
    const current = botAt(ctx.cwd);
    if (ctx.hasUI) ctx.ui.setStatus("pi-bot", current ? `bot: ${current}` : undefined);
    if (current) registerReload();
    const flag = pi.getFlag("bot");
    if (event.reason !== "startup" || typeof flag !== "string" || !flag.trim()) return;
    try {
      const bot = await loadBot(flag.trim());
      const inHome = samePath(ctx.cwd, bot.home);
      // Continue the bot's latest conversation, unless Pi already opened one there (-c, -r, --session).
      if (inHome && (!ctx.hasUI || ctx.sessionManager.getEntries().some(entry => entry.type === "message"))) return;
      if (!ctx.hasUI) throw new Error(`--bot cannot move a print or JSON run into ${bot.name}'s home. Run it from there: cd ${bot.home} && pi -p "…"`);
      starting = { name: bot.name, scheduled: false, inputs: [] };
    } catch (error) {
      blocked = errorText(error);
      notify(ctx, blocked, "error");
      if (!ctx.hasUI) process.exit(1);
    }
  });

  pi.on("session_shutdown", async (event, ctx) => {
    // Pi never writes a session without messages; only sessionFile() does, ahead of the first reply.
    const file = ctx.sessionManager.getSessionFile();
    if (event.reason === "reload" || !file || samePath(ctx.cwd, process.cwd())) return;
    if (!ctx.sessionManager.getEntries().some(entry => entry.type === "message")) await rm(file, { force: true });
  });

  pi.on("resources_discover", () => {
    if (!starting || starting.scheduled) return;
    starting.scheduled = true;
    // This runs after every extension's session_start. Session replacement is a command-only
    // operation, so the startup session is replaced through the /bot command.
    const command = `/bot ${starting.name}`;
    setTimeout(() => pi.sendUserMessage(command, { expandPromptTemplates: true }));
  });

  pi.on("input", (event, ctx) => {
    if (blocked) {
      notify(ctx, blocked, "error");
      return { action: "handled" };
    }
    if (!starting) return;
    starting.inputs.push(event.images?.length ? [{ type: "text", text: event.text }, ...event.images] : event.text);
    return { action: "handled" };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const name = botAt(ctx.cwd);
    if (!name) return;
    // Re-read BOT.md on every run, so a bot's edits to its own instructions apply on its next turn.
    try { lastGood = await loadBot(name); } catch (error) { notify(ctx, `${name}: ${errorText(error)}`, "warning"); }
    if (lastGood?.name !== name) return;
    const options = event.systemPromptOptions;
    if (lastGood.prompt) options.customPrompt = lastGood.prompt;
    options.sections.bot = botSection(lastGood, ctx.sessionManager.getSessionDir());
  });

  /** Replace this session with a session in `cwd`, then send held input to it. */
  async function enter(ctx: ExtensionCommandContext, cwd: string, resume: boolean, inputs: Input[] = []): Promise<void> {
    const file = await sessionFile(cwd, resume);
    const { cancelled } = await ctx.switchSession(file, {
      withSession: async next => { for (const input of inputs) await next.sendUserMessage(input, { deliverAs: "followUp" }); },
    });
    if (cancelled) throw new Error("Another extension cancelled the session switch.");
  }

  async function pick(ctx: ExtensionCommandContext): Promise<void> {
    const { bots } = await listBots();
    if (!bots.length) return notify(ctx, `There are no bots in ${botsRoot()}. Create one with /bot new <name>.`, "warning");
    const labels = bots.map(bot => `${bot.name} — ${bot.description || "(no description)"}`);
    const choice = await ctx.ui.select("Talk to which bot?", labels);
    if (choice) await enter(ctx, bots[labels.indexOf(choice)].home, true);
  }

  async function list(ctx: ExtensionCommandContext): Promise<void> {
    const { bots, errors } = await listBots();
    const lines = bots.map(bot => `${bot.name} — ${bot.description || "(no description)"}\n  ${bot.home}`);
    notify(ctx, [`Bots in ${botsRoot()}:`, ...(lines.length ? lines : ["(none)"]), ...errors.map(error => `invalid: ${error}`)].join("\n"));
  }

  async function create(name: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
    name ||= (await ctx.ui.input("Bot name", "lowercase letters, digits, - and _"))?.trim();
    if (!name) return;
    checkName(name);
    const description = (await ctx.ui.input(`What does ${name} do?`, "One line, shown when choosing a bot"))?.trim();
    if (!description) return;
    const prompt = await ctx.ui.editor(`System prompt for ${name}`, `You are ${name}. ${description}\n`);
    if (prompt === undefined) return;
    const bot = await createBot(name, description, prompt);
    if (await ctx.ui.confirm(`Created ${bot.name}`, `Its home is ${bot.home}. Start a session with it now?`)) await enter(ctx, bot.home, false);
  }

  async function edit(name: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
    name ||= botAt(ctx.cwd);
    if (!name) throw new Error("Usage: /bot edit <name>");
    const file = join((await loadBot(name)).home, "BOT.md");
    const text = await ctx.ui.editor(file, await readFile(file, "utf8"));
    if (text === undefined) return;
    await writeFile(file, text);
    await loadBot(name);
    notify(ctx, `Saved ${file}.${botAt(ctx.cwd) === name ? " It applies from the next turn." : ""}`);
  }

  async function exit(ctx: ExtensionCommandContext): Promise<void> {
    if (!botAt(ctx.cwd)) return notify(ctx, "This is not a bot session.", "warning");
    if (samePath(process.cwd(), ctx.cwd)) return notify(ctx, "Pi started in this bot's home; use /resume to open another session.", "warning");
    await enter(ctx, process.cwd(), false);
  }

  pi.registerCommand("bot", {
    description: "Talk to a bot (a Pi session in its home directory), or list, create or edit bots",
    getArgumentCompletions: async prefix => {
      const { bots } = await listBots();
      const items = [...bots.map(bot => ({ value: bot.name, label: bot.name, description: bot.description })), ...SUBCOMMANDS.map(value => ({ value, label: value }))];
      return items.filter(item => item.value.startsWith(prefix.trim()));
    },
    handler: async (args, ctx) => {
      const [sub = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      try {
        if (sub === "list") return await list(ctx);
        if (sub === "help") return notify(ctx, HELP);
        if (sub === "reload") {
          // bot_reload queues this during the bot's own turn; reloading needs an idle session.
          await ctx.waitForIdle();
          return await ctx.reload();
        }
        if (!ctx.hasUI) throw new Error(`/bot ${sub} needs an interactive UI.`);
        if (sub === "") return await pick(ctx);
        if (sub === "new") return await create(rest[0], ctx);
        if (sub === "edit") return await edit(rest[0], ctx);
        if (sub === "exit") return await exit(ctx);
        const bot = await loadBot(sub);
        await enter(ctx, bot.home, true, starting?.inputs);
      } catch (error) {
        const message = starting ? `Could not start ${starting.name}: ${errorText(error)}` : errorText(error);
        // A failed startup switch must not let held or later input reach Pi outside the bot.
        if (starting) { blocked = message; starting = undefined; }
        notify(ctx, message, "error");
      }
    },
  });

  /** Only bot sessions get bot_reload: it lets a bot load the environment it just changed. */
  function registerReload(): void {
    if (reloadRegistered) return;
    reloadRegistered = true;
    pi.registerTool({
      name: "bot_reload",
      label: "Bot reload",
      description: "Reload your Pi environment (extensions, skills, prompts, settings and context files in your home) after changing it. The reload runs when your current turn ends, so the changes apply from the user's next message.",
      parameters: Type.Object({}),
      async execute() {
        pi.sendUserMessage("/bot reload", { expandPromptTemplates: true });
        return { content: [{ type: "text", text: "Reload scheduled for the end of this turn; the reloaded environment applies from the next message." }], details: {} };
      },
    });
  }

  pi.registerTool({
    name: "bot_manage",
    label: "Bot manage",
    description: `List or create bots. A bot is a directory ${botsRoot()}/<name>/ that Pi uses as its working directory: BOT.md holds a frontmatter description (what the bot does) and, as its body, the bot's system prompt. The directory is an ordinary Pi project, so AGENTS.md, .pi/settings.json (model, thinking, tools), .pi/extensions/, .pi/skills/ and .pi/mcp.json configure it. Change a bot by editing those files directly. People talk to a bot with \`pi --bot <name>\` or /bot <name>; agents delegate to one with bot_run.`,
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("create")]),
      name: Type.Optional(Type.String({ description: "create: lowercase letters, digits, - and _" })),
      description: Type.Optional(Type.String({ description: "create: one line saying what the bot does" })),
      prompt: Type.Optional(Type.String({ description: "create: the bot's system prompt, covering its role, standards and working style" })),
    }),
    async execute(_id, params): Promise<{ content: TextContent[]; details: { bots?: Bot[]; errors?: string[]; bot?: Bot } }> {
      if (params.action === "list") {
        const { bots, errors } = await listBots();
        const lines = bots.map(bot => `- ${bot.name}: ${bot.description || "(no description)"} (${bot.home})`);
        const text = [...(lines.length ? lines : [`No bots in ${botsRoot()}.`]), ...errors.map(error => `Invalid: ${error}`)].join("\n");
        return { content: [{ type: "text", text }], details: { bots, errors } };
      }
      const bot = await createBot(params.name?.trim() ?? "", params.description ?? "", params.prompt ?? "");
      const text = `Created ${bot.name} at ${bot.home}. Edit ${join(bot.home, "BOT.md")} or add .pi/ configuration there to refine it.`;
      return { content: [{ type: "text", text }], details: { bot } };
    },
  });

  pi.registerTool({
    name: "bot_run",
    label: "Bot run",
    description: "Delegate a task to a bot. It runs as its own Pi agent in its home directory, with its own system prompt, tools and history, and does not see this conversation: make the task self-contained and use absolute paths. Returns the bot's reply and session id; pass the id as session to continue that conversation.",
    parameters: Type.Object({
      bot: Type.String({ description: "Bot name" }),
      task: Type.String({ description: "Self-contained task" }),
      session: Type.Optional(Type.String({ description: "Continue a conversation: a session id from an earlier bot_run, or \"last\" for the bot's latest session" })),
    }),
    async execute(_id, params, signal, onUpdate) {
      if (depth() >= MAX_DEPTH) throw new Error(`bot_run is already nested ${MAX_DEPTH} deep; do this task without delegating.`);
      const bot = await loadBot(params.bot.trim());
      let shown = 0;
      const result = await runBot(bot, params.task, {
        session: params.session?.trim() || undefined, signal,
        onProgress: progress => {
          if (Date.now() - shown < 150) return;
          shown = Date.now();
          onUpdate?.({ content: [{ type: "text", text: progress.live || progress.activity || progress.output || "working…" }], details: { ...progress } });
        },
      });
      if (signal?.aborted) throw new Error(`${bot.name} was cancelled.`);
      if (result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted") {
        throw new Error(`${bot.name} failed: ${result.errorMessage || result.stderr.trim().split("\n").slice(-5).join("\n") || `exit code ${result.exitCode}`}`);
      }
      const output = result.output.length > OUTPUT_LIMIT
        ? `${result.output.slice(0, OUTPUT_LIMIT)}\n\n[Truncated from ${result.output.length} characters; the full reply is in session ${result.sessionId}.]`
        : result.output || "(no reply)";
      return { content: [{ type: "text", text: `${output}\n\n[${bot.name} · session ${result.sessionId}]` }], details: result };
    },
    renderCall(args, theme) {
      const task = String(args.task ?? "").replace(/\s+/g, " ");
      const session = args.session ? theme.fg("dim", ` · session ${args.session}`) : "";
      return new Text(`${theme.fg("toolTitle", theme.bold("bot_run "))}${theme.fg("accent", String(args.bot ?? "…"))}${session}\n${theme.fg("dim", task.length > 160 ? `${task.slice(0, 160)}…` : task)}`, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as RunResult | undefined;
      const text = result.content.map(part => part.type === "text" ? part.text : "").join("\n");
      if (isPartial) return new Text(theme.fg("dim", text.split("\n").slice(-6).join("\n")), 0, 0);
      if (!details?.output) return new Text(text, 0, 0);
      const lines = details.output.split("\n");
      const body = expanded || lines.length <= 12 ? details.output : `${lines.slice(0, 12).join("\n")}\n\n… ${lines.length - 12} more lines`;
      const view = new Container();
      view.addChild(new Markdown(body, 0, 0, getMarkdownTheme()));
      view.addChild(new Text(theme.fg("dim", `${details.bot} · session ${details.sessionId} · ${details.turns} turn${details.turns === 1 ? "" : "s"}${details.cost ? ` · $${details.cost.toFixed(4)}` : ""}`), 0, 0));
      return view;
    },
  });
}
