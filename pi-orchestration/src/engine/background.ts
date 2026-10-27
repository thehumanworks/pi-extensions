import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import {
  configure, defineDoc, defineExtension, defineTask, UsageDoc,
  type ConversationId, type EntryRecord, type Extension, type JsonObject, type Task, type TaskId, type Tx,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { TSchema } from "typebox";
import type { AgentOptions, BackgroundAgent, BackgroundAgentRecord, Usage } from "../index.ts";
import { WorkflowError } from "../errors.ts";
import type { Engine } from "./index.ts";
import { ReconstructionComplete, type Execution } from "./execution.ts";
import { AgentMeta, copy, json, RunStore, storedRun, StructuredResult } from "./store.ts";
import { outsideScript, scopedSignal, structuralKey } from "./scopes.ts";
import { structuredTool } from "./structured.ts";
import { ensureWorktree, worktreeSuffix } from "./worktrees.ts";

interface AgentRecord {
  id: string;
  runId: string;
  key: string;
  name: string;
  conversationId: ConversationId;
  anchorTask: TaskId;
  detached: boolean;
  stopped: boolean;
  options: AgentOptions;
  extensions: string[];
  tools: string[];
  usage: Usage;
  schema?: TSchema;
  initialMessage?: string;
  lastMessage?: string;
  lastTask?: TaskId;
  activeMessage?: string;
}

interface MessageRecord {
  id: string;
  agentId: string;
  taskId: TaskId;
  prompt: string;
  whenBusy: "steer" | "followUp";
  previousTask?: TaskId;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  attempt: number;
  outputRound: number;
  prepared: boolean;
  deadline?: number;
  result?: JsonValue;
  resultRef?: string;
  error?: { code: string; message: string };
}

export const BackgroundStore = defineDoc<{
  agents: Record<string, JsonObject>;
  messages: Record<string, JsonObject>;
}>({
  kind: "workflow.background", version: 1, scope: "session",
  initial: () => ({ agents: {}, messages: {} }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 100,
});

const agentRecord = (value: JsonObject): AgentRecord => value as unknown as AgentRecord;
const messageRecord = (value: JsonObject): MessageRecord => value as unknown as MessageRecord;
type AnchorInput = { agentId: string };
type AnchorState = { phase: "hold"; tick: number };
type AnchorTask = Task<AnchorInput, AnchorState, null, object>;
type MessageInput = { messageId: string };
type MessageState = { phase: "deliver" } | { phase: "backoff"; until: number };
type MessageTask = Task<MessageInput, MessageState, JsonValue, object>;

function definitions(engine: Engine): { anchor: AnchorTask; message: MessageTask } {
  const registry = engine.registry.snapshot();
  const anchor = registry.task("workflow.background.anchor") as AnchorTask | undefined;
  const message = registry.task("workflow.background.message") as MessageTask | undefined;
  if (!anchor || !message) throw new Error("Background task definitions were not installed before opening the engine.");
  return { anchor, message };
}

async function readAgent(engine: Engine, id: string, ctx = BACKGROUND_CONTEXT): Promise<AgentRecord> {
  const data = (await engine.harness.snapshot(BackgroundStore, ctx))?.agents[id];
  if (!data) throw new WorkflowError("agent_not_found", `Unknown background agent ${id}. Use pi-workflow agents.`);
  return copy(agentRecord(data));
}

function answer(entry: EntryRecord | undefined): string {
  return entry?.model?.flatMap(message => message.role === "assistant"
    ? message.content.filter(block => block.type === "text").map(block => block.text) : []).join("\n") ?? "";
}

async function accountBackgroundUsage(engine: Engine, agentId: string, ctx: Context): Promise<void> {
  const agent = await readAgent(engine, agentId, ctx);
  const usage = await engine.harness.snapshot(UsageDoc, agent.conversationId, ctx);
  const total = Object.values(usage?.models ?? {}).concat(Object.values(usage?.tools ?? {})).reduce((sum, value) => ({
    inputTokens: sum.inputTokens + value.input + value.cacheRead + value.cacheWrite,
    outputTokens: sum.outputTokens + value.output, costUsd: sum.costUsd + value.cost.total,
  }), { inputTokens: 0, outputTokens: 0, costUsd: 0 });
  await engine.root.commit(async tx => {
    const current = agentRecord((await tx.doc(BackgroundStore)).agents[agentId]);
    const delta = { inputTokens: total.inputTokens - current.usage.inputTokens,
      outputTokens: total.outputTokens - current.usage.outputTokens, costUsd: total.costUsd - (current.usage.costUsd ?? 0) };
    await engine.addUsage(tx, agent.runId, delta);
    current.usage = total;
    const run = storedRun((await tx.doc(RunStore)).runs[agent.runId]);
    const step = run.steps.find(step => step.key === agent.key);
    if (step) {
      step.usage = total;
      const phase = run.phases.find(phase => phase.title === step.phase);
      if (phase) phase.tokens += delta.inputTokens + delta.outputTokens;
    }
  }, ctx);
}

async function enqueueInTx(engine: Engine, tx: Tx, agentId: string, id: string, prompt: string, whenBusy: "steer" | "followUp"): Promise<MessageRecord> {
  const store = await tx.doc(BackgroundStore);
  if (store.messages[id]) {
    const old = messageRecord(store.messages[id]);
    if (old.agentId !== agentId || old.prompt !== prompt || old.whenBusy !== whenBusy)
      throw new WorkflowError("journal_mismatch", `Background message ${id} changed on replay.`);
    return copy(old);
  }
  const agent = agentRecord(store.agents[agentId]);
  if (!agent || agent.stopped) throw new WorkflowError("agent_stopped", "The background agent is stopped. Spawn a new agent to continue.");
  const taskId = await tx.createTask(definitions(engine).message, { messageId: id }, { ownership: { kind: "task", taskId: agent.anchorTask } });
  const item: MessageRecord = {
    id, agentId, taskId, prompt, whenBusy, status: "queued", attempt: 1, outputRound: 0, prepared: false,
    ...(agent.lastTask ? { previousTask: agent.lastTask } : {}),
  };
  store.messages[id] = json(item) as JsonObject;
  agent.lastMessage = id; agent.lastTask = taskId;
  return item;
}

export async function enqueueBackground(engine: Engine, agentId: string, id: string, prompt: string, whenBusy: "steer" | "followUp" = "followUp"): Promise<MessageRecord> {
  return engine.root.commit(tx => enqueueInTx(engine, tx, agentId, id, prompt, whenBusy), BACKGROUND_CONTEXT);
}

export async function waitBackgroundMessage(engine: Engine, id: string, ctx: Context): Promise<JsonValue> {
  const data = (await engine.harness.snapshot(BackgroundStore, ctx))?.messages[id];
  if (!data) throw new WorkflowError("message_not_found", `No message ${id} is available. Send a message before waiting.`);
  const item = messageRecord(data);
  const settled = await engine.harness.waitForTask(item.taskId, ctx);
  const latest = messageRecord((await engine.harness.snapshot(BackgroundStore, ctx))!.messages[id]);
  if (settled.state.outcome.status !== "completed")
    throw new WorkflowError(latest.error?.code ?? "agent_failed", latest.error?.message ?? `Background message ended ${settled.state.outcome.status}.`);
  return json(latest.resultRef ? await engine.readResult(latest) : latest.result ?? settled.state.outcome.result);
}

export async function stopBackgroundAgent(engine: Engine, id: string, ctx = BACKGROUND_CONTEXT): Promise<void> {
  const agent = await readAgent(engine, id, ctx);
  if (agent.stopped) return;
  await engine.harness.abortTask(agent.anchorTask, ctx);
  await engine.harness.waitForTask(agent.anchorTask, ctx);
}

export async function cleanupBackground(engine: Engine, runId: string, includeDetached = false): Promise<void> {
  const agents = Object.values((await engine.harness.snapshot(BackgroundStore, BACKGROUND_CONTEXT))?.agents ?? {})
    .map(agentRecord).filter(agent => agent.runId === runId && (includeDetached || !agent.detached) && !agent.stopped);
  await Promise.all(agents.map(agent => stopBackgroundAgent(engine, agent.id)));
}

/** Stop the old conversations before retry invalidates their spawn/swarm journal entries. */
export async function cleanupBackgroundSteps(engine: Engine, runId: string, keys: ReadonlySet<string>): Promise<void> {
  const agents = Object.values((await engine.harness.snapshot(BackgroundStore, BACKGROUND_CONTEXT))?.agents ?? {})
    .map(agentRecord).filter(agent => agent.runId === runId && !agent.stopped &&
      [...keys].some(key => agent.key === key || agent.key.startsWith(`${key}/`)));
  await Promise.all(agents.map(agent => stopBackgroundAgent(engine, agent.id)));
}

export async function listBackgroundAgents(engine: Engine, runId?: string): Promise<BackgroundAgentRecord[]> {
  const store = await engine.harness.snapshot(BackgroundStore, BACKGROUND_CONTEXT);
  return Object.values(store?.agents ?? {}).map(agentRecord).filter(agent => !runId || agent.runId === runId).map(agent => ({
    runId: agent.runId, name: agent.name, conversationId: String(agent.conversationId), detached: agent.detached,
    active: !agent.stopped && agent.activeMessage !== undefined,
    status: agent.stopped ? "stopped" : Object.values(store?.messages ?? {}).some(value => {
      const item = messageRecord(value);
      return item.agentId === agent.id && (item.status === "queued" || item.status === "running");
    }) ? "busy" : "idle",
  }));
}

export async function steerBackgroundAgent(engine: Engine, runId: string, name: string, message: string): Promise<{ runId: string; agent: string; delivered: "steer" }> {
  const store = await engine.harness.snapshot(BackgroundStore, BACKGROUND_CONTEXT);
  const agent = Object.values(store?.agents ?? {}).map(agentRecord).find(item => item.runId === runId && item.name === name && !item.stopped);
  if (!agent) throw new WorkflowError("agent_not_found", `No active background agent '${name}' in run ${runId}. Use pi-workflow agents --run ${runId}.`);
  await enqueueBackground(engine, agent.id, `${agent.id}/external:${randomUUID()}`, message, "steer");
  return { runId, agent: name, delivered: "steer" };
}

export class BackgroundRuntime {
  readonly execution: Execution;
  constructor(execution: Execution) { this.execution = execution; }

  async spawn(key: string, input: AgentOptions & { name: string; initialPrompt?: string; detach?: boolean }): Promise<BackgroundAgent> {
    const agent = await this.create(key, input);
    const execution = this.execution;
    let lastMessage = agent.initialMessage;
    return {
      name: agent.name, conversationId: String(agent.conversationId),
      send: (message, options) => {
        const callKey = structuralKey("send");
        return outsideScript(async () => {
          const record = await execution.journal(callKey, "step", { operation: "background.send", agent: agent.id, message, whenBusy: options?.whenBusy ?? "followUp" });
          const id = `${agent.id}/${callKey}`;
          if (record.status !== "completed") {
            if (execution.reconstructing) throw new ReconstructionComplete();
            await enqueueBackground(execution.engine, agent.id, id, message, options?.whenBusy);
            await this.complete(callKey, id);
          }
          lastMessage = id;
        });
      },
      wait: options => {
        const callKey = structuralKey("wait");
        return outsideScript(async () => {
          const target = lastMessage ?? (await readAgent(execution.engine, agent.id)).lastMessage;
          if (!target) throw new WorkflowError("message_not_found", `Background agent '${agent.name}' has no message. Call send() or supply initialPrompt.`, callKey);
          const record = await execution.journal(callKey, "step", { operation: "background.wait", agent: agent.id, message: target, timeoutMs: options?.timeoutMs ?? null });
          if (record.status === "completed") {
            await execution.refreshUsage();
            return await execution.engine.readResult(record) as string;
          }
          if (execution.reconstructing) throw new ReconstructionComplete();
          const signal = scopedSignal(execution.runtime.signal);
          const timeout = new AbortController();
          const deadline = options?.timeoutMs ? await execution.runtime.memo(`background.wait:${callKey}`, execution.runtime.now() + options.timeoutMs, execution.context) : undefined;
          const disarm = deadline === undefined ? undefined : execution.runtime.setTimer(() => timeout.abort(new WorkflowError("agent_timeout", `Timed out waiting for '${agent.name}'.`, callKey)), Math.max(0, deadline - execution.runtime.now()));
          try {
            const value = await waitBackgroundMessage(execution.engine, target, withAbortSignal(AbortSignal.any([signal, timeout.signal]), execution.context));
            const text = typeof value === "string" ? value : JSON.stringify(value);
            await this.complete(callKey, text);
            await execution.refreshUsage();
            return text;
          } finally { disarm?.(); }
        });
      },
      status: () => {
        const callKey = structuralKey("status");
        return outsideScript(async () => {
          const recorded = await execution.journal(callKey, "step", { operation: "background.status", agent: agent.id });
          if (recorded.status === "completed") return recorded.result as "idle" | "busy" | "stopped";
          if (execution.reconstructing) throw new ReconstructionComplete();
          const value = (await listBackgroundAgents(execution.engine, agent.runId)).find(item => item.conversationId === String(agent.conversationId))!.status;
          await this.complete(callKey, value); return value;
        });
      },
      stop: () => {
        const callKey = structuralKey("stop");
        return outsideScript(async () => {
          const recorded = await execution.journal(callKey, "step", { operation: "background.stop", agent: agent.id });
          if (recorded.status === "completed") { await execution.refreshUsage(); return; }
          if (execution.reconstructing) throw new ReconstructionComplete();
          await stopBackgroundAgent(execution.engine, agent.id);
          await this.complete(callKey, null);
          await execution.refreshUsage();
        });
      },
    };
  }

  async create(key: string, input: AgentOptions & { name: string; initialPrompt?: string; detach?: boolean; schema?: TSchema }, extraExtensions: Extension[] = []): Promise<AgentRecord> {
    const { execution } = this;
    const { engine, runId, runtime } = execution;
    if (!input.name.trim()) throw new WorkflowError("invalid_agent_name", "spawn requires a nonempty name.", key);
    const { name, initialPrompt, detach, schema, ...call } = input;
    const options = execution.resolveOptions(call);
    const record = await execution.journal(key, "spawn", { name, initialPrompt: initialPrompt ?? null, detach: !!detach, options, schema: schema ?? null }, options);
    const id = `${runId}:${key}:generation:${record.generation}`;
    const existing = (await engine.harness.snapshot(BackgroundStore, execution.context))?.agents[id];
    if (existing) return copy(agentRecord(existing));
    if (execution.reconstructing) throw new ReconstructionComplete();
    await execution.checkBudget(key);
    const run = await engine.get(runId);
    const selected = options.model ?? run.model ?? engine.options.defaultModel;
    if (!selected) throw new WorkflowError("no_model", "Choose a model with --model or workflow.defaults.model.", key);
    const model = engine.resolveModel(selected);
    const extra = execution.workflowDefinition.tools?.length ? defineExtension({ name: `workflow.tools.${run.workflow.hash}`, tools: execution.workflowDefinition.tools }) : undefined;
    if (extra) engine.registry.install(extra);
    for (const extension of extraExtensions) engine.registry.install(extension);
    const structured = schema ? structuredTool(engine.registry, runId, key, schema) : undefined;
    const budgetExtension = engine.registry.snapshot().extension("workflow.budgets");
    const extensions = [CodingTools, ...(budgetExtension ? [budgetExtension] : []), ...(extra ? [extra] : []), ...extraExtensions, ...(structured ? [structured.extension] : [])];
    const tools = execution.tools(options);
    for (const extension of extraExtensions) tools.push(...extension.tools ?? []);
    if (structured) tools.push(structured.tool);
    let worktree: { path: string; branch: string } | undefined;
    if (options.isolation === "worktree") {
      const suffix = worktreeSuffix(options.label ?? name);
      const intent = { path: join(resolve(engine.options.home), "worktrees", runId, suffix), branch: `orch/${runId}/${suffix}` };
      await engine.mutate(runId, current => {
        if (current.steps.some(step => step.key !== key && step.worktree?.path === intent.path))
          throw new WorkflowError("worktree_conflict", `Another step already uses worktree label '${options.label ?? name}'. Give each isolated agent a distinct label.`, key);
        const step = current.steps.find(step => step.key === key)!;
        step.worktree = intent; step.worktreeCwd = resolve(run.cwd, options.cwd ?? ".");
        if (!current.worktrees?.some(item => item.path === intent.path)) (current.worktrees ??= []).push(intent);
      });
      worktree = await ensureWorktree({ home: engine.options.home, runId, key, label: options.label ?? name, cwd: resolve(run.cwd, options.cwd ?? ".") });
    }
    const cwd = worktree?.path ?? resolve(run.cwd, options.cwd ?? ".");
    await runtime.commit(async tx => {
      const store = await tx.doc(BackgroundStore);
      if (store.agents[id]) return undefined;
      if (Object.values(store.agents).map(agentRecord).some(agent => agent.runId === runId && agent.name === name && !agent.stopped))
        throw new WorkflowError("duplicate_agent_name", `Background agent '${name}' already exists in this run. Use distinct names.`, key);
      await engine.reserveAgent(tx, runId);
      const anchorTask = await tx.createTask(definitions(engine).anchor, { agentId: id }, detach
        ? { ownership: { kind: "conversation" }, background: true }
        : { ownership: { kind: "task", taskId: runtime.taskId } });
      const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchorTask } });
      await configure(tx, child.id, {
        model, thinkingLevel: options.thinkingLevel ?? run.thinkingLevel, cwd, extensions, tools, modelTools: tools,
        instructions: `You are persistent background agent '${name}' inside workflow ${run.workflow.name}, run ${runId}, step ${key}. You retain conversation context between messages. Use only your configured durable tools; the parent Pi session's extensions, MCP servers and skills are not inherited. Never launch workflows: composition belongs in ctx.workflow().\n${options.instructions ?? ""}${structured ? "\nFinish each task by calling submit_result with the complete schema-valid result." : ""}`,
      });
      const meta = await tx.doc(AgentMeta, child.id);
      meta.runId = runId; meta.stepKey = key; meta.options = json(options) as JsonObject;
      const agent: AgentRecord = {
        id, runId, key, name, conversationId: child.id, anchorTask, detached: !!detach, stopped: false,
        options, extensions: extensions.map(extension => extension.name), tools: tools.map(tool => tool.name),
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, ...(schema ? { schema } : {}),
      };
      store.agents[id] = json(agent) as JsonObject;
      const current = storedRun((await tx.doc(RunStore)).runs[runId]);
      const step = current.steps.find(item => item.key === key)!;
      step.status = "completed"; step.conversationId = String(child.id); step.taskId = anchorTask;
      step.startedAt ??= runtime.now(); step.attempts = 1;
      step.result = { name, conversationId: String(child.id) };
      if (schema) step.schema = json(schema) as JsonObject;
      if (worktree) step.worktree = worktree;
      if (step.phase) {
        let phase = current.phases.find(item => item.title === step.phase);
        if (!phase) { phase = { title: step.phase, agents: 0, done: 0, tokens: 0, elapsedMs: 0 }; current.phases.push(phase); }
        phase.agents++;
      }
      if (initialPrompt !== undefined) {
        const messageId = `${id}/initial`;
        agentRecord(store.agents[id]).initialMessage = messageId;
        await enqueueInTx(engine, tx, id, messageId, initialPrompt, "followUp");
      }
      return undefined;
    }, execution.context);
    return readAgent(engine, id, execution.context);
  }

  private async complete(key: string, value: unknown): Promise<void> {
    await this.execution.engine.mutate(this.execution.runId, async (run, tx) => {
      this.execution.runtime.signal.throwIfAborted();
      const step = run.steps.find(item => item.key === key)!;
      step.status = "completed"; await this.execution.engine.saveResult(tx, step, value); step.endedAt = this.execution.runtime.now();
    });
  }
}

