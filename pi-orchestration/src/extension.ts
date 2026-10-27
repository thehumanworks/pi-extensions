import { resolve } from "node:path";
import { writeSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JsonValue } from "@earendil-works/pi-ai";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { assertRootLaunch, assertUnattended } from "./client.ts";
import { defaultClient, runCli, splitCommand, type WorkflowClient } from "./cli.ts";
import { WorkflowError } from "./errors.ts";
import type { ModelRef, RunRecord, RunStatus, ThinkingLevel } from "./index.ts";
import type { ControlRequest } from "./protocol.ts";
import { json, modelResult, runSummary, TERMINAL_STATUSES } from "./presentation.ts";

export const TOOL_DESCRIPTION = `Define and run durable multi-agent workflows, and manage their progress.
Agents run in a separate durable worker with read/write/edit/bash in the workflow cwd, NOT this session's extensions, MCP tools or skills.
run returns immediately with a runId unless wait:true; the worker continues after this session closes. Use status, result or cancel to manage it.
catalog lists workflows with descriptions and argument schemas. You may author a TypeScript workflow with defineWorkflow under .pi/workflows/, validate it, then launch it by path.
Workflows are trusted code with the user's host permissions. Inner agents cannot launch workflows; compose scripts with ctx.workflow().`;

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

const actions = ["run", "status", "list", "result", "cancel", "retry", "revert", "signal", "steer", "agents", "catalog", "validate"] as const;
const statuses: RunStatus[] = ["queued", "running", "waiting_signal", "completed", "failed", "cancelled", "reverted", "outdated"];
const workflowSchema = Type.Union([Type.Object({ path: Type.String() }), Type.Object({ name: Type.String() })]);
const parameters = Type.Object({
  action: Type.Union(actions.map(value => Type.Literal(value))),
  workflow: Type.Optional(workflowSchema),
  args: Type.Optional(Type.Unknown()),
  cwd: Type.Optional(Type.String()),
  model: Type.Optional(Type.Union([Type.String(), Type.Object({ provider: Type.String(), modelId: Type.String() })])),
  budget: Type.Optional(Type.Object({
    maxAgents: Type.Optional(Type.Integer({ minimum: 1 })), maxCostUsd: Type.Optional(Type.Number({ minimum: 0 })),
    maxTokens: Type.Optional(Type.Integer({ minimum: 1 })), maxDurationMs: Type.Optional(Type.Integer({ minimum: 1 })),
  })),
  runId: Type.Optional(Type.String()),
  verbose: Type.Optional(Type.Boolean()),
  wait: Type.Optional(Type.Boolean()),
  waitTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 600_000 })),
  from: Type.Optional(Type.String()),
  allowChanged: Type.Optional(Type.Boolean()),
  keepWorktrees: Type.Optional(Type.Boolean()),
  key: Type.Optional(Type.String()),
  value: Type.Optional(Type.Unknown()),
  agent: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
  filter: Type.Optional(Type.Object({
    status: Type.Optional(Type.Array(Type.Union(statuses.map(value => Type.Literal(value))))),
    workflow: Type.Optional(Type.String()), all: Type.Optional(Type.Boolean()), limit: Type.Optional(Type.Integer({ minimum: 1 })),
  })),
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

