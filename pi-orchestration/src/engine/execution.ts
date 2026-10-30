import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { configure, defineExtension, UsageDoc, type ConversationId, type EntryRecord, type ToolRegistration, type TaskId } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { withAbortSignal, type Context } from "@earendil-works/chord/context";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import type { AgentOptions, PipelineStage, Settled, StepContext, StepRecord, WorkflowContext, WorkflowDefinition } from "../index.ts";
import { WorkflowError } from "../errors.ts";
import type { Engine, RunRuntime } from "./index.ts";
import { AgentMeta, copy, json, RunStore, storedRun, StructuredResult, type JournalEntry, type RunData } from "./store.ts";
import { outsideScript, randomValue, scopedSignal, scriptScope, structuralKey } from "./scopes.ts";
import { signalMismatch } from "./mismatch.ts";
import { Semaphore } from "./semaphore.ts";
import { structuredTool } from "./structured.ts";
import { ensureWorktree, worktreeSuffix } from "./worktrees.ts";
import { BackgroundRuntime } from "./background.ts";
import { runSwarm } from "./swarm.ts";

// Options ctx.agent and ctx.spawn accept; a misspelled one must not silently fall back to defaults.
const AGENT_OPTIONS = ["model", "thinkingLevel", "instructions", "tools", "cwd", "isolation", "budget", "timeoutMs", "retries", "label", "phase", "agentType", "key", "schema"];

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function answerText(entry: EntryRecord | undefined): string {
  return entry?.model?.flatMap(message => message.role === "assistant" ?
    message.content.filter(block => block.type === "text").map(block => block.text) : []).join("\n") ?? "";
}
export class ReconstructionComplete extends Error {}

export class Execution {
  private definition!: WorkflowDefinition;
  private state!: RunData;
  private writes: Promise<unknown> = Promise.resolve();
  private currentPhase?: string;
  private readonly visited = new Set<string>();
  reconstructing = false;
  readonly compensations = new Map<string, (result: unknown) => Promise<void>>();
  readonly engine: Engine;
  readonly runId: string;
  readonly runtime: RunRuntime;
  readonly context: Context;
  constructor(engine: Engine, runId: string, runtime: RunRuntime, context: Context) {
    this.engine = engine; this.runId = runId; this.runtime = runtime; this.context = context;
  }
  get workflowDefinition(): WorkflowDefinition { return this.definition; }
  get runState(): RunData { return this.state; }
  async refreshUsage(): Promise<void> { this.state.usage = (await this.engine.get(this.runId)).usage; }
  replayChildren(key: string): void {
    for (const [slot, position] of Object.entries(this.state.positions ?? {}))
      if (position.key.startsWith(key + "/")) this.visited.add(slot);
  }

