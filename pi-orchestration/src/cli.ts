import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { assertRootLaunch, assertUnattended, ensureWorker, requestWorker, rpc } from "./client.ts";
import type { ModelRef, RunRecord, RunStatus, ThinkingLevel } from "./index.ts";
import type { ControlRequest } from "./protocol.ts";
import { json, runList, runSummary, runTree, statusExitCode, TERMINAL_STATUSES } from "./presentation.ts";

export const HELP = `pi-workflow run <path.ts|name> [--args JSON|--args-file FILE] [--cwd DIR] [--model PROVIDER/MODEL]
  [--bg|--background] [--request-id ID] [--max-agents N] [--max-cost-usd N] [--max-tokens N] [--max-duration-ms N]
pi-workflow status <runId> [--verbose]
pi-workflow poll <runId> [--interval 5s] [--until done|signal] [--once]
pi-workflow watch <runId> [--interval 1s]
pi-workflow list [--status running,failed] [--all]
pi-workflow result|cancel <runId>
pi-workflow revert <runId> [--keep-worktrees]
pi-workflow retry <runId> [--from KEY] [--allow-changed]
pi-workflow signal <runId> <key> '<json>'
pi-workflow agents [--run ID]
pi-workflow steer <runId> <agent> "message"
pi-workflow catalog [--cwd DIR]
pi-workflow validate <path.ts|name> [--cwd DIR]
pi-workflow worker start|stop|status

Every command accepts --json and --home DIR. poll/watch emit NDJSON.
run attaches by default; Ctrl-C detaches without cancelling the durable run.
Headless launches require PI_WORKFLOW_ALLOW_UNATTENDED=1.
Exit codes: 0 success, 1 usage/validation, 2 failed, 3 cancelled, 4 worker unavailable.`;

export interface ClientOptions {
  home?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface WorkflowClient {
  request(request: ControlRequest, options?: ClientOptions): Promise<unknown>;
  rpc(request: ControlRequest, options?: ClientOptions): Promise<unknown>;
  ensure(options?: ClientOptions): Promise<unknown>;
}

export const defaultClient: WorkflowClient = {
  request: requestWorker,
  rpc,
  ensure: ensureWorker,
};

type LaunchRequest = Extract<ControlRequest, { action: "run" }>;

export interface CliContext {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  signal?: AbortSignal;
  client?: WorkflowClient;
  origin?: RunRecord["origin"];
  model?: ModelRef;
  thinkingLevel?: ThinkingLevel;
  authorizeRun?: (request: LaunchRequest) => Promise<void>;
  onLaunch?: (runId: string, home?: string) => void;
}

class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;
  constructor(message: string, code = "usage_error", exitCode = 1) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

class DetachedError extends Error {
  readonly runId: string;
  constructor(runId: string) {
    super(`Detached from ${runId}; the workflow continues in the worker.`);
    this.runId = runId;
  }
}

export function intervalMs(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(value);
  const units: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const result = match ? Number(match[1]) * units[match[2] ?? "ms"] : NaN;
  if (!Number.isFinite(result) || result < 10 || result > 2_147_483_647) {
    throw new CliError(`Invalid interval ${JSON.stringify(value)}; use at least 10ms, for example 5s or 1m.`);
  }
  return result;
}

/** Quote-aware command arguments, without shell expansion or execution. */
export function splitCommand(text: string): string[] {
  const result: string[] = [];
  let token = "", quote = "", active = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && quote !== "'") {
      if (i + 1 === text.length) throw new CliError("Trailing backslash in /workflow command.");
      const next = text[i + 1];
      if (quote === '"' && next !== '"' && next !== "\\") token += "\\";
      else { token += next; i++; }
      active = true;
    } else if (quote) {
      if (ch === quote) quote = ""; else token += ch;
      active = true;
    } else if (ch === "'" || ch === '"') {
      quote = ch; active = true;
    } else if (/\s/.test(ch)) {
      if (active) { result.push(token); token = ""; active = false; }
    } else { token += ch; active = true; }
  }
  if (quote) throw new CliError(`Unclosed ${quote} quote in /workflow command.`);
  if (active) result.push(token);
  return result;
}

function parseJson(value: string, label: string): unknown {
  try { return JSON.parse(value); }
  catch (error) { throw new CliError(`${label} must be valid JSON: ${(error as Error).message}`); }
}

function numberOption(value: string | undefined, name: string, integer = false): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!value.trim() || !Number.isFinite(n) || n < 0 || (integer && (!Number.isInteger(n) || n === 0))) {
    throw new CliError(`--${name} requires a ${integer ? "positive integer" : "non-negative number"}.`);
  }
  return n;
}

export function workflowReference(value: string, cwd: string): { path: string } | { name: string } {
  return value.includes("/") || value.includes("\\") || /\.[cm]?[jt]s$/.test(value)
    ? { path: resolve(cwd, value) }
    : { name: value };
}

