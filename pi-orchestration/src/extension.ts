import { join, resolve } from "node:path";
import { writeSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JsonValue } from "@earendil-works/pi-ai";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { assertRootLaunch } from "./client.ts";
import { defaultClient, runCli, splitCommand, type WorkflowClient } from "./cli.ts";
import { WorkflowError } from "./errors.ts";
import { EXAMPLES_DIR, guide } from "./guide.ts";
import type { CatalogEntry, ModelName, ModelRef, RunRecord, RunStatus, ThinkingLevel, ValidationResult } from "./index.ts";
import { linkCli, shellCommand } from "./link.ts";
import { agentDirectory, workflowPaths } from "./paths.ts";
import type { ControlRequest } from "./protocol.ts";
import { catalogText, modelLabel, modelResult, runBrief, runDetail, runList, runListView, runSummary, TERMINAL_STATUSES, toolHints, validationText } from "./presentation.ts";

export const TOOL_DESCRIPTION = `Run and manage durable multi-agent workflows. A workflow is a TypeScript file whose run(ctx) calls ctx.agent(), ctx.parallel() and similar; a separate worker runs it, so it outlives this session.
Start with catalog. Before writing a workflow, call guide: it gives a starter file, the ctx API and which model runs. Save workflows as .pi/workflows/<name>.ts and commit them: they are project source, never add them to .gitignore.
Actions:
- catalog: saved workflows with descriptions and args schemas.
- guide: how to write a workflow.
- validate: workflow. Checks that the file loads; flags code that breaks replay.
- run: workflow, args, optional model, budget, cwd. Returns a runId at once, and this session gets a message when the run ends. wait:true returns the outcome instead (waitTimeoutMs, default 60000).
- status: runId. A one-line summary, failed steps and the result; verbose:true lists every step.
- result: runId, the full return value. list: recent runs; optional filter.
- cancel, revert (undo ctx.step effects and worktrees), retry (optional from: step key): runId.
- signal: runId, key, value; answers ctx.signal(). agents: background agents, optional runId. steer: runId, agent, message.
Agents get read/write/edit/bash in the run's cwd, not this session's extensions, MCP tools or skills. Workflows are trusted code that runs with the user's permissions.`;

export const PROMPT_GUIDELINES = [
  "Use the workflow tool when the user asks for a workflow, or for work that splits across several agents in parallel or in stages. Call its guide action before writing a workflow file.",
  "Users run workflows from a terminal with the `workflow` command (the guide action shows the exact command for this machine) and inside Pi with /workflow. `pi workflow` is not a command.",
];

function widgetLine(run: RunRecord, otherRuns: number, width: number): string {
  const phase = run.phases.findLast(item => item.done < item.agents) ?? run.phases.at(-1);
  const clean = (text: string) => stripTerminalSequences(text).replace(/\s+/gu, " ").trim();
  const name = clean(run.workflow.name), title = clean(phase?.title ?? run.status);
  const prefix = `workflow ${run.id.slice(0, 8)} `;
  const cost = run.usage.costUsd === undefined ? "cost n/a" : `$${run.usage.costUsd.toFixed(4)}`;
  const suffix = `${phase ? ` ${phase.done}/${phase.agents}` : ""} · ${run.usage.agents} agents · ${cost}${otherRuns ? ` · +${otherRuns} runs` : ""}`;
  const available = Math.max(0, width - visibleWidth(prefix + " · " + suffix));
  const nameWidth = Math.min(visibleWidth(name), available - Math.min(visibleWidth(title), Math.floor(available / 2)));
  return truncateToWidth(prefix + truncateToWidth(name, nameWidth) + " · " +
    truncateToWidth(title, available - nameWidth) + suffix, Math.max(0, width));
}

