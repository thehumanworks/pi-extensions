import { randomUUID } from "node:crypto";
import { availableParallelism } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  configure, createRegistry, defineExtension, defineTask, Harness, UsageDoc,
  type Conversation, type HarnessOptions, type Registry, type Storage, type Task,
  type TaskRuntime, type TaskId, type Tx, type EntryId, type ConversationId,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Value } from "typebox/value";
import { Type } from "typebox";
import type { ModelRef, RunId, RunRecord, StepRecord, WorkflowDefinition } from "../index.ts";
import type { ControlRequest } from "../protocol.ts";
import { loadWorkflow } from "../loader.ts";
import { WorkflowError } from "../errors.ts";
import { Execution } from "./execution.ts";
import { AgentMeta, copy, json, publicRun, RunStore, storedRun, type RunData } from "./store.ts";
import { installDeterminismGuard, outsideScript, wallNow } from "./scopes.ts";
import { Semaphore } from "./semaphore.ts";
import { effectTask, type EffectCallback, type EffectTask } from "./effects.ts";
import { structuredTool } from "./structured.ts";
import { budgetExtension } from "./budgets.ts";
import { removeWorktree } from "./worktrees.ts";
import { BackgroundStore, backgroundTasks, cleanupBackground, cleanupBackgroundSteps, listBackgroundAgents, steerBackgroundAgent } from "./background.ts";
import { SwarmTools } from "./swarm.ts";

const context = BACKGROUND_CONTEXT;
export type RunInput = { runId: string; mode?: "revert" };
export type RunCheckpoint = { phase: "script" } | { phase: "revert" };
export type RunRuntime = TaskRuntime<RunInput, RunCheckpoint, null, object>;
export type RunTaskDefinition = Task<RunInput, RunCheckpoint, null, object>;
export interface EngineOptions {
  home: string;
  defaultModel?: ModelRef;
  maxConcurrentAgents?: number;
  maxDepth?: number;
  retryBackoffMs?: number;
  structuredRetries?: number;
  defaultRetries?: number;
  defaultTimeoutMs?: number;
  now?: HarnessOptions["now"];
  setTimer?: HarnessOptions["setTimer"];
  onReport?: HarnessOptions["onReport"];
}
type Launch = Extract<ControlRequest, { action: "run" }>;

export class Engine {
  readonly semaphore: Semaphore;
  readonly settings: { maxDepth: number; retryBackoffMs: number; structuredRetries: number };
  private pending: Promise<unknown> = Promise.resolve();
  private readonly active = new Map<string, Execution>();
  private readonly effects = new Map<string, EffectCallback>();
  private readonly effectWaiters = new Map<string, Set<(callback: EffectCallback) => void>>();
  readonly harness: Harness;
  readonly root: Conversation;
  readonly registry: Registry;
  readonly models: Models;
  readonly options: EngineOptions;
  readonly runTask: RunTaskDefinition;
  readonly stepTask: EffectTask;

  constructor(
    harness: Harness, root: Conversation, registry: Registry,
    models: Models, options: EngineOptions, runTask: RunTaskDefinition, stepTask: EffectTask,
  ) {
    this.harness = harness; this.root = root; this.registry = registry;
    this.models = models; this.options = options; this.runTask = runTask; this.stepTask = stepTask;
    this.semaphore = new Semaphore(options.maxConcurrentAgents ?? Math.min(availableParallelism(), 8));
    this.settings = {
      maxDepth: options.maxDepth ?? 1, retryBackoffMs: options.retryBackoffMs ?? 1000,
      structuredRetries: options.structuredRetries ?? 1,
    };
  }

  now(): number { return this.options.now?.() ?? wallNow(); }

  async saveResult(tx: Tx, target: { result?: unknown; resultRef?: string }, value: unknown): Promise<void> {
    const data = json(value);
    if (Buffer.byteLength(JSON.stringify(data)) > 16 * 1024) {
      const entry = await tx.appendEntry(this.root.id, { kind: "workflow.result", data: { value: data } });
      target.resultRef = String(entry.id); delete target.result;
    } else { target.result = data; delete target.resultRef; }
  }