function errorInfo(error: unknown): { code: string; message: string; exitCode: number } {
  if (error instanceof CliError) return error;
  const data = error as { code?: string; message?: string; reason?: string };
  const code = data.code ?? data.reason ?? "error";
  const message = data.message ?? String(error);
  const worker = ["worker_unavailable", "worker_unreachable", "ENOENT", "ECONNREFUSED", "EACCES", "EPERM", "ETIMEDOUT"].includes(code)
    || /worker.*(?:did not start|unavailable|timed out|closed|protocol)/i.test(message);
  const usage = ["usage_error", "validation_error", "invalid_args", "invalid_request", "workflow_not_found", "nondeterministic_call"].includes(code)
    || code.startsWith("ERR_PARSE_ARGS");
  return { code, message, exitCode: worker ? 4 : usage ? 1 : 2 };
}

export async function runCli(argv: string[], context: CliContext = {}): Promise<number> {
  const write = context.stdout ?? (text => process.stdout.write(text));
  const warn = context.stderr ?? (text => process.stderr.write(text));
  const client = context.client ?? defaultClient;
  let jsonMode = argv.includes("--json");
  const emit = (value: unknown, human?: string) => write((jsonMode ? JSON.stringify(value ?? null) : human ?? json(value)) + "\n");
  try {
    const { values, positionals } = parseArgs({
      args: argv, allowPositionals: true, strict: true,
      options: {
        json: { type: "boolean" }, home: { type: "string" }, cwd: { type: "string" }, help: { type: "boolean", short: "h" },
        args: { type: "string" }, "args-file": { type: "string" }, model: { type: "string" },
        "request-id": { type: "string" }, "keep-worktrees": { type: "boolean" },
        bg: { type: "boolean" }, background: { type: "boolean" }, "max-agents": { type: "string" },
        "max-cost-usd": { type: "string" }, "max-tokens": { type: "string" }, "budget-tokens": { type: "string" },
        "max-duration-ms": { type: "string" }, verbose: { type: "boolean" }, status: { type: "string" },
        all: { type: "boolean" }, from: { type: "string" }, "allow-changed": { type: "boolean" },
        interval: { type: "string" }, until: { type: "string" }, once: { type: "boolean" }, run: { type: "string" },
      },
    });
    jsonMode = values.json ?? false;
    const [action, ...args] = positionals;
    if (values.help || !action || action === "help") { emit({ help: HELP }, HELP); return 0; }
    const cwd = resolve(context.cwd ?? process.cwd(), values.cwd ?? ".");
    const home = values.home ? resolve(context.cwd ?? process.cwd(), values.home) : undefined;
    const options: ClientOptions = { home, signal: context.signal };
    const request = <T = unknown>(value: ControlRequest) => client.request(value, options) as Promise<T>;
    const count = (n: number, usage: string) => {
      if (args.length !== n) throw new CliError(`Usage: pi-workflow ${usage}`);
    };
    const status = (runId: string) => request<RunRecord>({ action: "status", runId, verbose: true });
    const poll = async (runId: string, foreground = false): Promise<number> => {
      const interval = intervalMs(values.interval ?? "1s");
      const until = values.until ?? "done";
      if (until !== "done" && until !== "signal") throw new CliError("--until must be done or signal.");
      try {
        for (;;) {
          context.signal?.throwIfAborted();
          const run = await status(runId);
          const terminal = TERMINAL_STATUSES.has(run.status);
          if (foreground) {
            if (terminal) { emit({ ...run, runId: run.id }, runTree(run)); return statusExitCode(run.status); }
            if (!jsonMode) warn(runTree(run) + "\n");
          } else {
            emit(run, action === "watch" ? runTree(run) : runSummary(run));
            if (values.once) return 0;
            if (terminal) return statusExitCode(run.status);
            if (until === "signal" && run.status === "waiting_signal") return 0;
          }
          await delay(interval, undefined, { signal: context.signal });
        }
      } catch (error) {
        if (context.signal?.aborted) throw new DetachedError(runId);
        throw error;
      }
    };

    switch (action) {
      case "run": {
        count(1, "run <path.ts|name> [--args JSON] [--bg]");
        assertRootLaunch(context.env ?? process.env);
        if (values.args !== undefined && values["args-file"] !== undefined) throw new CliError("Use --args or --args-file, not both.");
        let workflowArgs: unknown = {};
        if (values.args !== undefined) workflowArgs = parseJson(values.args, "--args");
        if (values["args-file"] !== undefined) {
          try { workflowArgs = parseJson(await readFile(resolve(context.cwd ?? process.cwd(), values["args-file"]), "utf8"), "--args-file"); }
          catch (error) { if (error instanceof CliError) throw error; throw new CliError(`Cannot read --args-file: ${(error as Error).message}`); }
        }
        const budget = {
          maxAgents: numberOption(values["max-agents"], "max-agents", true),
          maxCostUsd: numberOption(values["max-cost-usd"], "max-cost-usd"),
          maxTokens: numberOption(values["max-tokens"] ?? values["budget-tokens"], "max-tokens", true),
          maxDurationMs: numberOption(values["max-duration-ms"], "max-duration-ms", true),
        };
        const launch: LaunchRequest = {
          action: "run", requestId: values["request-id"] ?? randomUUID(), workflow: workflowReference(args[0], cwd), args: workflowArgs, cwd,
          origin: context.origin ?? { kind: "cli" }, model: values.model as ModelRef | undefined ?? context.model,
          thinkingLevel: context.thinkingLevel, budget,
        };
        if (context.authorizeRun) await context.authorizeRun(launch); else assertUnattended(context.env ?? process.env);
        context.signal?.throwIfAborted();
        const result = await request<{ runId: string; status: RunStatus }>(launch);
        context.onLaunch?.(result.runId, home);
        if (values.bg || values.background) {
          emit(result, `run ${result.runId} ${result.status}\npoll: pi-workflow poll ${result.runId}\ncancel: pi-workflow cancel ${result.runId}`);
          return 0;
        }
        return await poll(result.runId, true);
      }
      case "poll": case "watch":
        count(1, `${action} <runId>`);
        return await poll(args[0]);
      case "status": {
        count(1, "status <runId> [--verbose]");
        const run = await request<RunRecord>({ action, runId: args[0], verbose: values.verbose });
        emit(run, values.verbose ? runTree(run) : runSummary(run));
        return 0;
      }
      case "list": {
        count(0, "list [--status running,failed] [--all]");
        const statuses = values.status?.split(",") as RunStatus[] | undefined;
        const valid = new Set(["queued", "running", "waiting_signal", ...TERMINAL_STATUSES]);
        if (statuses?.some(item => !valid.has(item))) throw new CliError("--status contains an unknown run status.");
        const runs = await request<RunRecord[]>({ action, filter: { status: statuses, all: values.all } });
        emit(runs, runList(runs));
        return 0;
      }
      case "result": case "cancel": case "revert": {
        count(1, `${action} <runId>`);
        const result = await request(action === "revert" ? { action, runId: args[0], keepWorktrees: values["keep-worktrees"] } : { action, runId: args[0] });
        emit(result, typeof result === "string" ? result : undefined);
        return 0;
      }
      case "retry":
        count(1, "retry <runId> [--from KEY] [--allow-changed]");
        emit(await request({ action, runId: args[0], from: values.from, allowChanged: values["allow-changed"] }));
        return 0;
      case "signal":
        count(3, "signal <runId> <key> '<json>'");
        emit(await request({ action, runId: args[0], key: args[1], value: parseJson(args[2], "Signal value") }));
        return 0;
      case "steer":
        count(3, 'steer <runId> <agent> "message"');
        emit(await request({ action, runId: args[0], agent: args[1], message: args[2] }));
        return 0;
      case "agents":
        count(0, "agents [--run ID]");
        emit(await request({ action, runId: values.run }));
        return 0;
      case "catalog":
        count(0, "catalog [--cwd DIR]");
        emit(await request({ action, cwd }));
        return 0;
      case "validate": {
        count(1, "validate <path.ts|name>");
        const result = await request<{ valid?: boolean; ok?: boolean }>({ action, workflow: workflowReference(args[0], cwd), cwd });
        emit(result);
        return result.valid === false || result.ok === false ? 1 : 0;
      }
      case "worker": {
        count(1, "worker start|stop|status");
        if (args[0] === "start") emit(await client.ensure(options));
        else if (args[0] === "stop") emit(await client.rpc({ action: "stop" }, options));
        else if (args[0] === "status") emit(await client.rpc({ action: "ping" }, options));
        else throw new CliError("Usage: pi-workflow worker start|stop|status");
        return 0;
      }
      default: throw new CliError(`Unknown command ${JSON.stringify(action)}. Run pi-workflow --help.`);
    }
  } catch (error) {
    if (error instanceof DetachedError) {
      if (jsonMode) emit({ runId: error.runId, status: "detached" });
      warn(`${error.message}\npoll: pi-workflow poll ${error.runId}\ncancel: pi-workflow cancel ${error.runId}\n`);
      return 0;
    }
    const info = errorInfo(error);
    if (jsonMode) emit({ error: { code: info.code, message: info.message } });
    else warn(`error ${info.code}: ${info.message}\n`);
    return info.exitCode;
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const controller = new AbortController();
  const detach = () => controller.abort();
  process.once("SIGINT", detach);
  try { return await runCli(argv, { signal: controller.signal }); }
  finally { process.removeListener("SIGINT", detach); }
}