  async run(definition: WorkflowDefinition, reconstruct = false): Promise<unknown> {
    this.reconstructing = reconstruct;
    this.definition = definition;
    this.state = await this.engine.get(this.runId);
    const background = new BackgroundRuntime(this);
    const execution = this;
    const ctx: WorkflowContext = {
      runId: this.runId, args: copy(this.state.args), cwd: this.state.cwd, depth: this.state.depth,
      get budget() { return outsideScript(() => execution.helper("budget", () => ({
        costUsd: execution.state.limits.maxCostUsd === undefined ? null : Math.max(0, execution.state.limits.maxCostUsd - (execution.state.usage.costUsd ?? 0)),
        agents: execution.state.limits.maxAgents === undefined ? null : Math.max(0, execution.state.limits.maxAgents - execution.state.usage.agents),
      })) as WorkflowContext["budget"]); },
      agent: ((prompt: string, options?: AgentOptions & { schema?: TSchema }) => {
        const key = structuralKey("agent", options?.key);
        return outsideScript(async () => { const result = await this.agent(key, prompt, options ?? {}); this.state.usage = (await this.engine.get(this.runId)).usage; return result; });
      }) as WorkflowContext["agent"],
      phase: title => outsideScript(() => this.phase(title)),
      log: (message, data) => outsideScript(() => this.log(message, data)),
      now: () => outsideScript(() => this.helper("now", () => this.runtime.now()) as number),
      random: () => outsideScript(() => this.helper("random", randomValue) as number),
      parallel: ((thunks: Array<() => Promise<unknown>>, options?: { concurrency?: number; failure?: "null" | "failFast" | "allSettled" }) => {
        const key = structuralKey("parallel");
        return outsideScript(() => this.parallel(key, thunks, options));
      }) as WorkflowContext["parallel"],
      pipeline: ((items: unknown[], ...stages: Array<PipelineStage<unknown, unknown, unknown>>) => {
        const key = structuralKey("pipeline");
        return outsideScript(() => this.pipeline(key, items, stages));
      }) as WorkflowContext["pipeline"],
      step: <T>(key: string, fn: (step: StepContext) => Promise<T>, options?: { retries?: number; compensate?: (value: T) => Promise<void> }) => {
        const fullKey = structuralKey("step", key);
        return outsideScript(() => this.step(fullKey, fn, options));
      },
      workflow: <R>(ref: string | { path: string }, args?: unknown) => {
        const key = structuralKey("workflow");
        return outsideScript(() => this.workflow(key, ref, args)) as Promise<R>;
      },
      signal: ((name: string, options?: { schema?: TSchema; timeoutMs?: number; prompt?: string }) => {
        const key = structuralKey("signal", name);
        return outsideScript(() => this.signal(key, name, options));
      }) as WorkflowContext["signal"],
      sleep: (ms: number) => { const key = structuralKey("sleep"); return outsideScript(() => this.sleep(key, ms)); },
      spawn: options => { const key = structuralKey("spawn", options.key); return outsideScript(async () => {
        const handle = await background.spawn(key, options); await this.refreshUsage(); return handle;
      }); },
      swarm: options => { const key = structuralKey("swarm"); return outsideScript(async () => {
        const result = await runSwarm(this, key, options); await this.refreshUsage(); return result;
      }); },
    };
    const duration = new AbortController();
    const signal = AbortSignal.any([this.runtime.signal, duration.signal]);
    const limit = reconstruct ? undefined : this.state.limits.maxDurationMs;
    const disarm = limit === undefined ? undefined : this.runtime.setTimer(() => duration.abort(new WorkflowError("budget_exceeded", `Run exceeded maxDurationMs=${limit}.`)),
      Math.max(0, (this.state.startedAt ?? this.state.createdAt) + limit - this.runtime.now()));
    let unsubscribe = () => {};
    try {
      const cancelled = new Promise<never>((_resolve, reject) => {
        const abort = () => reject(signal.reason);
        if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
        unsubscribe = () => signal.removeEventListener("abort", abort);
      });
      let result: unknown;
      try { result = await Promise.race([scriptScope("root", () => definition.run(ctx), signal,
        (slot, key, kind) => outsideScript(() => this.claim(slot, key, kind))), cancelled]); }
      catch (error) { if (!(reconstruct && error instanceof ReconstructionComplete)) throw error; }
      await this.flush();
      if (!reconstruct) for (const [slot, position] of Object.entries(this.state.positions ?? {})) if (!this.visited.has(slot))
        throw new WorkflowError("journal_mismatch", `Previously recorded operation ${position.key} was omitted on replay.`, position.key);
      return result;
    } finally { disarm?.(); unsubscribe(); }
  }

  private queue(change: (run: RunData) => void): void {
    this.writes = this.writes.then(() => this.engine.mutate(this.runId, run => { this.runtime.signal.throwIfAborted(); change(run); }));
    void this.writes.catch(() => {});
  }
  private async flush(): Promise<void> { await this.writes; this.runtime.signal.throwIfAborted(); }

  private claim(slot: string, key: string, kind: string): void {
    this.visited.add(slot);
    this.state.positions ??= {};
    const old = this.state.positions[slot];
    if (old) {
      if (old.key !== key || old.kind !== kind)
        throw new WorkflowError("journal_mismatch", `Structural position ${slot} was ${old.key} (${old.kind}), now ${key} (${kind}).`, key);
      return;
    }
    if (this.reconstructing) throw new ReconstructionComplete();
    this.state.positions[slot] = { key, kind, sequence: this.state.nextSequence };
    this.queue(run => { run.positions ??= {}; run.positions[slot] = { key, kind, sequence: run.nextSequence }; });
  }

