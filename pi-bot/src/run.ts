import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { StringDecoder } from "node:string_decoder";

export const MAX_DEPTH = 3;
const STDERR_LIMIT = 8_000;

export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number }

export interface RunResult {
  bot: string;
  sessionId?: string;
  sessionFile?: string;
  cwd: string;
  exitCode: number;
  output: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  stderr: string;
  usage: Usage;
  toolCalls: number;
  aborted: boolean;
}

export interface RunOptions {
  bot: string;
  task: string;
  cwd: string;
  sessionsDir: string;
  /** This extension's entry point, so the child loads it even when the parent used `-e`. */
  extension: string;
  /** Continue an existing session, or fork it into `cwd`. */
  session?: { path: string; fork: boolean };
  depth: number;
  signal?: AbortSignal;
  onProgress?: (result: RunResult) => void;
}

export function currentDepth(env = process.env): number {
  const depth = Number.parseInt(env.PI_BOT_DEPTH ?? "0", 10);
  return Number.isFinite(depth) && depth > 0 ? depth : 0;
}

export function runArgs(options: Pick<RunOptions, "bot" | "task" | "sessionsDir" | "extension" | "session">): string[] {
  const args = ["--mode", "json", "-p", "--session-dir", options.sessionsDir, "--bot", options.bot, "-e", options.extension];
  if (options.session) args.push(options.session.fork ? "--fork" : "--session", options.session.path);
  return [...args, "--", options.task];
}

/** How to start the Pi that is running this extension (compiled binary, or node/bun plus script). */
export function piInvocation(args: string[]): { command: string; args: string[] } {
  if (process.env.PI_BOT_PI_COMMAND) return { command: process.env.PI_BOT_PI_COMMAND, args };
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/") && existsSync(script) && /\.(c|m)?[jt]s$/.test(script)) return { command: process.execPath, args: [script, ...args] };
  if (!/^(node|bun)(\.exe)?$/i.test(basename(process.execPath))) return { command: process.execPath, args };
  return { command: "pi", args };
}

type Message = { role?: string; content?: unknown; model?: string; provider?: string; stopReason?: string; errorMessage?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } };

function text(message: Message): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string").map(part => part.text).join("\n");
}

/** Incremental parser for Pi's JSON-mode event stream (LF-delimited records only). */
export class EventParser {
  readonly result: RunResult;
  private buffer = "";
  private decoder = new StringDecoder("utf8");

  constructor(bot: string, cwd: string) {
    this.result = { bot, cwd, exitCode: -1, output: "", stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }, toolCalls: 0, aborted: false };
  }

  /** Feed stdout bytes; returns true when a record changed the result. */
  feed(chunk: Buffer | string): boolean {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    let changed = false, index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      changed = this.record(line) || changed;
    }
    return changed;
  }

  end(): boolean {
    const rest = this.buffer + this.decoder.end();
    this.buffer = "";
    return rest.trim() ? this.record(rest) : false;
  }

  private record(line: string): boolean {
    if (!line.trim()) return false;
    let event: { type?: string; id?: string; cwd?: string; message?: Message };
    try { event = JSON.parse(line); } catch { return false; }
    if (event.type === "session") {
      this.result.sessionId = event.id;
      if (event.cwd) this.result.cwd = event.cwd;
      return true;
    }
    if (event.type !== "message_end" || event.message?.role !== "assistant") return false;
    const message = event.message, usage = message.usage, total = this.result.usage;
    total.turns++;
    total.input += usage?.input ?? 0; total.output += usage?.output ?? 0;
    total.cacheRead += usage?.cacheRead ?? 0; total.cacheWrite += usage?.cacheWrite ?? 0;
    total.cost += usage?.cost?.total ?? 0;
    if (Array.isArray(message.content)) this.result.toolCalls += message.content.filter(part => part?.type === "toolCall").length;
    if (message.model) this.result.model = message.provider ? `${message.provider}/${message.model}` : message.model;
    this.result.stopReason = message.stopReason;
    this.result.errorMessage = message.errorMessage;
    const output = text(message).trim();
    if (output) this.result.output = output;
    return true;
  }
}

export function failed(result: RunResult): boolean {
  return result.aborted || result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

/** Run one task as a bot in a child Pi process and collect its final answer. */
export function runBot(options: RunOptions): Promise<RunResult> {
  const parser = new EventParser(options.bot, options.cwd);
  const invocation = piInvocation(runArgs(options));
  return new Promise(resolve => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: { ...process.env, PI_BOT_DEPTH: String(options.depth + 1) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let killTimer: NodeJS.Timeout | undefined;
    const abort = () => {
      parser.result.aborted = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    };
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", chunk => { if (parser.feed(chunk)) options.onProgress?.(parser.result); });
    child.stderr.on("data", chunk => {
      parser.result.stderr = (parser.result.stderr + chunk.toString()).slice(-STDERR_LIMIT);
    });
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      parser.end();
      parser.result.exitCode = code;
      resolve(parser.result);
    };
    child.on("error", error => { parser.result.stderr += `\n${error.message}`; finish(1); });
    child.on("close", code => finish(code ?? 1));
  });
}
