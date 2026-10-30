import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { assertRootLaunch, ensureWorker, requestWorker, rpc } from "./client.ts";
import { guide, template } from "./guide.ts";
import type { BackgroundAgentRecord, CatalogEntry, ModelName, RunRecord, RunStatus, ThinkingLevel, ValidationResult } from "./index.ts";
import { shellCommand } from "./link.ts";
import { agentDirectory } from "./paths.ts";
import type { ControlRequest, WorkerStatus } from "./protocol.ts";
import { catalogText, duration, json, modelLabel, runBrief, runList, runListView, runSummary, runTree, statusExitCode, TERMINAL_STATUSES, validationText } from "./presentation.ts";

export function help(program = "workflow"): string {
  return `${program} guide                    how to write a workflow: template, ctx API, model rules
${program} init <name> [--cwd DIR]  write a starter .pi/workflows/<name>.ts
${program} catalog [--cwd DIR]
${program} validate <path.ts|name> [--cwd DIR]
${program} run <path.ts|name> [--args JSON|--args-file FILE] [--cwd DIR] [--model PROVIDER/MODEL[:THINKING]] [--thinking LEVEL]
  [--bg|--background] [--request-id ID] [--max-agents N] [--max-cost-usd N] [--max-tokens N] [--max-duration-ms N]
${program} status <runId> [--verbose]
${program} poll <runId> [--interval 1s] [--until signal|done] [--once]
${program} watch <runId> [--interval 1s]
${program} list [--status running,failed] [--all]
${program} result|cancel <runId>
${program} revert <runId> [--keep-worktrees]
${program} retry <runId> [--from KEY] [--allow-changed]
${program} signal <runId> <key> '<json>'
${program} agents [--run ID]
${program} steer <runId> <agent> "message"
${program} worker start|stop|status

Every command accepts --json and --home DIR. JSON run views are the Pi tool's details; poll/watch emit NDJSON:
  run, status, poll, cancel, retry, revert: {runId, workflow, status, model?, summary, error?, failedSteps?, waitingFor?, result?}
  run --bg: {runId, status, model?}   list: [{runId, workflow, status, model?, summary, parentRunId?}]
  status --verbose, watch: the full run record {id, workflow: {name, path, hash}, steps, ...}. model is "provider/modelId".
run attaches by default; Ctrl-C detaches without cancelling the durable run.
Exit codes: 0 success, 1 usage/validation, 2 failed, 3 cancelled, 4 worker unavailable.`;
}

export const HELP = help();

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
  model?: ModelName;
  thinkingLevel?: ThinkingLevel;
  /**
   * Called after admission. For an attached (foreground) launch, the returned
   * callback runs when the client stops waiting, with whether it saw the end.
   */
  onLaunch?: (runId: string, home: string | undefined, attached: boolean) => ((terminal: boolean) => void) | void;
  /** Called when a command has shown a run's final outcome. */
  onSettled?: (runId: string) => void;
  /** How the user invokes commands, for help and hints: "workflow" in a shell, "/workflow" in Pi. */
  program?: string;
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

const THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** `provider/model:high` selects a thinking level as `pi --model` does; other colons stay part of the model ID. */
export function modelOption(value: string): { model: ModelName; thinkingLevel?: ThinkingLevel } {
  const at = value.lastIndexOf(":");
  const level = at > 0 ? value.slice(at + 1) : "";
  return THINKING_LEVELS.includes(level)
    ? { model: value.slice(0, at) as ModelName, thinkingLevel: level as ThinkingLevel }
    : { model: value as ModelName };
}

export function workflowReference(value: string, cwd: string): { path: string } | { name: string } {
  return value.includes("/") || value.includes("\\") || /\.[cm]?[jt]s$/.test(value)
    ? { path: resolve(cwd, value) }
    : { name: value };
}

/** The status line plus what the caller needs next: why it failed, which signal to answer or how to read the result. */
export function statusText(run: RunRecord, hint = "workflow"): string {
  const lines = [runSummary(run)];
  if (run.error) lines.push(`${run.error.reason ?? "error"}: ${run.error.message}`);
  if (run.waitingFor) {
    lines.push(`waiting for signal ${JSON.stringify(run.waitingFor.key)}${run.waitingFor.prompt ? `: ${run.waitingFor.prompt}` : ""}`);
    if (run.waitingFor.schema) lines.push(`expects: ${JSON.stringify(run.waitingFor.schema)}`);
    lines.push(`signal: ${hint} signal ${run.id} ${JSON.stringify(run.waitingFor.key)} '<json>'`);
  }
  if (run.status === "completed") lines.push(`result: ${hint} result ${run.id}`);
  return lines.join("\n");
}

