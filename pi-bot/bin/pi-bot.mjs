#!/usr/bin/env node
// Launch Pi as a pi-bot, with the conversation history stored in the bot's home.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const expand = path => path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;

export function botsRoot(env = process.env) {
  if (env.PI_BOT_HOME) return resolve(expand(env.PI_BOT_HOME));
  return resolve(env.PI_CODING_AGENT_DIR ? expand(env.PI_CODING_AGENT_DIR) : join(homedir(), ".pi", "agent"), "bots");
}

export function launchArgs(name, args, root) {
  return ["--session-dir", join(root, name, "sessions"), "--bot", name, ...args];
}

function description(file) {
  const match = readFileSync(file, "utf8").match(/^---\r?\n[\s\S]*?^description:\s*(.+)$/m);
  return match ? match[1].trim().replace(/^(["'])(.*)\1$/, "$2") : "";
}

export function listBots(root) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && NAME.test(entry.name) && existsSync(join(root, entry.name, "BOT.md")))
      .map(entry => ({ name: entry.name, description: description(join(root, entry.name, "BOT.md")) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch { return []; }
}

const USAGE = `Usage: pi-bot <name> [pi options] [message]
       pi-bot list

Starts Pi as the named bot. Its conversations are stored in the bot's home, so
-c continues its latest conversation in this directory and -r lists all of them.`;

function main(argv) {
  const root = botsRoot();
  const [name, ...rest] = argv;
  if (!name || name === "-h" || name === "--help" || name === "list") {
    const bots = listBots(root);
    const roster = bots.length ? bots.map(bot => `  ${bot.name}${bot.description ? ` — ${bot.description}` : ""}`).join("\n") : "  (none yet: create one in Pi with /bot new)";
    console.log(name === "list" ? roster : `${USAGE}\n\nBots in ${root}:\n${roster}`);
    return 0;
  }
  if (!NAME.test(name) || !existsSync(join(root, name, "BOT.md"))) {
    console.error(`pi-bot: unknown bot "${name}" (no ${join(root, name, "BOT.md")}). Run \`pi-bot list\`, or create it in Pi with /bot new ${name}.`);
    return 2;
  }
  const child = spawn(process.env.PI_BOT_PI_COMMAND || "pi", launchArgs(name, rest, root), { stdio: "inherit" });
  // The terminal delivers Ctrl+C to the whole process group; Pi decides what it means.
  for (const signal of ["SIGINT", "SIGQUIT"]) process.on(signal, () => {});
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  child.on("error", error => { console.error(`pi-bot: could not start pi: ${error.message}`); process.exit(127); });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
  return undefined;
}

const self = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? (() => { try { return realpathSync(process.argv[1]); } catch { return process.argv[1]; } })() : "";
if (invoked === realpathSync(self)) {
  const code = main(process.argv.slice(2));
  if (code !== undefined) process.exitCode = code;
}