  async readResult(target: { result?: unknown; resultRef?: string }): Promise<unknown> {
    if (!target.resultRef) return copy(target.result ?? null);
    const entry = await this.root.commit(tx => tx.entry(Number(target.resultRef) as EntryId), context);
    if (!entry || entry.kind !== "workflow.result") throw new WorkflowError("missing_result", `Durable result entry ${target.resultRef} is missing.`);
    return copy((entry.data as { value: unknown }).value);
  }

  async reserveAgent(tx: Tx, runId: string): Promise<void> {
    const store = await tx.doc(RunStore);
    let run: RunData | undefined = storedRun(store.runs[runId]);
    const lineage: RunData[] = [];
    while (run) {
      if (run.limits.maxAgents !== undefined && run.usage.agents >= run.limits.maxAgents)
        throw new WorkflowError("budget_exceeded", `Run ${run.id} reached maxAgents=${run.limits.maxAgents}.`);
      if (run.limits.maxCostUsd !== undefined && (run.usage.costUsd ?? 0) > run.limits.maxCostUsd)
        throw new WorkflowError("budget_exceeded", `Run ${run.id} exceeded maxCostUsd=${run.limits.maxCostUsd}.`);
      if (run.limits.maxTokens !== undefined && run.usage.inputTokens + run.usage.outputTokens > run.limits.maxTokens)
        throw new WorkflowError("budget_exceeded", `Run ${run.id} exceeded maxTokens=${run.limits.maxTokens}.`);
      lineage.push(run);
      run = run.origin.kind === "workflow" ? storedRun(store.runs[run.origin.parentRunId]) : undefined;
    }
    for (const ancestor of lineage) ancestor.usage.agents++;
  }

  async addUsage(tx: Tx, runId: string, delta: { inputTokens: number; outputTokens: number; costUsd?: number }): Promise<void> {
    const store = await tx.doc(RunStore);
    let run: RunData | undefined = storedRun(store.runs[runId]);
    while (run) {
      run.usage.inputTokens += delta.inputTokens; run.usage.outputTokens += delta.outputTokens;
      run.usage.costUsd = (run.usage.costUsd ?? 0) + (delta.costUsd ?? 0);
      run = run.origin.kind === "workflow" ? storedRun(store.runs[run.origin.parentRunId]) : undefined;
    }
  }

  async assertUsageWithinBudget(runId: string, stepKey?: string): Promise<void> {
    const store = await this.harness.snapshot(RunStore, context);
    let run: RunData | undefined = store?.runs[runId] ? storedRun(store.runs[runId]) : undefined;
    while (run) {
      if (run.limits.maxCostUsd !== undefined && (run.usage.costUsd ?? 0) > run.limits.maxCostUsd ||
          run.limits.maxTokens !== undefined && run.usage.inputTokens + run.usage.outputTokens > run.limits.maxTokens)
        throw new WorkflowError("budget_exceeded", `Run ${run.id} usage exceeded its budget.`, stepKey);
      run = run.origin.kind === "workflow" ? storedRun(store!.runs[run.origin.parentRunId]) : undefined;
    }
  }

  async accountConversation(runId: string, key: string, conversationId: ConversationId): Promise<{ inputTokens: number; outputTokens: number; costUsd: number }> {
    const usage = await this.harness.snapshot(UsageDoc, conversationId, context);
    const sum = Object.values(usage?.models ?? {}).concat(Object.values(usage?.tools ?? {})).reduce((total, value) => ({
      inputTokens: total.inputTokens + value.input + value.cacheRead + value.cacheWrite,
      outputTokens: total.outputTokens + value.output, costUsd: total.costUsd + value.cost.total,
    }), { inputTokens: 0, outputTokens: 0, costUsd: 0 });
    await this.mutate(runId, async (run, tx) => {
      const step = run.steps.find(item => item.key === key)!;
      const delta = { inputTokens: sum.inputTokens - (step.accountedUsage?.inputTokens ?? 0),
        outputTokens: sum.outputTokens - (step.accountedUsage?.outputTokens ?? 0), costUsd: sum.costUsd - (step.accountedUsage?.costUsd ?? 0) };
      await this.addUsage(tx, runId, delta);
      step.usage = { inputTokens: (step.usage?.inputTokens ?? 0) + delta.inputTokens,
        outputTokens: (step.usage?.outputTokens ?? 0) + delta.outputTokens, costUsd: (step.usage?.costUsd ?? 0) + delta.costUsd };
      step.accountedUsage = sum;
    });
    return sum;
  }