function errorInfo(error: unknown): { code: string; message: string; exitCode: number } {
  if (error instanceof CliError) return error;
  const data = error as { code?: string; message?: string; reason?: string };
  const code = data.code ?? data.reason ?? "error";
  const message = data.message ?? String(error);
  const worker = ["worker_unavailable", "worker_unreachable", "ENOENT", "ECONNREFUSED", "EACCES", "EPERM", "ETIMEDOUT"].includes(code)
    || /worker.*(?:did not start|unavailable|timed out|closed|protocol)/i.test(message);
  const usage = ["usage_error", "validation_error", "invalid_args", "invalid_request", "invalid_signal", "invalid_workflow",
    "invalid_cwd", "unknown_step", "unknown_signal", "unknown_agent_option", "unknown_context_member", "workflow_not_found",
    "nondeterministic_call"].includes(code)
    || code.startsWith("ERR_PARSE_ARGS");
  return { code, message, exitCode: worker ? 4 : usage ? 1 : code === "run_cancelled" ? 3 : 2 };
}

export async function runCli(argv: string[], context: CliContext = {}): Promise<number> {
  const write = context.stdout ?? (text => process.stdout.write(text));
  const warn = context.stderr ?? (text => process.stderr.write(text));
  const client = context.client ?? defaultClient;
  const program = context.program ?? "workflow";
  /** The prefix for next-step hints: keeps --home so a copied command reaches the same worker. */
  let hint = program;
  let jsonMode = argv.includes("--json");
  const emit = (value: unknown, human?: string) => write((jsonMode ? JSON.stringify(value ?? null) : human ?? json(value)) + "\n");
  try {
    const { values, positionals } = parseArgs({
      args: argv, allowPositionals: true, strict: true,
      options: {
        json: { type: "boolean" }, home: { type: "string" }, cwd: { type: "string" }, help: { type: "boolean", short: "h" },
        args: { type: "string" }, "args-file": { type: "string" }, model: { type: "string" }, thinking: { type: "string" },
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
    if (values.help || !action || action === "help") { const text = help(program); emit({ help: text }, text); return 0; }
    const cwd = resolve(context.cwd ?? process.cwd(), values.cwd ?? ".");
    const home = values.home ? resolve(context.cwd ?? process.cwd(), values.home) : undefined;
    if (home) hint = `${program} --home ${/^[\w@%+=:,./-]+$/.test(home) ? home : `'${home.replaceAll("'", `'\\''`)}'`}`;
    const options: ClientOptions = { home, signal: context.signal };
    const request = <T = unknown>(value: ControlRequest) => client.request(value, options) as Promise<T>;
    const count = (n: number, usage: string) => {
      if (args.length !== n) throw new CliError(`Usage: ${program} ${usage}`);
    };
    const status = (runId: string) => request<RunRecord>({ action: "status", runId, verbose: true });
    const poll = async (runId: string, foreground = false): Promise<number> => {
      const interval = intervalMs(values.interval ?? "1s");
      const until = values.until ?? (action === "watch" ? "done" : "signal");
      let last: string | undefined;
      // Elapsed time alone is not a change worth a line.
      const unchanged = (text: string) => text.replace(/\b\d+(?:\.\d+)?(?:ms|s|m|h)\b/g, "");
      if (until !== "done" && until !== "signal") throw new CliError("--until must be done or signal.");
      try {
        for (;;) {
          context.signal?.throwIfAborted();
          const run = await status(runId);
          const terminal = TERMINAL_STATUSES.has(run.status);
          if (terminal) context.onSettled?.(run.id);
          if (foreground) {
            if (terminal) {
              const outcome = run.result === undefined ? "" : `\n\n${typeof run.result === "string" ? run.result : json(run.result)}`;
              emit(runBrief(run).view, runTree(run, Date.now(), hint) + outcome);
              return statusExitCode(run.status);
            }
            if (until === "signal" && run.status === "waiting_signal") {
              emit(runBrief(run).view, `${statusText(run, hint)}\nthen: ${hint} poll ${run.id}`);
              return 0;
            }
            const text = runTree(run, Date.now(), hint);
            if (!jsonMode && unchanged(text) !== last) warn(text + "\n");
            last = unchanged(text);
          } else {
            const text = action === "watch" ? runTree(run, Date.now(), hint) : statusText(run, hint);
            const key = unchanged(text);
            // poll prints the brief view, as status does; watch prints the full record, as status --verbose does.
            if (key !== last) emit(action === "watch" ? run : runBrief(run).view, text);
            last = key;
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
        if (values.thinking !== undefined && !THINKING_LEVELS.includes(values.thinking))
          throw new CliError(`--thinking must be one of ${THINKING_LEVELS.join(", ")}.`);
        const selected = values.model === undefined ? undefined : modelOption(values.model);
        const launch: LaunchRequest = {
          action: "run", requestId: values["request-id"] ?? randomUUID(), workflow: workflowReference(args[0], cwd), args: workflowArgs, cwd,
          origin: context.origin ?? { kind: "cli" }, model: selected?.model ?? context.model,
          thinkingLevel: values.thinking as ThinkingLevel | undefined ?? selected?.thinkingLevel ?? context.thinkingLevel, budget,
        };
        context.signal?.throwIfAborted();
        const result = await request<{ runId: string; status: RunStatus; model?: ModelName }>(launch);
        const attached = !(values.bg || values.background);
        const release = context.onLaunch?.(result.runId, home, attached);
        if (!result.model && !jsonMode) warn(`No model is set for run ${result.runId}: agents fail unless the workflow chooses one. Pass --model provider/model.\n`);
        if (!attached) {
          emit(result, `run ${result.runId} ${result.status} · ${modelLabel(result.model, launch.thinkingLevel)}\npoll: ${hint} poll ${result.runId}\ncancel: ${hint} cancel ${result.runId}`);
          return 0;
        }
        if (!jsonMode) warn(`run ${result.runId} started · ${modelLabel(result.model, launch.thinkingLevel)}\n`);
        let terminal = false;
        try {
          const code = await poll(result.runId, true);
          terminal = true;
          return code;
        } finally { release?.(terminal); }
      }
      case "poll": case "watch":
        count(1, `${action} <runId>`);
        return await poll(args[0]);
      case "status": {
        count(1, "status <runId> [--verbose]");
        const run = await request<RunRecord>({ action, runId: args[0], verbose: values.verbose });
        if (TERMINAL_STATUSES.has(run.status)) context.onSettled?.(run.id);
        emit(values.verbose ? run : runBrief(run).view, values.verbose ? runTree(run, Date.now(), hint) : statusText(run, hint));
        return 0;
      }
      case "list": {
        count(0, "list [--status running,failed] [--all]");
        const statuses = values.status?.split(",") as RunStatus[] | undefined;
        const valid = new Set(["queued", "running", "waiting_signal", ...TERMINAL_STATUSES]);
        if (statuses?.some(item => !valid.has(item))) throw new CliError("--status contains an unknown run status.");
        const runs = await request<RunRecord[]>({ action, filter: { status: statuses, all: values.all } });
        emit(runListView(runs), runList(runs));
        return 0;
      }
      case "result": {
        count(1, "result <runId>");
        const result = await request({ action, runId: args[0] }).catch((error: { code?: string; message?: string }) => {
          if (error?.code === "result_not_ready") error.message += ` poll: ${hint} poll ${args[0]}`;
          throw error;
        });
        context.onSettled?.(args[0]);
        emit(result, typeof result === "string" ? result : undefined);
        return 0;
      }
      case "cancel": case "revert": {
        count(1, `${action} <runId>`);
        const run = await request<RunRecord>(action === "revert" ? { action, runId: args[0], keepWorktrees: values["keep-worktrees"] } : { action, runId: args[0] });
        emit(runBrief(run).view, statusText(run, hint));
        return 0;
      }
      case "retry": {
        count(1, "retry <runId> [--from KEY] [--allow-changed]");
        const run = await request<RunRecord>({ action, runId: args[0], from: values.from, allowChanged: values["allow-changed"] });
        emit(runBrief(run).view, `${statusText(run, hint)}\npoll: ${hint} poll ${run.id}`);
        return 0;
      }
      case "signal": {
        count(3, "signal <runId> <key> '<json>'");
        const accepted = await request({ action, runId: args[0], key: args[1], value: parseJson(args[2], "Signal value") });
        emit(accepted, `Signal ${JSON.stringify(args[1])} accepted. poll: ${hint} poll ${args[0]}`);
        return 0;
      }
      case "steer":
        count(3, 'steer <runId> <agent> "message"');
        emit(await request({ action, runId: args[0], agent: args[1], message: args[2] }));
        return 0;
      case "agents":
        count(0, "agents [--run ID]");
      {
        const agents = await request<BackgroundAgentRecord[]>({ action, runId: values.run });
        emit(agents, agents.length
          ? agents.map(agent => `${agent.runId} ${agent.name} ${agent.status}${agent.detached ? " detached" : ""}`).join("\n")
          : "No background agents. agents lists ctx.spawn() agents; ctx.agent() steps are in status --verbose.");
        return 0;
      }
      case "catalog": {
        count(0, "catalog [--cwd DIR]");
        const entries = await request<CatalogEntry[]>({ action, cwd });
        const searched = [join(cwd, ".pi", "workflows"), join(agentDirectory(context.env ?? process.env), "workflows")];
        emit(entries, entries.length ? catalogText(entries)
          : `No workflows in ${searched.join(" or ")}.\nStart one with: ${program} init <name>   (${program} guide explains the API)`);
        return 0;
      }
      case "guide": {
        count(0, "guide");
        const text = guide({
          shell: program.startsWith("/") ? await shellCommand(context.env ?? process.env) : program,
          sessionModel: context.model ? modelLabel(context.model, context.thinkingLevel) : undefined,
        });
        emit({ guide: text }, text);
        return 0;
      }
      case "init": {
        count(1, "init <name> [--cwd DIR]");
        const name = args[0];
        if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) throw new CliError("Workflow names are kebab-case, for example review-file.");
        const directory = join(cwd, ".pi", "workflows");
        const path = join(directory, `${name}.ts`);
        await mkdir(directory, { recursive: true });
        try { await writeFile(path, template(name), { flag: "wx" }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new CliError(`${path} already exists; edit it or choose another name.`);
          throw error;
        }
        const model = program.startsWith("/") ? "" : " --model provider/model";
        emit({ path, name }, `Created ${path}\nNext: ${hint} validate ${name}\n      ${hint} run ${name} --args '{"path":"README.md"}'${model}\nCommit it: workflow files are project source, never add them to .gitignore.`);
        return 0;
      }
      case "validate": {
        count(1, "validate <path.ts|name>");
        const result = await request<ValidationResult>({ action, workflow: workflowReference(args[0], cwd), cwd });
        emit(result, validationText(result));
        return result.valid === false ? 1 : 0;
      }
      case "worker": {
        count(1, "worker start|stop|status");
        const workerText = (worker: WorkerStatus) => `worker pid ${worker.pid} · home ${worker.home} · up ${duration(worker.uptimeMs)}`;
        // Only start spawns a worker; status and stop on an empty home explain that instead of a socket errno.
        const running = <T>(request: Promise<T>) => request.catch((error: NodeJS.ErrnoException) => {
          if (!["ENOENT", "ECONNREFUSED"].includes(error.code ?? "")) throw error;
          throw new CliError(`No workflow worker is running for this home. Start one with ${hint} worker start; run, poll and the other commands start it automatically.`, "worker_unavailable", 4);
        });
        if (args[0] === "start") { const worker = await client.ensure(options) as WorkerStatus; emit(worker, workerText(worker)); }
        else if (args[0] === "stop") emit(await running(client.rpc({ action: "stop" }, options)), "worker stopped");
        else if (args[0] === "status") { const worker = await running(client.rpc({ action: "ping" }, options)) as WorkerStatus; emit(worker, workerText(worker)); }
        else throw new CliError(`Usage: ${program} worker start|stop|status`);
        return 0;
      }
      default: throw new CliError(`Unknown command ${JSON.stringify(action)}. Run ${program} help.`);
    }
  } catch (error) {
    if (error instanceof DetachedError) {
      if (jsonMode) emit({ runId: error.runId, status: "detached" });
      warn(`${error.message}\npoll: ${hint} poll ${error.runId}\ncancel: ${hint} cancel ${error.runId}\n`);
      return 0;
    }
    const info = errorInfo(error);
    if (info.code === "not_found") info.message += ` List runs: ${hint} list.`;
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