  private async complete(key: string, result: unknown): Promise<void> {
    if (this.reconstructing) return;
    await this.engine.mutate(this.runId, async (run, tx) => {
      this.runtime.signal.throwIfAborted();
      const step = run.steps.find(item => item.key === key)!;
      await this.engine.saveResult(tx, step, result);
      step.status = "completed"; step.endedAt = this.runtime.now();
    });
  }

  private async abortScope(prefix: string): Promise<void> {
    const run = await this.engine.get(this.runId);
    await Promise.all(run.steps.filter(step => step.key.startsWith(prefix + "/") && step.status === "running").map(async step => {
      if (step.conversationId) await (await this.engine.harness.conversation(Number(step.conversationId) as ConversationId, this.context))?.abort(this.context, { background: true });
      if (step.taskId) await this.engine.harness.abortTask(step.taskId, this.context);
    }));
  }

  async parallel(key: string, thunks: ReadonlyArray<() => Promise<unknown>>, options: { concurrency?: number; failure?: "null" | "failFast" | "allSettled" } = {}): Promise<unknown[]> {
    const record = await this.journal(key, "parallel", { count: thunks.length, ...options });
    if (this.reconstructing) {
      await Promise.all(thunks.map((thunk, index) => scriptScope(`${key}/${index}`, thunk).catch(error => { if (!(error instanceof ReconstructionComplete)) throw error; })));
      if (record.status !== "completed") throw new ReconstructionComplete();
      return this.engine.readResult(record) as Promise<unknown[]>;
    }
    if (record.status === "completed") { this.replayChildren(key); return this.engine.readResult(record) as Promise<unknown[]>; }
    const semaphore = new Semaphore(options.concurrency ?? Math.max(1, thunks.length));
    const controller = new AbortController();
    const signal = AbortSignal.any([scopedSignal(this.runtime.signal), controller.signal]);
    let failure: unknown;
    const settled = await Promise.all(thunks.map(async (thunk, index): Promise<Settled<unknown>> => {
      let release: (() => void) | undefined;
      try {
        release = await semaphore.acquire(signal);
        const value = await scriptScope(`${key}/${index}`, thunk, signal);
        return { status: "fulfilled", value };
      } catch (error) {
        const code = error instanceof WorkflowError ? error.code : undefined;
        const fatal = code && ["budget_exceeded", "journal_mismatch", "nondeterministic_call"].includes(code);
        if (!controller.signal.aborted && (options.failure === "failFast" || fatal)) {
          failure = error; controller.abort(error); await this.abortScope(key);
        }
        return { status: "rejected", reason: { message: error instanceof Error ? error.message : String(error), ...(code ? { code } : {}) } };
      } finally { release?.(); }
    }));
    this.runtime.signal.throwIfAborted();
    if (failure) throw failure;
    const result = options.failure === "allSettled" ? settled : settled.map(item => item.status === "fulfilled" ? item.value : null);
    await this.complete(key, result);
    return result;
  }

  private async pipeline(key: string, items: readonly unknown[], stages: Array<PipelineStage<unknown, unknown, unknown>>): Promise<unknown[]> {
    const record = await this.journal(key, "pipeline", { items, stages: stages.length });
    if (record.status === "completed" && !this.reconstructing) { this.replayChildren(key); return this.engine.readResult(record) as Promise<unknown[]>; }
    const result = await Promise.all(items.map(async (item, index) => {
      try {
        let value = item;
        for (let stage = 0; stage < stages.length; stage++)
          value = await scriptScope(`${key}/${index}/stage#${stage}`, () => stages[stage](value, item, index));
        return value;
      } catch (error) {
        if (error instanceof ReconstructionComplete) return null;
        if (error instanceof WorkflowError && ["budget_exceeded", "journal_mismatch", "nondeterministic_call"].includes(error.code)) throw error;
        return null;
      }
    }));
    if (this.reconstructing) {
      if (record.status !== "completed") throw new ReconstructionComplete();
      return this.engine.readResult(record) as Promise<unknown[]>;
    }
    await this.complete(key, result); return result;
  }