const actions = ["catalog", "guide", "validate", "run", "status", "result", "list", "cancel", "retry", "revert", "signal", "steer", "agents"] as const;
const statuses: RunStatus[] = ["queued", "running", "waiting_signal", "completed", "failed", "cancelled", "reverted", "outdated"];
const workflowSchema = Type.Union([
  Type.Object({ path: Type.String({ description: "Workflow file, relative to cwd." }) }),
  Type.Object({ name: Type.String({ description: "Name from catalog." }) }),
], { description: "For run and validate: { name } from catalog, or { path } to a .ts file." });
const parameters = Type.Object({
  action: Type.Union(actions.map(value => Type.Literal(value))),
  workflow: Type.Optional(workflowSchema),
  args: Type.Optional(Type.Object({}, {
    additionalProperties: true,
    description: "For run: a JSON object matching the workflow's args schema (see catalog), e.g. {\"topic\":\"bees\"}. Pass the object itself, not a JSON-encoded string. Default {}.",
  })),
  cwd: Type.Optional(Type.String({ description: "Project directory for run, catalog and validate; agents work here. Default: this session's cwd." })),
  model: Type.Optional(Type.Union([Type.String(), Type.Object({ provider: Type.String(), modelId: Type.String() })], {
    description: "For run: \"provider/model\" for agents that choose none. Default: this session's model. The workflow's defaults.model takes precedence.",
  })),
  budget: Type.Optional(Type.Object({
    maxAgents: Type.Optional(Type.Integer({ minimum: 1, description: "Cap only; the workflow code decides how many agents run." })),
    maxCostUsd: Type.Optional(Type.Number({ minimum: 0 })),
    maxTokens: Type.Optional(Type.Integer({ minimum: 1 })), maxDurationMs: Type.Optional(Type.Integer({ minimum: 1 })),
  }, { description: "For run: limits that stop the run when reached, merged over the workflow's own budget." })),
  runId: Type.Optional(Type.String({ description: "Run to act on, from run or list." })),
  verbose: Type.Optional(Type.Boolean({ description: "For status: every step with its result, usage and journal details." })),
  wait: Type.Optional(Type.Boolean({ description: "For run: wait for the outcome instead of returning at once." })),
  waitTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 600_000, description: "For run with wait: give up waiting after this long; the run continues. Default 60000." })),
  from: Type.Optional(Type.String({ description: "For retry: step key to restart from; earlier steps keep their results." })),
  allowChanged: Type.Optional(Type.Boolean({ description: "For retry: allow the workflow file to have changed since launch." })),
  keepWorktrees: Type.Optional(Type.Boolean({ description: "For revert: keep agent worktrees." })),
  key: Type.Optional(Type.String({ description: "For signal: the key the run waits on (status shows it)." })),
  value: Type.Optional(Type.Union([
    Type.Object({}, { additionalProperties: true }), Type.Array(Type.Unknown()), Type.String(), Type.Number(), Type.Boolean(), Type.Null(),
  ], { description: "For signal: the JSON value itself (object, array, string, number, boolean or null), not a JSON-encoded string. Must match waitingFor.schema when status shows one." })),
  agent: Type.Optional(Type.String({ description: "For steer: background agent name." })),
  message: Type.Optional(Type.String({ description: "For steer: message to send." })),
  filter: Type.Optional(Type.Object({
    status: Type.Optional(Type.Array(Type.Union(statuses.map(value => Type.Literal(value))))),
    workflow: Type.Optional(Type.String()),
    all: Type.Optional(Type.Boolean({ description: "Include child runs started by ctx.workflow()." })),
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
  }, { description: "For list." })),
});

/** attached counts foreground waiters that report the outcome themselves. */
interface TrackedRun { runId: string; home?: string; attached: number }
interface SessionWatch {
  id: string;
  context: ExtensionContext;
  runs: Map<string, TrackedRun>;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  polling: boolean;
}

// Pi shows only the message of a thrown error; lead with the code, as the CLI's {"error":{"code"}} does.
function codedError(error: unknown): unknown {
  if (error instanceof WorkflowError && !error.message.startsWith(`${error.code}:`)) error.message = `${error.code}: ${error.message}`;
  return error;
}

