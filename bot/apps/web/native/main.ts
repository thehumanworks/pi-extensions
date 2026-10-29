import { connectBotBackend, createBotChatAdapter } from "@nothumanwork/bot-ai-sdk";
import { startServer, type Assets } from "./server";
import manifest from "../package.json";

export const VERSION = manifest.version;
const HELP = `bot-web ${VERSION}
Usage: bot-web [web] [--host ::1] [--port 3001] [--backend-url URL]

Standalone web UI for a separately supervised bot daemon.
  --host HOST         Listen address (default ::1)
  --port PORT         Listen port (default 3001)
  --backend-url URL   Daemon URL (default BOT_SERVER_URL or http://[::1]:8787)
  -h, --help          Show help without starting a server
  -v, --version       Show version without starting a server

Server-only environment: BOT_SERVER_URL, BOT_SERVER_TOKEN, BOT_UI_ORIGIN.
`;

export function parseArgs(args: string[]) {
  const rest = args[0] === "web" ? args.slice(1) : args.slice();
  let host = "::1", port = 3001, backendUrl = process.env.BOT_SERVER_URL || "http://[::1]:8787";
  let mode: "serve" | "help" | "version" = "serve";
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--help" || arg === "-h") { mode = "help"; continue; }
    if (arg === "--version" || arg === "-v") { mode = "version"; continue; }
    if (!["--host", "--port", "--backend-url"].includes(arg)) throw new Error("Unknown option. Use --help for usage.");
    const value = rest[++i];
    if (!value || value.startsWith("--")) throw new Error("Missing option value. Use --help for usage.");
    if (arg === "--host") host = value;
    else if (arg === "--port") {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error("Port must be between 1 and 65535.");
      port = Number(value);
    } else backendUrl = value;
  }
  return { host, port, backendUrl, mode };
}

function validateBackend(url: string) {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error();
  } catch { throw new Error("Invalid bot server configuration."); }
}

/** Entry used by the generated compiled asset bundle; no checkout or subprocesses. */
export async function main(args: string[], assets: ReadonlyMap<string, { file: string; type: string; etag?: string }>): Promise<unknown> {
  const options = parseArgs(args);
  if (options.mode === "help") { console.log(HELP); return; }
  if (options.mode === "version") { console.log(VERSION); return; }
  validateBackend(options.backendUrl);
  // Validate origin configuration before opening a listener, without printing its contents.
  if (process.env.BOT_UI_ORIGIN) {
    try {
      const url = new URL(process.env.BOT_UI_ORIGIN);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
    } catch { throw new Error("Invalid UI origin configuration."); }
  }
  const adapter = createBotChatAdapter({ backend: connectBotBackend(options.backendUrl, { token: process.env.BOT_SERVER_TOKEN || undefined }) });
  let running: ReturnType<typeof startServer>;
  try { running = startServer({ host: options.host, port: options.port, assets: assets as Assets, getAdapter: () => adapter }); }
  catch { throw new Error("Unable to start the web listener. Check the listen address and port."); }
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
    await running.stop();
  };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  console.log(`bot-web listening on ${running.server.url.origin}`);
  return running;
}