  async describe(id: string): Promise<RunData> {
    const run = await this.get(id);
    const parked = await this.parkedTasks(id);
    if (parked.length) {
      run.parked = true;
      run.error = { reason: "restart_limit", message: `Run has ${parked.length} task(s) parked after repeated interrupted executions. Inspect the cause and use workflow retry ${run.id}.` };
    }
    return run;
  }

  private async parkedTasks(runId: string): Promise<TaskId[]> {
    const store = await this.harness.snapshot(RunStore, context);
    const runs = Object.values(store?.runs ?? {}).map(storedRun);
    const selected = new Set([runId]);
    for (let changed = true; changed;) {
      changed = false;
      for (const run of runs) if (run.origin.kind === "workflow" && selected.has(run.origin.parentRunId) && !selected.has(run.id)) {
        selected.add(run.id); changed = true;
      }
    }
    const tasks = new Set<TaskId>();
    const conversations = new Set<ConversationId>();
    for (const run of runs) if (selected.has(run.id)) {
      if (run.taskId) tasks.add(run.taskId);
      for (const step of run.steps) {
        if (step.taskId) tasks.add(step.taskId);
        if (step.conversationId) conversations.add(Number(step.conversationId) as ConversationId);
      }
    }
    const background = await this.harness.snapshot(BackgroundStore, context);
    const agents = new Set<string>();
    for (const [id, value] of Object.entries(background?.agents ?? {})) if (selected.has(String(value.runId))) {
      agents.add(id); tasks.add(Number(value.anchorTask) as TaskId); conversations.add(Number(value.conversationId) as ConversationId);
    }
    for (const value of Object.values(background?.messages ?? {})) if (agents.has(String(value.agentId))) tasks.add(Number(value.taskId) as TaskId);
    const live = (await this.harness.inspect(context)).tasks;
    for (let changed = true; changed;) {
      changed = false;
      for (const item of live) if (!tasks.has(item.record.id) &&
        (item.record.owner !== undefined && tasks.has(item.record.owner) || conversations.has(item.record.conversationId))) {
        tasks.add(item.record.id); changed = true;
      }
    }
    return live.filter(item => tasks.has(item.record.id) && item.state.kind === "blocked" && item.state.reason === "restart_limit").map(item => item.record.id);
  }

  registerEffect(runId: string, key: string, callback: EffectCallback): void {
    const identity = `${runId}:${key}`;
    this.effects.set(identity, callback);
    for (const resolve of this.effectWaiters.get(identity) ?? []) resolve(callback);
    this.effectWaiters.delete(identity);
  }