/** Persistent anchors own conversations; durable message tasks own delivery, retries and accounting. */
export function backgroundTasks(getEngine: () => Engine): [AnchorTask, MessageTask] {
  const anchor = defineTask<AnchorInput, AnchorState, null>({
    name: "workflow.background.anchor", version: 1, initial: () => ({ phase: "hold", tick: 0 }),
    phases: { hold: async (task, runtime, ctx) => {
      await runtime.sleepUntil(runtime.now() + 86_400_000, { phase: "hold", tick: task.state.checkpoint.tick + 1 }, ctx);
    } },
    abort: async (task, runtime, ctx) => {
      await accountBackgroundUsage(getEngine(), task.input.agentId, ctx);
      const ending = await readAgent(getEngine(), task.input.agentId, ctx);
      getEngine().semaphore.releaseReservation(String(ending.conversationId));
      await runtime.commit(async tx => {
        const agent = agentRecord((await tx.doc(BackgroundStore)).agents[task.input.agentId]);
        if (agent) {
          agent.stopped = true; delete agent.activeMessage;
          const run = storedRun((await tx.doc(RunStore)).runs[agent.runId]);
          const step = run.steps.find(item => item.key === agent.key);
          if (step && !step.endedAt) {
            step.endedAt = runtime.now();
            const phase = run.phases.find(item => item.title === step.phase);
            if (phase) phase.done++;
          }
        }
        return { status: "terminal", outcome: { status: "aborted" } };
      }, ctx);
    },
  });
  const message = defineTask<MessageInput, MessageState, JsonValue>({
    name: "workflow.background.message", version: 1, initial: () => ({ phase: "deliver" }),
    phases: {
      backoff: async (task, runtime, ctx) => runtime.sleepUntil(task.state.checkpoint.until, { phase: "deliver" }, ctx),
      deliver: async (task, runtime, ctx) => {
        const engine = getEngine();
        let release: (() => void) | undefined, disarm: (() => void) | undefined;
        const data = (await runtime.snapshot(BackgroundStore, ctx))!;
        const item = copy(messageRecord(data.messages[task.input.messageId]));
        const agent = copy(agentRecord(data.agents[item.agentId]));
        const structured = agent.schema ? structuredTool(engine.registry, agent.runId, agent.key, agent.schema) : undefined;
        try {
          const joinsActive = item.whenBusy === "steer" && agent.activeMessage !== undefined && agent.activeMessage !== item.id;
          if (!joinsActive && item.previousTask) await runtime.waitForTask(item.previousTask, ctx);
          if (!joinsActive) release = await engine.semaphore.acquire(runtime.signal, String(agent.conversationId));
          await engine.assertUsageWithinBudget(agent.runId, agent.key);
          const run = await engine.get(agent.runId);
          if (run.limits.maxCostUsd !== undefined && (run.usage.costUsd ?? 0) > run.limits.maxCostUsd ||
              run.limits.maxTokens !== undefined && run.usage.inputTokens + run.usage.outputTokens > run.limits.maxTokens ||
              run.limits.maxDurationMs !== undefined && runtime.now() - (run.startedAt ?? run.createdAt) >= run.limits.maxDurationMs)
            throw new WorkflowError("budget_exceeded", "Run budget exceeded before a background message.", agent.key);
          await runtime.commit(async tx => {
            const store = await tx.doc(BackgroundStore);
            const current = messageRecord(store.messages[item.id]);
            const currentAgent = agentRecord(store.agents[agent.id]);
            if (currentAgent.stopped) throw new WorkflowError("agent_stopped", `Background agent '${agent.name}' is stopped.`);
            current.status = "running";
            current.deadline ??= runtime.now() + (agent.options.timeoutMs ?? 600_000);
            item.deadline = current.deadline;
            if (!joinsActive) currentAgent.activeMessage = item.id;
            if (!current.prepared) {
              current.prepared = true;
              if (structured) {
                const output = await tx.doc(StructuredResult, agent.conversationId);
                output.submitted = false; output.value = null;
                const tools = engine.registry.snapshot().tools().filter(entry => agent.extensions.includes(entry.extension.name) && agent.tools.includes(entry.tool.name)).map(entry => entry.tool);
                await configure(tx, agent.conversationId, { modelTools: tools });
              }
            }
            return undefined;
          }, ctx);
          const timeout = new AbortController();
          const timeoutError = new WorkflowError("agent_timeout", `Background agent '${agent.name}' exceeded its message timeout.`, agent.key);
          disarm = runtime.setTimer(() => timeout.abort(timeoutError), Math.max(0, item.deadline! - runtime.now()));
          const waitContext = withAbortSignal(AbortSignal.any([runtime.signal, timeout.signal]), ctx);
          const child = await runtime.conversation(agent.conversationId, waitContext);
          if (!child) throw new WorkflowError("missing_conversation", `Missing background conversation ${agent.conversationId}.`);
          let result: JsonValue = null;
          for (let round = item.outputRound; ; round++) {
            const submission = await child.submit({ type: "input", content: round ? "Call submit_result with the complete schema-valid result now." : item.prompt,
              whenBusy: item.whenBusy, requestId: `${item.id}:attempt:${item.attempt}:output:${round}`,
            }, waitContext);
            const settled = await submission.wait(waitContext);
            if (settled.status !== "done") {
              const meta = await runtime.snapshot(AgentMeta, agent.conversationId, waitContext);
              throw new WorkflowError(meta?.budgetError ? "budget_exceeded" : "agent_failed", meta?.budgetError ?? `Background message was unanswered: ${settled.reason}.`, agent.key);
            }
            if (!structured) {
              result = await engine.root.commit(async tx => answer(settled.answer === undefined ? undefined : await tx.entry(settled.answer)), waitContext);
              break;
            }
            const output = await runtime.snapshot(StructuredResult, agent.conversationId, waitContext);
            if (output?.submitted) { result = copy(output.value); break; }
            if (round >= engine.settings.structuredRetries) throw new WorkflowError("invalid_structured_output", "Background agent did not submit a valid structured result.", agent.key);
            await runtime.commit(async tx => {
              messageRecord((await tx.doc(BackgroundStore)).messages[item.id]).outputRound = round + 1;
              await configure(tx, agent.conversationId, { modelTools: [structured.tool] });
              return undefined;
            }, ctx);
          }
          await accountBackgroundUsage(engine, agent.id, ctx);
          await engine.assertUsageWithinBudget(agent.runId, agent.key);
          const finalAgent = await readAgent(engine, agent.id, ctx);
          if (agent.options.budget?.maxCostUsd !== undefined && (finalAgent.usage.costUsd ?? 0) > agent.options.budget.maxCostUsd)
            throw new WorkflowError("budget_exceeded", "Background agent exceeded its budget.", agent.key);
          await runtime.commit(async tx => {
            const store = await tx.doc(BackgroundStore);
            const currentAgent = agentRecord(store.agents[agent.id]);
            if (currentAgent.activeMessage === item.id) delete currentAgent.activeMessage;
            const current = messageRecord(store.messages[item.id]);
            current.status = "completed"; await engine.saveResult(tx, current, result);
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }, ctx);
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          const failure = error instanceof WorkflowError ? error : new WorkflowError("agent_failed", error instanceof Error ? error.message : String(error));
          await (await engine.harness.conversation(agent.conversationId, BACKGROUND_CONTEXT))?.abort(BACKGROUND_CONTEXT);
          await accountBackgroundUsage(engine, agent.id, ctx);
          await runtime.commit(async tx => {
            const store = await tx.doc(BackgroundStore);
            const current = messageRecord(store.messages[item.id]);
            current.error = { code: failure.code, message: failure.message };
            const currentAgent = agentRecord(store.agents[agent.id]);
            if (currentAgent.activeMessage === item.id) delete currentAgent.activeMessage;
            if (current.attempt <= (agent.options.retries ?? 0) && !["budget_exceeded", "agent_stopped", "invalid_structured_output"].includes(failure.code)) {
              current.attempt++; current.prepared = false; current.outputRound = 0; delete current.deadline;
              return { status: "running", checkpoint: { phase: "backoff", until: runtime.now() + engine.settings.retryBackoffMs * 2 ** (current.attempt - 2) } };
            }
            current.status = "failed";
            return { status: "terminal", outcome: { status: "failed", error: { message: failure.message } } };
          }, ctx);
        } finally { disarm?.(); release?.(); }
      },
    },
    abort: async (task, runtime, ctx) => {
      const item = (await runtime.snapshot(BackgroundStore, ctx))?.messages[task.input.messageId];
      if (item) await accountBackgroundUsage(getEngine(), messageRecord(item).agentId, ctx);
      await runtime.commit(async tx => {
        const stored = (await tx.doc(BackgroundStore)).messages[task.input.messageId];
        if (stored) { const current = messageRecord(stored); current.status = "cancelled"; current.error = { code: "cancelled", message: "Background message cancelled." }; }
        return { status: "terminal", outcome: { status: "aborted" } };
      }, ctx);
    },
  });
  return [anchor, message];
}
