import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { connectBot, type BotClient } from "./client.js";
import type { BotServer, ServeOptions } from "./server.js";
import type { BotHandle, BotInfo, InitBotOptions, OpenBotOptions } from "./types.js";

type Output = Pick<Writable, "write">;
type Remote = Pick<BotClient, "info" | "run" | "callTool" | "listSessions" | "close">;
export interface CliDependencies {
  stdin?: Readable;
  stdout?: Output;
  stderr?: Output;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Supplying a signal disables installation of process SIGINT/SIGTERM listeners. */
  signal?: AbortSignal;
  openBot?: (source: string, options: OpenBotOptions) => Promise<BotHandle>;
  initBot?: (dir: string, options: InitBotOptions) => Promise<BotInfo>;
  inspectBot?: (source: string, options: { stateDir?: string }) => Promise<BotInfo>;
  validateBot?: (source: string, options: { stateDir?: string }) => Promise<BotInfo>;
  serve?: (source: string, options: ServeOptions) => Promise<BotServer>;
  connectBot?: (url: string, options: { authToken?: string }) => Remote;
}

const HELP = `Usage: bot <command> [options]

Commands:
  init <dir> [--name NAME] [--description TEXT] [--model MODEL]
  validate <ref> [--state-dir DIR]
  info <ref> [--state-dir DIR] [--json]
  run [ref] --message TEXT [--session ID] [--request-id KEY] [--json]
  chat [ref] [--session ID] [--json]
  serve <ref> [--host HOST] [--port PORT] [--auth-token-env NAME]
  tool call <ref> <name> --input JSON [--session ID] [--json]
  sessions list [ref] [--json]

Local run/chat/serve/tool/sessions: --cwd DIR --state-dir DIR --model MODEL
Local run/chat/tool/sessions: --ephemeral
Remote run/chat/tool/sessions: --url URL [--auth-token-env NAME] (no local ref/options)
Remote tool syntax: bot tool call --url URL <name> --input JSON

Default source for run/chat/sessions: .  Default serve address: 127.0.0.1:3000.
Caller authentication is OFF unless --auth-token-env is explicitly supplied, on every host.
Provider access uses the serving/local user's existing Pi credentials. No bot login is needed.
--json writes final records to stdout. Diagnostics and prompts use stderr.
--help, -h   Show help     --version, -v   Show version
`;
const LOCAL = ["cwd", "state-dir", "model", "ephemeral"];
const REMOTE = ["url", "auth-token-env"];
const ALLOWED: Record<string, string[]> = {
  init: ["name", "description", "model"], validate: ["state-dir"], info: ["state-dir", "json"],
  run: [...LOCAL, ...REMOTE, "message", "session", "request-id", "json"],
  chat: [...LOCAL, ...REMOTE, "session", "json"],
  serve: ["cwd", "state-dir", "model", "host", "port", "auth-token-env"],
  tool: [...LOCAL, ...REMOTE, "input", "session", "json"],
  sessions: [...LOCAL, ...REMOTE, "json"],
};
const BOOLEAN = new Set(["json", "ephemeral"]);
interface Parsed { command: string; positionals: string[]; flags: Map<string, string | true> }
function parse(args: string[]): Parsed {
  const [command, ...rest] = args;
  if (!command || !ALLOWED[command]) throw new Error(`Unknown command: ${command ?? "(none)"}. Use --help.`);
  if ((command === "tool" && rest.shift() !== "call") || (command === "sessions" && rest.shift() !== "list")) {
    throw new Error(`Expected 'bot ${command} ${command === "tool" ? "call" : "list"}'`);
  }
  const positionals: string[] = []; const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--") { positionals.push(...rest.slice(i + 1)); break; }
    if (!arg.startsWith("-")) { positionals.push(arg); continue; }
    if (!arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    const equal = arg.indexOf("="); const name = arg.slice(2, equal < 0 ? undefined : equal);
    if (!ALLOWED[command].includes(name)) throw new Error(`Unknown option for ${command}: --${name}`);
    if (flags.has(name)) throw new Error(`Duplicate option: --${name}`);
    if (BOOLEAN.has(name)) {
      if (equal >= 0) throw new Error(`--${name} does not take a value`);
      flags.set(name, true);
    } else {
      const value = equal >= 0 ? arg.slice(equal + 1) : rest[++i];
      if (value === undefined || !value.trim() || (equal < 0 && value.startsWith("--"))) throw new Error(`--${name} requires a value`);
      flags.set(name, value);
    }
  }
  return { command, positionals, flags };
}
function count(values: string[], min: number, max = min): void {
  if (values.length < min || values.length > max) throw new Error(`Expected ${min === max ? min : `${min}-${max}`} positional argument(s), received ${values.length}`);
}
function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
}
function infoText(info: BotInfo): string {
  const tools = info.tools.map(tool => `${tool.name} (${tool.source})`).join(", ") || "none";
  return `${info.name}: ${info.description}\nSource: ${info.sourceDir}\nState: ${info.stateDir}\nModel: ${info.model ?? "Pi user default"}\nRevision: ${info.revision}\nInheritance: ${info.inherit}\nTools: ${tools}\n${info.diagnostics.map(d => `Diagnostic: ${d}\n`).join("")}`;
}