  effect(runId: string, key: string, signal: AbortSignal): Promise<EffectCallback> {
    const identity = `${runId}:${key}`;
    const callback = this.effects.get(identity);
    if (callback) return Promise.resolve(callback);
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const ready = (fn: EffectCallback) => { signal.removeEventListener("abort", abort); resolve(fn); };
      const abort = () => { this.effectWaiters.get(identity)?.delete(ready); reject(signal.reason); };
      const waiting = this.effectWaiters.get(identity) ?? new Set<(callback: EffectCallback) => void>();
      waiting.add(ready); this.effectWaiters.set(identity, waiting);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  async get(id: string): Promise<RunData> {
    const value = (await this.harness.snapshot(RunStore, context))?.runs[id];
    if (!value) throw new WorkflowError("not_found", `Unknown workflow run ${id}. Use workflow list.`);
    return copy(storedRun(value));
  }

  async mutate<T>(id: string, change: (run: RunData, tx: Tx) => T | Promise<T>): Promise<T> {
    return this.root.commit(async tx => {
      const value = (await tx.doc(RunStore)).runs[id];
      if (!value) throw new WorkflowError("not_found", `Unknown workflow run ${id}.`);
      return change(storedRun(value), tx);
    }, context);
  }

  async execute(runId: string, runtime: RunRuntime, ctx: Context): Promise<void> {
    const execution = new Execution(this, runId, runtime, ctx);
    this.active.set(runId, execution);
    try {
      const run = await this.get(runId);
      const loaded = await loadWorkflow({ path: run.workflow.path }, run.cwd);
      if (loaded.hash !== run.workflow.hash) {
        await runtime.commit(async tx => {
          const current = storedRun((await tx.doc(RunStore)).runs[runId]);
          current.status = "outdated";
          current.error = { reason: "definition_changed", message: "Workflow definition changed. Restore the file or retry --allow-changed." };
          return { status: "terminal", outcome: { status: "failed", error: { message: current.error.message } } };
        }, ctx);
        return;
      }
      await runtime.commit(async tx => {
        const current = storedRun((await tx.doc(RunStore)).runs[runId]);
        current.status = "running";
        current.startedAt ??= runtime.now();
        delete current.endedAt;
        return undefined;
      }, ctx);
      const result = await execution.run(loaded.definition);
      await cleanupBackground(this, runId);
      await this.assertUsageWithinBudget(runId);
      await runtime.commit(async tx => {
        const current = storedRun((await tx.doc(RunStore)).runs[runId]);
        await this.saveResult(tx, current, result);
        current.status = "completed";
        current.endedAt = runtime.now();
        return { status: "terminal", outcome: { status: "completed", result: null } };
      }, ctx);
    } catch (error) {
      if (runtime.signal.aborted) throw error;
      const failure = error instanceof WorkflowError ? error : new WorkflowError("workflow_failed", error instanceof Error ? error.message : String(error));
      await runtime.commit(async tx => {
        const current = storedRun((await tx.doc(RunStore)).runs[runId]);
        current.status = "failed";
        current.endedAt = runtime.now();
        current.error = { reason: failure.code, message: failure.message, ...(failure.stepKey ? { stepKey: failure.stepKey } : {}) };
        for (const step of current.steps) {
          if (step.status === "pending") step.status = "skipped";
          else if (step.status === "running") step.status = "cancelled";
        }
        return { status: "terminal", outcome: { status: "failed", error: { message: failure.message } } };
      }, ctx);
    } finally {
      this.active.delete(runId);
      const run = await this.get(runId).catch(() => undefined);
      for (const step of run?.steps ?? []) if (step.conversationId) this.semaphore.releaseReservation(step.conversationId);
    }
  }

  async launch(request: Launch, owner?: { taskId: TaskId; parentRunId: string; stepKey: string }): Promise<{ runId: RunId; status: RunRecord["status"]; model?: ModelRef }> {
    if (!owner && request.callerRunId)
      throw new WorkflowError("not_from_root", `Workflows are launched by the user or root Pi session, not from inside run ${request.callerRunId}, step ${request.callerStep ?? "unknown"}. Compose with ctx.workflow() instead.`);
    const canonicalCwd = await realpath(request.cwd);
    const worktreeRelative = relative(resolve(this.options.home, "worktrees"), canonicalCwd);
    if (!owner && worktreeRelative !== ".." && !worktreeRelative.startsWith(`..${sep}`) && !isAbsolute(worktreeRelative))
      throw new WorkflowError("not_from_root", "Cannot launch a workflow from an inner agent worktree. Compose with ctx.workflow() instead.");
    const already = (await this.harness.snapshot(RunStore, context))?.requests[request.requestId];
    if (already) { const run = await this.get(already); return { runId: run.id, status: run.status, ...(run.model ? { model: run.model } : {}) }; }
    if (!isAbsolute(request.cwd) || !(await stat(request.cwd)).isDirectory())
      throw new WorkflowError("invalid_cwd", "cwd must be an existing absolute directory.");
    const loaded = await loadWorkflow(request.workflow, request.cwd);
    const argsSchema = loaded.definition.args ?? Type.Object({}, { additionalProperties: false });
    if (typeof request.args === "string")
      throw new WorkflowError("invalid_args", `args is a JSON-encoded string; pass the object itself, e.g. {"topic":"bees"}, not "{\\"topic\\":\\"bees\\"}".`);
    if (!Value.Check(argsSchema, request.args ?? {})) {
      const problems = [...Value.Errors(argsSchema, request.args ?? {})].slice(0, 10)
        .map(error => {
          const got = error.instancePath.split("/").slice(1)
            .reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], request.args ?? {});
          return `args${error.instancePath}: ${error.message} (got ${JSON.stringify(got) ?? "undefined"})`;
        });
      throw new WorkflowError("invalid_args", `Arguments do not match the workflow schema ${JSON.stringify(argsSchema)}:\n${problems.join("\n")}`.slice(0, 2000));
    }
    // Definition defaults outrank the launch model for every agent, so record the model agents will actually use.
    const model = loaded.definition.defaults?.model ?? request.model ?? this.options.defaultModel;
    if (model) this.resolveModel(model);
    const parent = owner ? await this.get(owner.parentRunId) : undefined;
    const depth = parent ? parent.depth + 1 : 0;
    if (depth > this.settings.maxDepth)
      throw new WorkflowError("depth_limit", `Workflow depth ${depth} exceeds worker maxDepth ${this.settings.maxDepth}.`);
    return this.root.commit(async tx => {
      const store = await tx.doc(RunStore);
      const duplicate = store.requests[request.requestId];
      if (duplicate) { const run = storedRun(store.runs[duplicate]); return { runId: run.id, status: run.status, ...(run.model ? { model: run.model } : {}) }; }
      const runId = randomUUID() as RunId;
      const taskId = await tx.createTask(this.runTask, { runId }, {
        ownership: owner ? { kind: "task", taskId: owner.taskId } : { kind: "conversation" },
        background: !owner,
      });
      const run: RunData = {
        id: runId, requestId: request.requestId, taskId, cwd: request.cwd,
        workflow: { name: loaded.definition.name, path: loaded.path, hash: loaded.hash },
        args: json(request.args ?? {}), status: "queued", createdAt: this.now(), attempt: 1,
        phases: [], steps: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, agents: 0 },
        origin: owner ? { kind: "workflow", parentRunId: owner.parentRunId as RunId, stepKey: owner.stepKey } : request.origin,
        depth, children: [], helpers: {}, positions: {}, nextSequence: 0, signals: {}, logs: [],
        limits: { ...loaded.definition.budget, ...request.budget }, budget: { ...loaded.definition.budget, ...request.budget },
        ...(model ? { model } : {}), ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}),
      };
      store.runs[runId] = json(run) as Record<string, import("@earendil-works/chord").JsonValue>;
      store.requests[request.requestId] = runId;
      if (owner) storedRun(store.runs[owner.parentRunId]).children.push(runId);
      return { runId, status: run.status, ...(model ? { model } : {}) };
    }, context);
  }

  resolveModel(ref: ModelRef): { provider: string; modelId: string } {
    const model = typeof ref === "string" ? { provider: ref.slice(0, ref.indexOf("/")), modelId: ref.slice(ref.indexOf("/") + 1) } : ref;
    if (!this.models.getModel(model.provider, model.modelId))
      throw new WorkflowError("unknown_model", `Worker cannot resolve model ${model.provider}/${model.modelId}. Configure Pi credentials/models.json; session-only providers are not inherited.`);
    return model;
  }

  async cancel(runId: string): Promise<RunData> {
    const run = await this.get(runId);
    if (["completed", "failed", "cancelled", "reverted", "outdated"].includes(run.status)) {
      await cleanupBackground(this, runId, true);
      for (const child of run.children) await this.cancel(child);
      return this.get(runId);
    }
    await this.mutate(runId, current => { current.cancelRequested = true; });
    if (run.taskId) {
      await this.harness.abortTask(run.taskId, context);
      await this.harness.waitForTask(run.taskId, context);
    }
    await cleanupBackground(this, runId, true);
    for (const child of (await this.get(runId)).children) await this.cancel(child);
    return this.get(runId);
  }

  async retry(runId: string, from?: string, allowChanged = false): Promise<RunData> {
    const run = await this.get(runId);
    const parked = await this.parkedTasks(runId);
    if (parked.length && !from && !allowChanged) {
      for (const taskId of parked) await this.harness.retryTask(taskId, context);
      return this.get(runId);
    }
    if (["queued", "running", "waiting_signal"].includes(run.status))
      throw new WorkflowError("run_active", "Cancel the active run before retrying it.");
    const loaded = await loadWorkflow({ path: run.workflow.path }, run.cwd);
    const changed = loaded.hash !== run.workflow.hash;
    if (changed && !allowChanged) {
      await this.mutate(runId, current => { current.status = "outdated"; });
      throw new WorkflowError("definition_changed", "Definition changed. Restore it or retry --allow-changed to start a clean journal.");
    }
    if (changed && from) throw new WorkflowError("invalid_retry", "--from cannot be combined with changed code. Use --allow-changed without --from for a clean replay.");
    const boundary = from ? run.steps.find(step => step.key === from) : undefined;
    if (from && !boundary) throw new WorkflowError("unknown_step", `No journal step '${from}'. Use status --verbose to find its exact key.`);
    const invalid = run.steps.filter(step => changed || (boundary ? step.sequence >= boundary.sequence : step.status !== "completed" && step.status !== "compensated"));
    const invalidKeys = new Set(invalid.map(step => step.key));
    // A completed combinator must descend again when one of its branches changes.
    for (const step of run.steps) if (["parallel", "pipeline", "swarm"].includes(step.kind) && invalid.some(child => child.key.startsWith(step.key + "/"))) invalidKeys.add(step.key);
    // A swarm's conversations and dynamic queue share a generation. Retry them together.
    for (const swarm of run.steps.filter(step => step.kind === "swarm" && invalidKeys.has(step.key)))
      for (const step of run.steps) if (step.key.startsWith(swarm.key + "/")) invalidKeys.add(step.key);
    await cleanupBackgroundSteps(this, runId, new Set(run.steps.filter(step => ["spawn", "swarm"].includes(step.kind) && invalidKeys.has(step.key)).map(step => step.key)));
    await this.root.commit(async tx => {
      const current = storedRun((await tx.doc(RunStore)).runs[runId]);
      current.attempt++; current.status = "queued";
      delete current.error; delete current.result; delete current.resultRef; delete current.endedAt; delete current.cancelRequested; delete current.waitingFor;
      if (changed) {
        current.workflow.hash = loaded.hash; current.workflow.name = loaded.definition.name;
        current.steps = []; current.helpers = {}; current.positions = {}; current.nextSequence = 0; current.signals = {}; current.phases = [];
      } else {
        for (const step of current.steps) if (invalidKeys.has(step.key)) {
          step.status = "pending"; step.generation = current.attempt; step.attempts = 0;
          delete step.result; delete step.resultRef; delete step.error; delete step.conversationId; delete step.submissionId;
          delete step.taskId; delete step.deadline; delete step.endedAt; delete step.startedAt; delete step.outputRound; delete step.agentAttempt;
          delete step.accountedUsage; delete step.retryAt;
        }
        if (boundary) for (const [key, helper] of Object.entries(current.helpers)) if ((helper.sequence ?? -1) >= boundary.sequence) delete current.helpers[key];
        if (boundary) for (const [slot, position] of Object.entries(current.positions ?? {}))
          if (invalidKeys.has(position.key) || position.sequence >= boundary.sequence) delete current.positions![slot];
      }
      current.taskId = await tx.createTask(this.runTask, { runId }, { ownership: { kind: "conversation" }, background: true });
    }, context);
    this.harness.resume(); return this.get(runId);
  }

  async signal(runId: string, key: string, value: unknown): Promise<{ runId: string; key: string; accepted: true }> {
    await this.mutate(runId, run => {
      const step = run.steps.find(item => item.kind === "signal" && item.signalKey === key);
      if (!step) throw new WorkflowError("unknown_signal", `No waiting signal '${key}'. Use status --verbose to see the requested key.`);
      if (step.schema && !Value.Check(step.schema, value)) throw new WorkflowError("invalid_signal", `Signal '${key}' does not match its schema.`);
      const data = json(value);
      if (Object.hasOwn(run.signals, key) && JSON.stringify(run.signals[key]) !== JSON.stringify(data))
        throw new WorkflowError("signal_already_set", `Signal '${key}' already has a different durable value.`);
      if (!Object.hasOwn(run.signals, key)) run.signals[key] = data;
    });
    return { runId, key, accepted: true };
  }

  async revert(runId: string, keepWorktrees = false, owner?: TaskId): Promise<RunData> {
    const run = await this.get(runId);
    if (run.status === "reverted") { await cleanupBackground(this, runId, true); return this.get(runId); }
    if (["queued", "running", "waiting_signal"].includes(run.status)) await this.cancel(runId);
    else await cleanupBackground(this, runId, true);
    const loaded = await loadWorkflow({ path: run.workflow.path }, run.cwd);
    if (loaded.hash !== run.workflow.hash) throw new WorkflowError("definition_changed", "Restore the original workflow file before reverting its recorded compensations.");
    let taskId: TaskId | undefined;
    await this.root.commit(async tx => {
      const current = storedRun((await tx.doc(RunStore)).runs[runId]);
      taskId = await tx.createTask(this.runTask, { runId, mode: "revert" }, { ownership: owner ? { kind: "task", taskId: owner } : { kind: "conversation" }, background: !owner });
      current.taskId = taskId; current.status = "running"; current.reverting = true; current.keepWorktrees = keepWorktrees;
      delete current.error; delete current.cancelRequested;
    }, context);
    await this.harness.waitForTask(taskId!, context);
    return this.get(runId);
  }

  async executeRevert(runId: string, runtime: RunRuntime, ctx: Context): Promise<void> {
    try {
      const run = await this.get(runId);
      const loaded = await loadWorkflow({ path: run.workflow.path }, run.cwd);
      if (loaded.hash !== run.workflow.hash) throw new WorkflowError("definition_changed", "Restore the original workflow file before reverting.");
      const execution = new Execution(this, runId, runtime, ctx);
      await execution.run(loaded.definition, true);
      for (const step of [...run.steps].sort((a, b) => b.sequence - a.sequence)) {
        if (step.kind === "workflow" && step.childRunId) await this.revert(step.childRunId, run.keepWorktrees, runtime.taskId);
        if (step.status !== "completed" || !step.compensatable) continue;
        const compensate = execution.compensations.get(step.key);
        if (!compensate) throw new WorkflowError("missing_compensation", `Could not reconstruct compensation for ${step.key}.`, step.key);
        if (await runtime.memo(`compensate:${step.key}`, ctx)) throw new WorkflowError("interrupted_compensation", `Compensation for ${step.key} was interrupted. Inspect external state before invoking revert again.`, step.key);
        await runtime.memo(`compensate:${step.key}`, true, ctx);
        const result = await this.readResult(step);
        await outsideScript(() => compensate(result));
        await runtime.commit(async tx => {
          storedRun((await tx.doc(RunStore)).runs[runId]).steps.find(item => item.key === step.key)!.status = "compensated";
          return undefined;
        }, ctx);
      }
      if (!run.keepWorktrees) for (const step of run.steps) if (step.worktree) await removeWorktree(step.worktreeCwd ?? run.cwd, step.worktree);
      await runtime.commit(async tx => {
        const current = storedRun((await tx.doc(RunStore)).runs[runId]);
        current.status = "reverted"; current.endedAt = runtime.now(); delete current.reverting;
        return { status: "terminal", outcome: { status: "completed", result: null } };
      }, ctx);
    } catch (error) {
      if (runtime.signal.aborted) throw error;
      await runtime.commit(async tx => {
        const current = storedRun((await tx.doc(RunStore)).runs[runId]);
        current.status = "failed"; current.endedAt = runtime.now(); delete current.reverting;
        current.error = { message: error instanceof Error ? error.message : String(error), reason: error instanceof WorkflowError ? error.code : "revert_failed" };
        return { status: "terminal", outcome: { status: "failed", error: { message: current.error.message } } };
      }, ctx);
    }
  }

  async request(request: ControlRequest): Promise<unknown> {
    const work = () => outsideScript(() => this.handle(request));
    if (["status", "list", "result", "agents"].includes(request.action)) return work();
    const result = this.pending.then(work);
    this.pending = result.catch(() => {});
    return result;
  }

  private async handle(request: ControlRequest): Promise<unknown> {
    if (request.action === "run") return this.launch(request);
    if (request.action === "status") return publicRun(await this.describe(request.runId));
    if (request.action === "result") {
      const run = await this.get(request.runId);
      if (["queued", "running", "waiting_signal"].includes(run.status))
        throw new WorkflowError("result_not_ready", `Run ${run.id} is ${run.status}. Use poll ${run.id} --until done.`);
      if (run.status !== "completed") throw new WorkflowError(run.error?.reason ?? "run_failed", run.error?.message ?? `Run ${run.id} is ${run.status}.`);
      return this.readResult(run);
    }
    if (request.action === "list") {
      const values = Object.values((await this.harness.snapshot(RunStore, context))?.runs ?? {}).map(storedRun);
      return copy(values.filter(run => (request.filter?.all || run.origin.kind !== "workflow") &&
        (!request.filter?.status?.length || request.filter.status.includes(run.status)) &&
        (!request.filter?.workflow || request.filter.workflow === run.workflow.name))
        .sort((a, b) => b.createdAt - a.createdAt).slice(0, request.filter?.limit ?? 100).map(publicRun));
    }
    if (request.action === "cancel") return publicRun(await this.cancel(request.runId));
    if (request.action === "retry") return publicRun(await this.retry(request.runId, request.from, request.allowChanged));
    if (request.action === "signal") return this.signal(request.runId, request.key, request.value);
    if (request.action === "revert") return publicRun(await this.revert(request.runId, request.keepWorktrees));
    if (request.action === "agents") return listBackgroundAgents(this, request.runId);
    if (request.action === "steer") return steerBackgroundAgent(this, request.runId, request.agent, request.message);
    throw new WorkflowError("unsupported_action", `Engine action ${request.action} is not available in this slice.`);
  }

  close(): Promise<void> { return this.harness.close(context); }
}

