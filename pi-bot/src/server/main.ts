import { createServer } from "node:http";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { botsRoot } from "../bots.ts";
import type { Registry } from "../models.ts";
import { ConversationHub } from "./conversations.ts";
import { createApp } from "./http.ts";

export const VERSION = "0.2.0";
export const DEFAULT_HOST = "::1";
export const DEFAULT_PORT = 7733;

/** The extension every bot child loads: this package's index.ts, two levels above src/server or dist/server. */
export const EXTENSION_PATH = fileURLToPath(new URL("../../index.ts", import.meta.url));

const HELP = `Usage: pi-bot-server [options]

Serve pi-bots over HTTP, with an OpenAPI 3.1.0 description at /openapi.json.

Options:
  --host <address>   Listen address (default: ${DEFAULT_HOST}, the IPv6 loopback; env PI_BOT_SERVER_HOST)
  --port <number>    Listen port (default: ${DEFAULT_PORT}; env PI_BOT_SERVER_PORT)
  --pi <command>     Pi executable used for bot conversations (default: pi on PATH; env PI_BOT_PI_COMMAND)
  --cwd <dir>        Working directory for conversations that name none (default: the home directory)
  --idle <seconds>   Stop a bot's idle Pi process after this long (default: 600)
  -h, --help         Show this help

Bots live in ${botsRoot()} (env PI_BOT_HOME).`;

export interface ServerOptions { host: string; port: number; pi: string; cwd: string; idleMs: number }

export function parseOptions(argv: string[], env: NodeJS.ProcessEnv = process.env): ServerOptions | "help" {
  const { values } = parseArgs({ args: argv, options: { host: { type: "string" }, port: { type: "string" }, pi: { type: "string" }, cwd: { type: "string" }, idle: { type: "string" }, help: { type: "boolean", short: "h" } } });
  if (values.help) return "help";
  const port = Number(values.port ?? env.PI_BOT_SERVER_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid port "${values.port ?? env.PI_BOT_SERVER_PORT}".`);
  const idle = Number(values.idle ?? 600);
  if (!Number.isFinite(idle) || idle < 0) throw new Error(`Invalid idle time "${values.idle}".`);
  return {
    host: values.host ?? env.PI_BOT_SERVER_HOST ?? DEFAULT_HOST, port,
    pi: values.pi ?? env.PI_BOT_PI_COMMAND ?? "pi",
    cwd: resolve(values.cwd ?? homedir()), idleMs: idle * 1000,
  };
}

/** Models from Pi's own catalogue and credential store, refreshed at most once a minute. */
function modelRegistry(): () => Promise<Registry> {
  let cached: { at: number; registry: Registry } | undefined;
  return async () => {
    if (cached && Date.now() - cached.at < 60_000) return cached.registry;
    const runtime = await ModelRuntime.create();
    const available = await runtime.getAvailable();
    const registry: Registry = { getAll: () => runtime.getModels(), getAvailable: () => available, find: (provider, id) => runtime.getModel(provider, id) };
    cached = { at: Date.now(), registry };
    return registry;
  };
}

export function formatUrl(host: string, port: number): string {
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

/** Start listening; resolves with the bound URL. */
export async function serve(options: ServerOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const hub = new ConversationHub({ command: options.pi, extension: EXTENSION_PATH, defaultCwd: options.cwd, idleMs: options.idleMs });
  const server = createServer(createApp({ hub, registry: modelRegistry(), version: VERSION }));
  await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(options.port, options.host, done); });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return {
    url: formatUrl(options.host, port),
    close: async () => { await hub.closeAll(); await new Promise<void>(done => server.close(() => done())); },
  };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let options: ServerOptions | "help";
  try { options = parseOptions(argv); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 2; }
  if (options === "help") { console.log(HELP); return 0; }
  const running = await serve(options);
  console.log(`pi-bot-server ${VERSION} listening on ${running.url} (OpenAPI: ${running.url}/openapi.json; bots in ${botsRoot()})`);
  const stop = () => { void running.close().then(() => process.exit(0)); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return new Promise(() => {}); // runs until a signal arrives
}