  private async step<T>(key: string, fn: (step: StepContext) => Promise<T>, options: { retries?: number; compensate?: (value: T) => Promise<void> } = {}): Promise<T> {
    const record = await this.journal(key, "step", { retries: options.retries ?? 0, compensate: !!options.compensate });
    if (options.compensate) this.compensations.set(key, value => options.compensate!(value as T));
    if (record.status === "completed" || record.status === "compensated") return this.engine.readResult(record) as Promise<T>;
    if (this.reconstructing) throw new ReconstructionComplete();
    this.engine.registerEffect(this.runId, key, fn);
    let taskId = record.taskId;
    if (!taskId) await this.runtime.commit(async tx => {
      const step = storedRun((await tx.doc(RunStore)).runs[this.runId]).steps.find(item => item.key === key)!;
      taskId = step.taskId ?? await tx.createTask(this.engine.stepTask, { runId: this.runId, key, retries: options.retries ?? 0 }, { ownership: { kind: "task", taskId: this.runtime.taskId } });
      step.taskId = taskId; step.status = "running"; step.compensatable = !!options.compensate;
      return undefined;
    }, this.context);
    const settled = await this.runtime.waitForTask(taskId!, withAbortSignal(scopedSignal(this.runtime.signal), this.context));
    if (settled.state.outcome.status === "completed") return this.engine.readResult((await this.engine.get(this.runId)).steps.find(step => step.key === key)!) as Promise<T>;
    const current = (await this.engine.get(this.runId)).steps.find(item => item.key === key)!;
    throw new WorkflowError(current.error?.reason ?? "step_failed", current.error?.message ?? `Step ${key} failed.`, key);
  }

  private helper(kind: string, candidate: () => unknown): unknown {
    const key = structuralKey(kind);
    const old = this.state.helpers[key];
    if (old) {
      if (old.kind !== kind) throw new WorkflowError("journal_mismatch", `Journal key ${key} was ${old.kind}, now ${kind}.`, key);
      return copy(old.value);
    }
    if (this.reconstructing) throw new ReconstructionComplete();
    const entry = { kind, value: json(candidate()) };
    this.state.helpers[key] = entry;
    this.queue(run => { run.helpers[key] = { ...copy(entry), sequence: run.nextSequence++ }; });
    return entry.value;
  }

  private phase(title: string): void {
    this.currentPhase = title;
    const key = structuralKey("phase");
    const old = this.state.helpers[key];
    if (old) {
      if (old.kind !== "phase" || old.value !== title) throw new WorkflowError("journal_mismatch", `Phase changed at ${key}.`, key);
      return;
    }
    if (this.reconstructing) throw new ReconstructionComplete();
    this.state.helpers[key] = { kind: "phase", value: title };
    this.queue(run => {
      run.helpers[key] = { kind: "phase", value: title, sequence: run.nextSequence++ };
      run.currentPhase = title;
      if (!run.phases.some(phase => phase.title === title)) run.phases.push({ title, agents: 0, done: 0, tokens: 0, elapsedMs: 0 });
    });
  }

  private log(message: string, data?: unknown): void {
    const key = structuralKey("log");
    if (this.state.helpers[key]) return;
    if (this.reconstructing) throw new ReconstructionComplete();
    const event = { time: this.runtime.now(), message, ...(data === undefined ? {} : { data: json(data) }) };
    this.state.helpers[key] = { kind: "log", value: json(event) };
    this.queue(run => { run.helpers[key] = { kind: "log", value: json(event), sequence: run.nextSequence++ }; run.logs.push(event); });
  }

  async journal(key: string, kind: StepRecord["kind"], input: unknown, options: { label?: string; phase?: string } = {}): Promise<JournalEntry> {
    await this.flush();
    const hash = fingerprint(input);
    return this.engine.mutate(this.runId, run => {
      this.runtime.signal.throwIfAborted();
      const old = run.steps.find(step => step.key === key);
      if (old) {
        if (old.kind !== kind || old.fingerprint !== hash)
          throw new WorkflowError("journal_mismatch", `Journal key ${key} no longer matches its recorded ${old.kind} operation.`, key);
        return copy(old);
      }
      if (this.reconstructing) throw new ReconstructionComplete();
      const step: JournalEntry = {
        key, kind, fingerprint: hash, sequence: run.nextSequence++, generation: run.attempt,
        status: "pending", attempts: 0, ...(options.label ? { label: options.label } : {}),
        ...(options.phase ?? this.currentPhase ? { phase: options.phase ?? this.currentPhase } : {}),
      };
      run.steps.push(step);
      return copy(step);
    });
  }