/** The session's model in the form run records store. */
function sessionModel(ctx: ExtensionContext): ModelName | undefined {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

function nonempty(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new WorkflowError("invalid_request", `${name} is required.`);
  return value;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** text is what the model reads; structured is what codemode scripts receive. */
function toolResult(value: unknown, runId?: string, text?: string) {
  return {
    content: [{ type: "text" as const, text: text ?? modelResult(value, runId).text }],
    details: value,
    structuredContent: JSON.parse(JSON.stringify(value ?? null)) as JsonValue,
  };
}

function briefResult(run: RunRecord, note?: string) {
  const brief = runBrief(run, undefined, toolHints);
  return toolResult(brief.view, run.id, note ? `${brief.text}\n${note}` : brief.text);
}

export interface ExtensionOptions {
  client?: WorkflowClient;
  env?: NodeJS.ProcessEnv;
  pollIntervalMs?: number;
  printOutput?: (text: string) => void;
}

/** Registration is inert: session handlers and explicit actions own all live resources. */
export function registerOrchestration(pi: ExtensionAPI, options: ExtensionOptions = {}): void {
  const client = options.client ?? defaultClient;
  const env = options.env ?? process.env;
  const pollInterval = options.pollIntervalMs ?? 1500;
  let active: SessionWatch | undefined;

  function dispose() {
    if (!active) return;
    active.controller.abort();
    clearTimeout(active.timer);
    if (active.context.mode === "tui") active.context.ui.setWidget("workflow", undefined);
    active = undefined;
  }

  function schedule(session: SessionWatch) {
    if (active !== session || session.controller.signal.aborted || !session.runs.size || session.timer) return;
    session.timer = setTimeout(() => {
      session.timer = undefined;
      void pollSession(session);
    }, pollInterval);
    session.timer.unref();
  }

  async function pollSession(session: SessionWatch) {
    if (active !== session || session.polling || session.controller.signal.aborted) return;
    session.polling = true;
    const live: RunRecord[] = [];
    try {
      for (const tracked of session.runs.values()) {
        if (active !== session) return;
        try {
          const run = await client.request({ action: "status", runId: tracked.runId, verbose: true }, {
            home: tracked.home, signal: session.controller.signal,
          }) as RunRecord;
          if (active !== session || session.controller.signal.aborted) return;
          // Settled while this request was in flight: the caller already showed the outcome.
          if (session.runs.get(tracked.runId) !== tracked) continue;
          if (TERMINAL_STATUSES.has(run.status)) {
            // A foreground wait already returns this outcome; a second message would trigger a redundant turn.
            if (tracked.attached) continue;
            // Mid-turn, the agent may still read the outcome itself; agent_settled polls again.
            if (!session.context.isIdle()) continue;
            pi.sendMessage({
              customType: "workflow", display: true,
              content: `[workflow] ${runBrief(run).text}`,
              details: { kind: "completion", runId: run.id, status: run.status },
            }, { triggerTurn: true, deliverAs: "followUp" });
            session.runs.delete(run.id);
          } else live.push(run);
        } catch (error) {
          if ((error as { code?: string }).code === "not_found") session.runs.delete(tracked.runId);
          // A disconnected worker is recoverable; retain the subscription for the next poll.
        }
      }
      if (active === session && session.context.mode === "tui") {
        session.context.ui.setWidget("workflow", live.length ? () => ({
          render: (width: number) => [widgetLine(live[0], live.length - 1, width)],
          invalidate() {},
        }) : undefined);
      }
    } finally {
      session.polling = false;
      schedule(session);
    }
  }

  function sessionFor(ctx: ExtensionContext): SessionWatch {
    const id = ctx.sessionManager.getSessionId();
    if (active?.id === id) { active.context = ctx; return active; }
    dispose();
    active = { id, context: ctx, runs: new Map(), controller: new AbortController(), polling: false };
    return active;
  }

  function track(ctx: ExtensionContext, runId: string, home?: string): TrackedRun {
    const session = sessionFor(ctx);
    let tracked = session.runs.get(runId);
    if (!tracked) {
      tracked = { runId, home, attached: 0 };
      session.runs.set(runId, tracked);
      pi.appendEntry("workflow_run", { runId, home });
    }
    schedule(session);
    return tracked;
  }

  /** Track a run while a foreground caller waits. A caller that saw the terminal state owns the outcome. */
  function attach(ctx: ExtensionContext, runId: string, home?: string): (terminal: boolean) => void {
    const tracked = track(ctx, runId, home);
    const session = active!;
    tracked.attached++;
    let released = false;
    return terminal => {
      if (released) return;
      released = true;
      tracked.attached--;
      if (!terminal || active !== session || session.runs.get(runId) !== tracked) return;
      session.runs.delete(runId);
      pi.appendEntry("workflow_run", { runId, home, done: true });
    };
  }

  /** A tool call or command showed this run's outcome, so the completion message would repeat it. */
  function settle(ctx: ExtensionContext, runId: string) {
    const session = active;
    if (!session || session.id !== ctx.sessionManager.getSessionId()) return;
    const tracked = session.runs.get(runId);
    if (!tracked || tracked.attached) return;
    session.runs.delete(runId);
    pi.appendEntry("workflow_run", { runId, home: tracked.home, done: true });
  }

  /** Put the CLI on PATH once; Pi installs packages without linking their binaries. */
  async function link(ctx: ExtensionContext) {
    try {
      const linked = await linkCli({ env, stateDir: workflowPaths(env.PI_WORKFLOW_HOME).home });
      if (linked && ctx.hasUI) ctx.ui.notify(`Linked the workflow command at ${linked}. Delete it to opt out.`, "info");
    } catch { /* Linking is a convenience; the guide falls back to an explicit node command. */ }
  }

  async function restore(ctx: ExtensionContext) {
    dispose();
    const session = sessionFor(ctx);
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === "workflow_run") {
        const data = record(entry.data);
        if (typeof data?.runId !== "string") continue;
        if (data.done === true) session.runs.delete(data.runId);
        else session.runs.set(data.runId, {
          runId: data.runId, home: typeof data.home === "string" ? data.home : undefined, attached: 0,
        });
      } else if (entry.type === "custom_message" && entry.customType === "workflow") {
        const data = record(entry.details);
        if (data?.kind === "completion" && typeof data.runId === "string") session.runs.delete(data.runId);
      }
    }
    if (session.runs.size) await pollSession(session);
  }

  pi.on("session_start", async (_event, ctx) => { await restore(ctx); await link(ctx); });
  pi.on("session_tree", async (_event, ctx) => { await restore(ctx); });
  pi.on("session_shutdown", async () => { dispose(); });
  pi.on("agent_settled", async (_event, ctx) => {
    if (active?.id === ctx.sessionManager.getSessionId() && active.runs.size) await pollSession(active);
  });

  pi.registerTool({
    name: "workflow", label: "Workflow", description: TOOL_DESCRIPTION,
    promptSnippet: "Write and run durable multi-agent workflows (TypeScript); inspect progress, deliver signals, cancel. Its guide action explains authoring.",
    promptGuidelines: PROMPT_GUIDELINES,
    parameters, outputSchema: Type.Unknown(), annotations: { readOnlyHint: false, openWorldHint: true },
    async execute(toolCallId, args, signal, onUpdate, ctx) {
      try {
        signal?.throwIfAborted();
        const cwd = resolve(ctx.cwd, args.cwd ?? ".");
        let request: ControlRequest;
        if (args.action === "run") {
          assertRootLaunch(env);
          if (!args.workflow) throw new WorkflowError("invalid_request", "run requires workflow.path or workflow.name.");
          request = {
            action: "run", requestId: `${ctx.sessionManager.getSessionId()}:${toolCallId}`,
            workflow: "path" in args.workflow ? { path: resolve(cwd, args.workflow.path) } : args.workflow,
            args: args.args ?? {}, cwd, origin: { kind: "tool", sessionId: ctx.sessionManager.getSessionId() },
            model: (args.model ?? sessionModel(ctx)) as ModelRef | undefined,
            thinkingLevel: pi.getThinkingLevel() as ThinkingLevel, budget: args.budget,
          };
        } else if (args.action === "guide") {
          const model = sessionModel(ctx);
          const text = guide({ shell: await shellCommand(env), sessionModel: model && modelLabel(model, pi.getThinkingLevel()) });
          return toolResult({ guide: text }, undefined, text);
        } else if (args.action === "catalog") request = { action: "catalog", cwd };
        else if (args.action === "validate") {
          if (!args.workflow) throw new WorkflowError("invalid_request", "validate requires workflow.path or workflow.name.");
          request = { action: "validate", workflow: args.workflow, cwd };
        } else if (args.action === "list") request = { action: "list", filter: args.filter };
        else if (args.action === "agents") request = { action: "agents", runId: args.runId };
        else {
          const runId = nonempty(args.runId, "runId");
          switch (args.action) {
            case "status": request = { action: "status", runId, verbose: args.verbose }; break;
            case "retry": request = { action: "retry", runId, from: args.from, allowChanged: args.allowChanged }; break;
            case "revert": request = { action: "revert", runId, keepWorktrees: args.keepWorktrees }; break;
            case "signal":
              if (!Object.hasOwn(args, "value")) throw new WorkflowError("invalid_request", "signal requires value (JSON, including null).");
              request = { action: "signal", runId, key: nonempty(args.key, "key"), value: args.value }; break;
            case "steer": request = { action: "steer", runId, agent: nonempty(args.agent, "agent"), message: nonempty(args.message, "message") }; break;
            default: request = { action: args.action, runId };
          }
        }
        signal?.throwIfAborted();
        const result = await client.request(request, { signal });
        if (request.action === "run") {
          const launched = result as { runId: string; status: RunStatus; model?: ModelName };
          const model = launched.model
            ? `Agents use ${modelLabel(launched.model, request.thinkingLevel)} unless the workflow chooses another model.`
            : "No model is set: agents fail unless the workflow chooses one. Pass model.";
          if (!args.wait) {
            track(ctx, launched.runId);
            return toolResult(result, launched.runId, `Run ${launched.runId} ${launched.status}. ${model}\n` +
              "This session gets a message when it ends; status and result take this runId.");
          }
          const release = attach(ctx, launched.runId);
          let terminal = false;
          const timeout = Math.min(600_000, Math.max(1, args.waitTimeoutMs ?? 60_000));
          const deadline = Date.now() + timeout;
          const timeoutSignal = AbortSignal.timeout(timeout);
          const waitSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
          let last: RunRecord | undefined;
          try {
            do {
              waitSignal.throwIfAborted();
              last = await client.request({ action: "status", runId: launched.runId }, {
                signal: waitSignal, timeoutMs: Math.max(1, deadline - Date.now()),
              }) as RunRecord;
              terminal = TERMINAL_STATUSES.has(last.status);
              if (terminal || last.status === "waiting_signal" || Date.now() >= deadline) break;
              onUpdate?.(toolResult({ runId: last.id, status: last.status, progress: runSummary(last) }, last.id));
              await delay(Math.min(pollInterval, Math.max(1, deadline - Date.now())), undefined, { signal: waitSignal });
            } while (Date.now() < deadline);
          } catch (error) {
            if (signal?.aborted || !timeoutSignal.aborted) throw error;
          } finally { release(terminal); }
          if (!last) return toolResult(result, launched.runId, `Run ${launched.runId} ${launched.status}. ${model}\n` +
            "Stopped waiting; the run continues and this session gets a message when it ends.");
          return briefResult(last, terminal ? undefined : last.status === "waiting_signal"
            ? "Stopped waiting: the run needs a signal. This session gets a message when it ends."
            : "Stopped waiting; the run continues and this session gets a message when it ends.");
        }
        switch (request.action) {
          case "status": {
            const run = result as RunRecord;
            if (TERMINAL_STATUSES.has(run.status)) settle(ctx, run.id);
            return args.verbose ? toolResult(run, run.id, runDetail(run, toolHints)) : briefResult(run);
          }
          case "result":
            settle(ctx, request.runId);
            return toolResult(result, request.runId);
          case "cancel": case "retry": case "revert":
            return briefResult(result as RunRecord);
          case "signal":
            return toolResult(result, request.runId, `Signal ${JSON.stringify(request.key)} accepted. ` +
              `Check the run with {"action":"status","runId":${JSON.stringify(request.runId)}}.`);
          case "list": {
            const runs = result as RunRecord[];
            return toolResult(runListView(runs), undefined, runList(runs));
          }
          case "catalog": {
            const entries = result as CatalogEntry[];
            const searched = [join(cwd, ".pi", "workflows"), join(agentDirectory(env), "workflows")];
            const view = { workflows: entries, searched, examples: EXAMPLES_DIR };
            return toolResult(view, undefined, entries.length ? `${catalogText(entries)}\nTo write a new workflow, call guide.`
              : `No saved workflows (searched ${searched.join(" and ")}). To write one, call guide: it has a starter file to adapt.`);
          }
          case "validate":
            return toolResult(result, undefined, validationText(result as ValidationResult));
          default:
            return toolResult(result, args.runId);
        }
      } catch (error) {
        if (error instanceof WorkflowError && error.code === "result_not_ready" && args.runId)
          error.message += ` Check it with {"action":"status","runId":${JSON.stringify(args.runId)}}.`;
        if (error instanceof WorkflowError && error.code === "not_found") error.message += ` List runs with {"action":"list"}.`;
        throw codedError(error);
      }
    },
  });

  pi.registerCommand("workflow", {
    description: "Run and manage durable workflows; /workflow help lists commands",
    handler: async (args, ctx) => {
      try {
        const session = sessionFor(ctx);
        const stdout = (text: string) => {
          if (active !== session) return;
          pi.sendMessage({ customType: "workflow", content: text.trimEnd(), display: true, details: { kind: "command" } });
          // Pi 1.4 print mode renders assistant messages only and redirects stdout.write to stderr.
          if (ctx.mode === "print") (options.printOutput ?? (value => { writeSync(1, value); }))(text);
        };
        const argv = splitCommand(args);
        const exitCode = await runCli(argv, {
          cwd: ctx.cwd, env, client, signal: session.controller.signal,
          model: sessionModel(ctx),
          thinkingLevel: pi.getThinkingLevel() as ThinkingLevel,
          origin: { kind: "tool", sessionId: ctx.sessionManager.getSessionId() },
          program: "/workflow",
          onLaunch: (runId, home, attached) => attached ? attach(ctx, runId, home) : void track(ctx, runId, home),
          onSettled: runId => settle(ctx, runId),
          stdout,
          stderr: text => {
            if (active !== session) return;
            if (ctx.mode === "print") process.stderr.write(text);
            else if (ctx.hasUI) ctx.ui.notify(text.trimEnd(), "info");
            else pi.sendMessage({ customType: "workflow", content: text.trimEnd(), display: true, details: { kind: "command" } });
          },
        });
        if (ctx.mode === "print" || ctx.mode === "json") process.exitCode = exitCode;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ctx.mode === "print") { process.stderr.write(message + "\n"); process.exitCode = 1; }
        else ctx.ui.notify(message, "error");
      }
    },
  });
}