function nonempty(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new WorkflowError("invalid_request", `${name} is required.`);
  return value;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function modelName(value: ModelRef | undefined): string {
  return value === undefined ? "workflow default" : typeof value === "string" ? value : `${value.provider}/${value.modelId}`;
}

function toolResult(value: unknown, runId?: string) {
  const view = modelResult(value, runId);
  return {
    content: [{ type: "text" as const, text: view.text }],
    details: value,
    structuredContent: JSON.parse(JSON.stringify(value ?? null)) as JsonValue,
  };
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
          if (TERMINAL_STATUSES.has(run.status)) {
            // A foreground wait already returns this outcome; a second message would trigger a redundant turn.
            if (tracked.attached) continue;
            const result = modelResult(run.result ?? run.error ?? run.status, run.id);
            pi.sendMessage({
              customType: "workflow", display: true,
              content: `[workflow] ${runSummary(run)}\n${result.text}`,
              details: { kind: "completion", runId: run.id, status: run.status },
            }, { triggerTurn: true, deliverAs: "followUp" });
            session.runs.delete(run.id);
          } else live.push(run);
        } catch (error) {
          if ((error as { code?: string }).code === "run_not_found") session.runs.delete(tracked.runId);
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

  async function authorize(ctx: ExtensionContext, launch: Extract<ControlRequest, { action: "run" }>) {
    assertRootLaunch(env);
    if (!ctx.hasUI) { assertUnattended(env); return; }
    const workflow = "path" in launch.workflow ? launch.workflow.path : launch.workflow.name;
    const accepted = await ctx.ui.confirm("Run durable workflow?", [
      `Workflow: ${workflow}`, `Args: ${json(launch.args ?? {})}`, `Cwd: ${launch.cwd}`,
      `Model: ${modelName(launch.model)}`, `Budget overrides: ${json(launch.budget ?? {})}; workflow/worker limits also apply.`,
      "Runs trusted code and agents with shell/file access after this session closes.",
    ].join("\n"));
    if (!accepted) throw new WorkflowError("cancelled", "Workflow launch cancelled.");
  }

  pi.on("session_start", async (_event, ctx) => { await restore(ctx); });
  pi.on("session_tree", async (_event, ctx) => { await restore(ctx); });
  pi.on("session_shutdown", async () => { dispose(); });
  pi.on("agent_settled", async (_event, ctx) => {
    if (active?.id === ctx.sessionManager.getSessionId() && active.runs.size) await pollSession(active);
  });

  pi.registerTool({
    name: "workflow", label: "Workflow", description: TOOL_DESCRIPTION,
    promptSnippet: "Run durable multi-agent workflows, inspect progress, deliver signals, or cancel work.",
    parameters, outputSchema: Type.Unknown(), annotations: { readOnlyHint: false, openWorldHint: true },
    async execute(toolCallId, args, signal, onUpdate, ctx) {
      signal?.throwIfAborted();
      const cwd = resolve(ctx.cwd, args.cwd ?? ".");
      let request: ControlRequest;
      if (args.action === "run") {
        if (!args.workflow) throw new WorkflowError("invalid_request", "run requires workflow.path or workflow.name.");
        request = {
          action: "run", requestId: `${ctx.sessionManager.getSessionId()}:${toolCallId}`,
          workflow: "path" in args.workflow ? { path: resolve(cwd, args.workflow.path) } : args.workflow,
          args: args.args ?? {}, cwd, origin: { kind: "tool", sessionId: ctx.sessionManager.getSessionId() },
          model: (args.model ?? (ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : undefined)) as ModelRef | undefined,
          thinkingLevel: pi.getThinkingLevel() as ThinkingLevel, budget: args.budget,
        };
        await authorize(ctx, request);
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
      let result = await client.request(request, { signal });
      if (request.action === "run") {
        const launched = result as { runId: string; status: RunStatus };
        if (!args.wait) {
          track(ctx, launched.runId);
          return toolResult(result, launched.runId);
        }
        const release = attach(ctx, launched.runId);
        let terminal = false;
        const timeout = Math.min(600_000, Math.max(1, args.waitTimeoutMs ?? 60_000));
        const deadline = Date.now() + timeout;
        const timeoutSignal = AbortSignal.timeout(timeout);
        const waitSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
        try {
          do {
            waitSignal.throwIfAborted();
            const run = await client.request({ action: "status", runId: launched.runId, verbose: true }, {
              signal: waitSignal, timeoutMs: Math.max(1, deadline - Date.now()),
            }) as RunRecord;
            result = { ...run, runId: run.id };
            terminal = TERMINAL_STATUSES.has(run.status);
            if (terminal || Date.now() >= deadline) break;
            onUpdate?.(toolResult({ runId: run.id, status: run.status, progress: runSummary(run) }, run.id));
            await delay(Math.min(pollInterval, Math.max(1, deadline - Date.now())), undefined, { signal: waitSignal });
          } while (Date.now() < deadline);
        } catch (error) {
          if (signal?.aborted || !timeoutSignal.aborted) throw error;
        } finally { release(terminal); }
        return toolResult(result, launched.runId);
      }
      return toolResult(result, args.runId);
    },
  });

  pi.registerCommand("workflow", {
    description: "Run and manage durable workflows; /workflow help lists commands",
    handler: async (args, ctx) => {
      try {
        const session = sessionFor(ctx);
        const exitCode = await runCli(splitCommand(args), {
          cwd: ctx.cwd, env, client, signal: session.controller.signal,
          model: ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : undefined,
          thinkingLevel: pi.getThinkingLevel() as ThinkingLevel,
          origin: { kind: "tool", sessionId: ctx.sessionManager.getSessionId() },
          authorizeRun: launch => authorize(ctx, launch),
          onLaunch: (runId, home, attached) => attached ? attach(ctx, runId, home) : void track(ctx, runId, home),
          stdout: text => {
            if (active !== session) return;
            pi.sendMessage({ customType: "workflow", content: text.trimEnd(), display: true, details: { kind: "command" } });
            // Pi 1.4 print mode renders assistant messages only and redirects stdout.write to stderr.
            if (ctx.mode === "print") (options.printOutput ?? (value => { writeSync(1, value); }))(text);
          },
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