  resolveOptions(call: AgentOptions): AgentOptions {
    const unknown = Object.keys(call).filter(name => !AGENT_OPTIONS.includes(name));
    if (unknown.length) {
      const near = (name: string) => AGENT_OPTIONS.find(known => known.startsWith(name) || name.startsWith(known));
      const hints = unknown.map(name => near(name) ? `'${name}' (did you mean '${near(name)}'?)` : `'${name}'`);
      throw new WorkflowError("unknown_agent_option", `Unknown agent option ${hints.join(", ")}. Valid options: ${AGENT_OPTIONS.join(", ")}.`);
    }
    const spec = call.agentType ? this.definition.agents?.[call.agentType] : undefined;
    if (call.agentType && !spec) throw new WorkflowError("unknown_agent_type", `Unknown agentType '${call.agentType}'. Define it in workflow.agents.`);
    return { retries: this.engine.options.defaultRetries ?? 0, timeoutMs: this.engine.options.defaultTimeoutMs ?? 600_000,
      ...this.definition.defaults, ...spec, ...call };
  }

  tools(options: AgentOptions): ToolRegistration[] {
    // Resolve only this workflow's tool objects. Other active workflows may
    // register tools with the same name under their own extension identity.
    const available = [...this.definition.tools ?? [], ...CodingTools.tools ?? []];
    const defaultNames = ["read", "write", "edit", "bash"];
    const names = Array.isArray(options.tools) ? options.tools : defaultNames.filter(name => !options.tools || !("remove" in options.tools) || !options.tools.remove.includes(name));
    return names.map(name => {
      const tool = available.find(candidate => candidate.name === name);
      if (!tool) throw new WorkflowError("unknown_tool", `Unknown durable tool '${name}'. Add it to workflow.tools or use read/write/edit/bash.`);
      return tool;
    });
  }

  async checkBudget(key: string): Promise<void> {
    const run = await this.engine.get(this.runId);
    const limits = run.limits;
    const exceeded = limits.maxAgents !== undefined && run.usage.agents >= limits.maxAgents ||
      limits.maxCostUsd !== undefined && (run.usage.costUsd ?? 0) > limits.maxCostUsd ||
      limits.maxTokens !== undefined && run.usage.inputTokens + run.usage.outputTokens > limits.maxTokens ||
      limits.maxDurationMs !== undefined && this.runtime.now() - (run.startedAt ?? run.createdAt) >= limits.maxDurationMs;
    if (exceeded) throw new WorkflowError("budget_exceeded", `Run budget exceeded before ${key}. Inspect status --verbose for usage.`, key);
  }

  private wait(ms: number, signal = scopedSignal(this.runtime.signal)): Promise<void> {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const abort = () => { disarm(); reject(signal.reason); };
      const disarm = this.runtime.setTimer(() => { signal.removeEventListener("abort", abort); resolve(); }, Math.max(0, ms));
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  private async sleep(key: string, ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0) throw new WorkflowError("invalid_duration", "ctx.sleep(ms) requires a nonnegative finite duration.", key);
    const step = await this.journal(key, "sleep", { ms });
    if (step.status === "completed") return;
    if (this.reconstructing) throw new ReconstructionComplete();
    const deadline = await this.engine.mutate(this.runId, run => {
      const current = run.steps.find(item => item.key === key)!;
      current.status = "running"; current.startedAt ??= this.runtime.now(); current.deadline ??= this.runtime.now() + ms;
      return current.deadline;
    });
    if (deadline > this.runtime.now()) await this.wait(deadline - this.runtime.now());
    await this.complete(key, null);
  }