/** Testable CLI entry point. Returns an exit code; it never calls process.exit(). */
export async function main(args = process.argv.slice(2), dependencies: CliDependencies = {}): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const stdin = dependencies.stdin ?? process.stdin;
  const env = dependencies.env ?? process.env;
  const cwd = dependencies.cwd ?? process.cwd();
  if (!args.length || args.includes("--help") || args.includes("-h")) { stdout.write(HELP); return 0; }
  if (args.length === 1 && ["--version", "-v"].includes(args[0])) {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    stdout.write(`${pkg.version}\n`); return 0;
  }
  const controller = new AbortController();
  const signal = dependencies.signal ?? controller.signal;
  const interrupt = () => controller.abort(new DOMException("Interrupted", "AbortError"));
  if (!dependencies.signal) { process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt); }
  try {
    const { command, positionals, flags } = parse(args);
    const value = (name: string): string | undefined => flags.get(name) as string | undefined;
    const json = flags.has("json");
    const emit = (data: unknown) => stdout.write(`${JSON.stringify(data)}\n`);
    const stateDir = value("state-dir") ? resolve(cwd, value("state-dir")!) : undefined;
    let authToken: string | undefined;
    if (flags.has("auth-token-env")) {
      const variable = value("auth-token-env")!;
      authToken = env[variable];
      if (!authToken?.trim() || /[\r\n]/.test(authToken)) throw new Error(`--auth-token-env ${variable} names a missing, empty or invalid token`);
    }
    const url = value("url");
    if (url) {
      const incompatible = LOCAL.find(name => flags.has(name));
      if (incompatible) throw new Error(`--${incompatible} cannot be used with --url; the server owns execution paths and configuration`);
    } else if (flags.has("auth-token-env") && command !== "serve") {
      throw new Error("--auth-token-env requires --url (or the serve command)");
    }
    const options: OpenBotOptions = {
      cwd: value("cwd") ? resolve(cwd, value("cwd")!) : cwd,
      stateDir, model: value("model"), ephemeral: flags.has("ephemeral"),
    };
    const open = async (source: string) => (dependencies.openBot ?? (await import("./worker-client.js")).openBotProcess)(source, options);
    const remote = () => (dependencies.connectBot ?? connectBot)(url!, { authToken });
    if (command === "init") {
      count(positionals, 1);
      const init = dependencies.initBot ?? (await import("./project.js")).initBot;
      const info = await init(resolve(cwd, positionals[0]), { name: value("name"), description: value("description"), model: value("model") });
      stdout.write(`Initialized ${info.name} at ${info.sourceDir}\n`); return 0;
    }
    if (command === "validate" || command === "info") {
      count(positionals, 1);
      const operation = command === "validate"
        ? dependencies.validateBot ?? (await import("./project.js")).validateBot
        : dependencies.inspectBot ?? (await import("./project.js")).inspectBot;
      const info = await operation(positionals[0], { stateDir });
      if (json) emit(info); else stdout.write(command === "validate" ? `Valid: ${info.name} (${info.revision})\n` : infoText(info));
      return 0;
    }
    if (command === "serve") {
      count(positionals, 1);
      const portText = value("port");
      const port = portText === undefined ? 3000 : Number(portText);
      if ((portText !== undefined && !/^\d+$/.test(portText)) || !Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("--port must be an integer between 0 and 65535");
      const serve = dependencies.serve ?? (await import("./server.js")).serve;
      signal.throwIfAborted();
      const server = await serve(positionals[0], { ...options, host: value("host") ?? "127.0.0.1", port, authToken });
      try {
        stderr.write(`Listening on ${server.url} — access: ${authToken === undefined ? "unauthenticated" : "token-protected"}\n`);
        await waitForAbort(signal);
      } finally { await server.close(); }
      return 0;
    }
    if (command === "tool") {
      count(positionals, url ? 1 : 2);
      if (!flags.has("input")) throw new Error("tool call requires --input JSON");
      let input: unknown;
      try { input = JSON.parse(value("input")!); } catch { throw new Error("--input must be valid JSON"); }
      const name = positionals[url ? 0 : 1];
      signal.throwIfAborted();
      const bot = url ? remote() : await open(positionals[0]);
      try {
        const result = await bot.callTool(name, input, { session: value("session"), signal });
        if (json) emit(result); else for (const item of result.content) if (item.type === "text") stdout.write(`${item.text}\n`);
        return result.isError ? 1 : 0;
      } finally { await bot.close(); }
    }
    count(positionals, 0, url ? 0 : 1);
    if (command === "run" && !flags.has("message")) throw new Error("run requires --message TEXT");
    signal.throwIfAborted();
    const bot = url ? remote() : await open(positionals[0] ?? ".");
    try {
      if (command === "sessions") {
        const sessions = await bot.listSessions();
        if (json) emit(sessions); else for (const session of sessions) stdout.write(`${session.sessionId}\t${session.cwd}\t${session.title ?? ""}\n`);
        return 0;
      }
      if (command === "run") {
        const result = await bot.run(value("message")!, { session: value("session"), requestId: value("request-id"), signal });
        if (json) emit(result);
        else { stdout.write(`${result.output}\n`); stderr.write(`Session: ${result.sessionId} · Run: ${result.runId} · ${result.status}\n`); }
        if (result.error && !json) stderr.write(`${result.error}\n`);
        return result.status === "completed" ? 0 : result.status === "cancelled" ? 130 : 1;
      }
      const readline = createInterface({ input: stdin, crlfDelay: Infinity, terminal: false });
      const onAbort = () => readline.close();
      signal.addEventListener("abort", onAbort, { once: true });
      let session = value("session"); let code = 0;
      try {
        stderr.write("Chat ready. Send a line; /exit or Ctrl-D to quit.\n> ");
        for await (const line of readline) {
          if (signal.aborted || line.trim() === "/exit") break;
          if (!line.trim()) { stderr.write("> "); continue; }
          const result = await bot.run(line, { session, signal });
          session = result.sessionId;
          if (json) emit(result);
          else { stdout.write(`${result.output}\n`); stderr.write(`Session: ${result.sessionId} · Run: ${result.runId} · ${result.status}\n`); }
          if (result.error && !json) stderr.write(`${result.error}\n`);
          if (result.status !== "completed") code = result.status === "cancelled" ? 130 : 1;
          stderr.write("> ");
        }
      } finally { signal.removeEventListener("abort", onAbort); readline.close(); }
      return signal.aborted ? 130 : code;
    } finally { await bot.close(); }
  } catch (error) {
    if (signal.aborted) { stderr.write("Interrupted\n"); return 130; }
    stderr.write(`bot: ${error instanceof Error ? error.message : String(error)}\n`); return 1;
  } finally {
    if (!dependencies.signal) { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); }
  }
}