export async function openEngine(storage: Storage, models: Models, options: EngineOptions): Promise<Engine> {
  installDeterminismGuard();
  // Git reports worktrees by real path. A symlinked home (for example /tmp on
  // macOS) must not make owned worktrees look foreign.
  options = { ...options, home: await realpath(options.home).catch(() => resolve(options.home)) };
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(SwarmTools);
  let engine: Engine;
  const runTask = defineTask<RunInput, RunCheckpoint, null>({
    name: "workflow.run", version: 1, initial: input => ({ phase: input.mode === "revert" ? "revert" : "script" }),
    phases: { script: async (task, runtime, ctx) => engine.execute(task.input.runId, runtime, ctx),
      revert: async (task, runtime, ctx) => engine.executeRevert(task.input.runId, runtime, ctx) },
    abort: async (task, runtime, ctx) => {
      await cleanupBackground(engine, task.input.runId, true);
      for (const step of (await engine.get(task.input.runId)).steps) if (step.kind === "agent" && step.conversationId) {
        await engine.accountConversation(task.input.runId, step.key, Number(step.conversationId) as ConversationId);
        engine.semaphore.releaseReservation(step.conversationId);
      }
      await runtime.commit(async tx => {
        const run = storedRun((await tx.doc(RunStore)).runs[task.input.runId]);
        run.status = "cancelled";
        run.endedAt = runtime.now();
        for (const step of run.steps) if (["pending", "running"].includes(step.status)) step.status = "cancelled";
        return { status: "terminal", outcome: { status: "aborted" } };
      }, ctx);
    },
  });
  const stepTask = effectTask(() => engine);
  registry.install(defineExtension({ name: "workflow.engine", tasks: [runTask, stepTask, ...backgroundTasks(() => engine)] }));
  registry.install(budgetExtension(() => engine));
  const harness = await Harness.open(storage, {
    models, registry, now: options.now, setTimer: options.setTimer,
    settings: { extensions: [CodingTools], restartLimit: 5, retry: { maxRetries: 0 }, afterFailedRun: "continue" },
    env: async ({ cwd, conversationId, read }, ctx) => {
      const meta = await read.snapshot(AgentMeta, conversationId, ctx);
      const shellEnv = { ...process.env };
      if (meta?.runId) { shellEnv.PI_WORKFLOW_RUN_ID = meta.runId; shellEnv.PI_WORKFLOW_STEP = meta.stepKey; }
      return new NodeExecutionEnv({ cwd: cwd ?? process.cwd(), shellEnv });
    },
    onReport: options.onReport ?? ((error, info) => console.error(`[workflow ${info.type}]`, error)),
  }, context);
  const root = await harness.root(context);
  engine = new Engine(harness, root, registry, models, options, runTask, stepTask);
  for (const value of Object.values((await harness.snapshot(RunStore, context))?.runs ?? {})) {
    const run = storedRun(value);
    for (const step of run.steps) if (step.schema && ["agent", "spawn"].includes(step.kind)) structuredTool(registry, run.id, step.key, step.schema);
    try {
      const loaded = await loadWorkflow({ path: run.workflow.path }, run.cwd);
      if (loaded.hash === run.workflow.hash && loaded.definition.tools?.length)
        registry.install(defineExtension({ name: `workflow.tools.${run.workflow.hash}`, tools: loaded.definition.tools }));
    } catch { /* The run task records missing or changed definitions as an actionable failure. */ }
  }
  for (const item of (await harness.inspect(context)).tasks) if (item.record.kind === "pi.generation") {
    const meta = await harness.snapshot(AgentMeta, item.record.conversationId, context);
    if (meta?.runId) engine.semaphore.reserve(String(item.record.conversationId));
  }
  harness.resume();
  return engine;
}