  private async signal(key: string, name: string, options: { schema?: TSchema; timeoutMs?: number; prompt?: string } = {}): Promise<unknown> {
    const step = await this.journal(key, "signal", { name, ...options });
    if (step.status === "completed") return this.engine.readResult(step);
    if (this.reconstructing) throw new ReconstructionComplete();
    const deadline = await this.engine.mutate(this.runId, run => {
      const current = run.steps.find(item => item.key === key)!;
      current.status = "running"; current.signalKey = name; current.startedAt ??= this.runtime.now();
      if (options.timeoutMs !== undefined) current.deadline ??= this.runtime.now() + options.timeoutMs;
      if (options.schema) current.schema = json(options.schema) as NonNullable<JournalEntry["schema"]>;
      if (options.prompt) current.signalPrompt = options.prompt;
      run.status = "waiting_signal";
      run.waitingFor = { key: name, ...(options.prompt ? { prompt: options.prompt } : {}), ...(current.schema ? { schema: current.schema } : {}), ...(current.deadline === undefined ? {} : { deadline: current.deadline }) };
      return current.deadline;
    });
    for (;;) {
      const run = await this.engine.get(this.runId);
      if (Object.hasOwn(run.signals, name)) {
        const value = run.signals[name];
        if (options.schema && !Value.Check(options.schema, value)) throw new WorkflowError("invalid_signal", signalMismatch(name, options.schema, value), key);
        await this.complete(key, value);
        await this.engine.mutate(this.runId, current => { current.status = "running"; delete current.waitingFor; });
        return copy(value);
      }
      if (deadline !== undefined && this.runtime.now() >= deadline) throw new WorkflowError("signal_timeout", `Signal '${name}' did not arrive before its deadline.`, key);
      await this.wait(Math.min(100, deadline === undefined ? 100 : Math.max(0, deadline - this.runtime.now())));
    }
  }

  private async workflow(key: string, ref: string | { path: string }, args?: unknown): Promise<unknown> {
    const record = await this.journal(key, "workflow", { ref, args: args ?? {} });
    if (record.status === "completed") return this.engine.readResult(record);
    if (this.reconstructing) throw new ReconstructionComplete();
    const workflow = typeof ref === "string" ? (/[/\\]|\.[cm]?[jt]s$/.test(ref) ? { path: ref } : { name: ref }) : ref;
    const launched = await this.engine.launch({ action: "run", requestId: `${this.runId}:${key}:${record.generation}`, workflow,
      args, cwd: this.state.cwd, model: this.state.model, origin: { kind: "workflow", parentRunId: this.runId, stepKey: key },
    }, { taskId: this.runtime.taskId, parentRunId: this.runId, stepKey: key });
    await this.engine.mutate(this.runId, run => { const step = run.steps.find(item => item.key === key)!; step.childRunId = launched.runId; step.status = "running"; step.startedAt ??= this.runtime.now(); });
    const child = await this.engine.get(launched.runId);
    await this.runtime.waitForTask(child.taskId!, withAbortSignal(scopedSignal(this.runtime.signal), this.context));
    const finished = await this.engine.get(launched.runId);
    if (finished.status !== "completed") throw new WorkflowError(finished.error?.reason ?? "child_failed", `Child workflow ${finished.workflow.name} ${finished.status}: ${finished.error?.message ?? ""}`, key);
    const result = await this.engine.readResult(finished);
    await this.complete(key, result);
    this.state.usage = (await this.engine.get(this.runId)).usage;
    return result;
  }

  async agent(key: string, prompt: string, call: AgentOptions & { schema?: TSchema }): Promise<unknown> {
    const options = this.resolveOptions(call);
    for (;;) {
      const current = (await this.engine.get(this.runId)).steps.find(step => step.key === key);
      if (current?.retryAt !== undefined) {
        if (current.retryAt > this.runtime.now()) await this.wait(current.retryAt - this.runtime.now());
        await this.engine.mutate(this.runId, run => { delete run.steps.find(step => step.key === key)!.retryAt; });
      }
      try { return await this.agentOnce(key, prompt, call); }
      catch (error) {
        if (this.reconstructing || scopedSignal(this.runtime.signal).aborted) throw error;
        if (!(error instanceof WorkflowError) || !["agent_failed", "agent_timeout", "invalid_structured_output"].includes(error.code)) throw error;
        const step = (await this.engine.get(this.runId)).steps.find(item => item.key === key)!;
        const attempt = step.agentAttempt ?? 1;
        if (attempt > (options.retries ?? 0)) throw error;
        await this.engine.mutate(this.runId, run => {
          const current = run.steps.find(item => item.key === key)!;
          current.retryAt = this.runtime.now() + this.engine.settings.retryBackoffMs * 2 ** (attempt - 1);
          current.agentAttempt = attempt + 1; current.status = "pending";
          delete current.conversationId; delete current.submissionId; delete current.outputRound;
          delete current.deadline; delete current.error; delete current.accountedUsage;
        });
      }
    }
  }

  private async accountUsage(key: string, conversationId: ConversationId): Promise<{ inputTokens: number; outputTokens: number; costUsd: number }> {
    return this.engine.accountConversation(this.runId, key, conversationId);
  }

  private async agentOnce(key: string, prompt: string, call: AgentOptions & { schema?: TSchema }): Promise<unknown> {
    const options = this.resolveOptions(call);
    const signal = scopedSignal(this.runtime.signal);
    const ctx = withAbortSignal(signal, this.context);
    const recorded = await this.journal(key, "agent", { prompt, options, schema: call.schema ?? null }, options);
    if (recorded.status === "completed") return this.engine.readResult(recorded);
    if (this.reconstructing) throw new ReconstructionComplete();
    if (!recorded.conversationId) await this.checkBudget(key);
    const release = await this.engine.semaphore.acquire(signal, recorded.conversationId);
    let disarm: (() => void) | undefined;
    let conversationId = recorded.conversationId === undefined ? undefined : Number(recorded.conversationId) as ConversationId;
    try {
      const structured = call.schema ? structuredTool(this.engine.registry, this.runId, key, call.schema) : undefined;
      const extra = this.definition.tools?.length ? defineExtension({ name: `workflow.tools.${this.state.workflow.hash}`, tools: this.definition.tools }) : undefined;
      if (extra) this.engine.registry.install(extra);
      if (!conversationId) {
        const selected = options.model ?? this.state.model ?? this.engine.options.defaultModel;
        if (!selected) throw new WorkflowError("no_model", "No model selected. Pass --model provider/model or set workflow.defaults.model.", key);
        const model = this.engine.resolveModel(selected);
        const tools = this.tools(options);
        if (structured) tools.push(structured.tool);
        let cwd = resolve(this.state.cwd, options.cwd ?? ".");
        if (options.isolation === "worktree") {
          const suffix = worktreeSuffix(options.label ?? key);
          const intent = { path: join(resolve(this.engine.options.home), "worktrees", this.runId, suffix), branch: `orch/${this.runId}/${suffix}` };
          await this.engine.mutate(this.runId, run => {
            const conflict = run.steps.find(step => step.key !== key && step.worktree?.path === intent.path);
            if (conflict) throw new WorkflowError("worktree_conflict", `Label '${options.label}' already belongs to ${conflict.key}. Use unique agent labels.`, key);
            const step = run.steps.find(item => item.key === key)!;
            step.worktree = intent; step.worktreeCwd = cwd;
            run.worktrees ??= []; if (!run.worktrees.some(tree => tree.path === intent.path)) run.worktrees.push(intent);
          });
          cwd = (await ensureWorktree({ home: this.engine.options.home, runId: this.runId, key, label: options.label, cwd })).path;
        }
        await this.runtime.commit(async tx => {
          const run = storedRun((await tx.doc(RunStore)).runs[this.runId]);
          const step = run.steps.find(item => item.key === key)!;
          if (step.conversationId) { conversationId = Number(step.conversationId) as ConversationId; return undefined; }
          await this.engine.reserveAgent(tx, this.runId);
          const child = await tx.createConversation({ ownership: { kind: "task", taskId: this.runtime.taskId } });
          conversationId = child.id;
          await configure(tx, child.id, {
            model, thinkingLevel: options.thinkingLevel ?? this.state.thinkingLevel,
            extensions: [CodingTools, this.engine.registry.snapshot().extension("workflow.budgets")!, ...(extra ? [extra] : []), ...(structured ? [structured.extension] : [])],
            tools, modelTools: tools, cwd,
            instructions: `You are an agent inside workflow ${this.state.workflow.name}, run ${this.runId}, step ${key}. Your answer is consumed by a program; make it complete and self-contained. You have only the durable tools configured here, not the parent Pi session's extensions, MCP servers or skills. Do not launch workflows; composition belongs in ctx.workflow() in the workflow definition.\n${options.instructions ?? ""}${structured ? "\nFinish by calling submit_result with the schema-valid result; prose alone does not complete this task." : ""}`,
          });
          const meta = await tx.doc(AgentMeta, child.id);
          meta.runId = this.runId; meta.stepKey = key; meta.options = json(options) as typeof meta.options;
          step.conversationId = String(child.id); step.status = "running";
          step.startedAt ??= this.runtime.now(); step.attempts++; step.agentAttempt ??= 1;
          step.deadline ??= this.runtime.now() + (options.timeoutMs ?? 600_000);
          if (call.schema) step.schema = json(call.schema) as NonNullable<JournalEntry["schema"]>;
          if (step.phase) {
            let phase = run.phases.find(item => item.title === step.phase);
            if (!phase) { phase = { title: step.phase, agents: 0, done: 0, tokens: 0, elapsedMs: 0 }; run.phases.push(phase); }
            phase.agents++;
          }
          return undefined;
        }, this.context);
      }
      const child = await this.runtime.conversation(conversationId!, ctx);
      if (!child) throw new WorkflowError("missing_conversation", `Missing agent conversation for ${key}.`, key);
      const current = (await this.engine.get(this.runId)).steps.find(step => step.key === key)!;
      const timeout = new AbortController();
      const timeoutError = new WorkflowError("agent_timeout", `Agent ${key} exceeded timeoutMs=${options.timeoutMs}.`, key);
      disarm = this.runtime.setTimer(() => timeout.abort(timeoutError), Math.max(0, current.deadline! - this.runtime.now()));
      const waitContext = withAbortSignal(AbortSignal.any([signal, timeout.signal]), ctx);
      let result: unknown;
      let failed: WorkflowError | undefined;
      for (let round = current.outputRound ?? 0; ; round++) {
        const submission = await child.submit({ type: "input",
          content: round ? "Your result was missing or invalid. Call submit_result now with the complete schema-valid result." : prompt,
          requestId: `${this.runId}:${key}:${recorded.generation}:${current.agentAttempt ?? 1}:output:${round}`,
        }, waitContext);
        const settled = await submission.wait(waitContext);
        if (settled.status !== "done") {
          const meta = await this.engine.harness.snapshot(AgentMeta, conversationId!, ctx);
          failed = new WorkflowError(meta?.budgetError ? "budget_exceeded" : "agent_failed", meta?.budgetError ?? `Agent ${key} did not finish: ${settled.reason}.`, key); break;
        }
        if (!structured) {
          result = await this.engine.root.commit(async tx => answerText(settled.answer === undefined ? undefined : await tx.entry(settled.answer)), ctx);
          break;
        }
        const output = await this.engine.harness.snapshot(StructuredResult, conversationId!, ctx);
        if (output?.submitted) { result = copy(output.value); break; }
        if (round >= this.engine.settings.structuredRetries) { failed = new WorkflowError("invalid_structured_output", `Agent ${key} did not call submit_result after ${round + 1} attempts.`, key); break; }
        await this.runtime.commit(async tx => {
          const step = storedRun((await tx.doc(RunStore)).runs[this.runId]).steps.find(item => item.key === key)!;
          step.outputRound = round + 1; step.attempts++;
          await configure(tx, conversationId!, { modelTools: [structured.tool] });
          return undefined;
        }, ctx);
      }
      const sum = await this.accountUsage(key, conversationId!);
      await this.runtime.commit(async tx => {
        const run = storedRun((await tx.doc(RunStore)).runs[this.runId]);
        const step = run.steps.find(item => item.key === key)!;
        step.status = failed ? "failed" : "completed"; step.endedAt = this.runtime.now();
        if (!failed) await this.engine.saveResult(tx, step, result);
        else step.error = { message: failed.message, reason: failed.code };
        const phase = run.phases.find(item => item.title === step.phase);
        if (phase) { phase.done++; phase.tokens += sum.inputTokens + sum.outputTokens; phase.elapsedMs += step.endedAt - (step.startedAt ?? step.endedAt); }
        return undefined;
      }, this.context);
      if (failed) throw failed;
      await this.engine.assertUsageWithinBudget(this.runId, key);
      return result;
    } catch (error) {
      if (conversationId && !this.runtime.signal.aborted)
        await (await this.engine.harness.conversation(conversationId, this.context))?.abort(this.context);
      if (conversationId && !this.runtime.signal.aborted) await this.accountUsage(key, conversationId);
      if (!this.runtime.signal.aborted) await this.engine.mutate(this.runId, run => {
        const step = run.steps.find(item => item.key === key)!;
        step.status = "failed"; step.endedAt = this.runtime.now();
        step.error = { message: error instanceof Error ? error.message : String(error), ...(error instanceof WorkflowError ? { reason: error.code } : {}) };
      });
      throw error;
    } finally { disarm?.(); release(); }
  }
}
