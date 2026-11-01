import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import { defineDoc, defineExtension, defineTool, type JsonObject } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { SwarmOptions } from "../index.ts";
import { WorkflowError } from "../errors.ts";
import type { Engine } from "./index.ts";
import { ReconstructionComplete, type Execution } from "./execution.ts";
import { BackgroundRuntime, enqueueBackground, stopBackgroundAgent, waitBackgroundMessage } from "./background.ts";
import { copy, json } from "./store.ts";
import { scopedSignal, scriptScope } from "./scopes.ts";

interface QueueItem {
  id: string;
  value: JsonValue;
  status: "queued" | "claimed" | "completed";
  worker?: number;
  prompt?: string;
  result?: JsonValue;
}
interface Queue {
  runId: string;
  key: string;
  allowPush: boolean;
  stopped: boolean;
  items: QueueItem[];
  blackboard: string;
  receipts: Record<string, boolean>;
}

export const SwarmStore = defineDoc<{ queues: Record<string, JsonObject> }>({
  kind: "workflow.swarms", version: 1, scope: "session", initial: () => ({ queues: {} }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 100,
});
const Membership = defineDoc<{ queueId: string; worker: number }>({
  kind: "workflow.swarm-worker", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ queueId: "", worker: -1 }), checkpointWhen: () => false,
});
const queueRecord = (value: JsonObject): Queue => value as unknown as Queue;

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function itemId(value: JsonValue): string { return createHash("sha256").update(canonical(value)).digest("hex").slice(0, 24); }

function push(queue: Queue, items: readonly JsonValue[]): number {
  let added = 0;
  const seen = new Set(queue.items.map(item => item.id));
  for (const value of items) {
    const id = itemId(value);
    if (seen.has(id)) continue;
    seen.add(id); queue.items.push({ id, value, status: "queued" }); added++;
  }
  return added;
}

function append(queue: Queue, text: string): void {
  if (text.trim()) queue.blackboard += (queue.blackboard ? "\n" : "") + text;
}

export const SwarmTools = defineExtension({
  name: "workflow.swarm-tools",
  tools: [
    defineTool({
      name: "blackboard", description: "Read shared swarm notes or append a convention that other workers should follow.",
      parameters: Type.Object({ action: Type.Union([Type.Literal("read"), Type.Literal("append")]), text: Type.Optional(Type.String()) }),
      replay: "safe",
      execute: async (args, api, ctx) => {
        const text = await api.commit(async tx => {
          const membership = await tx.doc(Membership, api.conversationId);
          const queue = queueRecord((await tx.doc(SwarmStore)).queues[membership.queueId]);
          if (!queue) throw new WorkflowError("not_in_swarm", "The blackboard tool is available only to an assigned swarm worker.");
          if (args.action === "append") {
            if (!args.text?.trim()) throw new WorkflowError("invalid_request", "blackboard append requires nonempty text.");
            const receipt = `blackboard:${api.taskId}`;
            if (!queue.receipts[receipt]) { append(queue, args.text); queue.receipts[receipt] = true; }
          }
          return queue.blackboard;
        }, ctx);
        return { output: [{ type: "text", text }] };
      },
    }),
    defineTool({
      name: "queue_push", description: "Add newly discovered items to this swarm's durable queue. Duplicate JSON values are ignored.",
      parameters: Type.Object({ items: Type.Array(Type.Unknown()) }), replay: "safe",
      execute: async (args, api, ctx) => {
        const added = await api.commit(async tx => {
          const membership = await tx.doc(Membership, api.conversationId);
          const queue = queueRecord((await tx.doc(SwarmStore)).queues[membership.queueId]);
          if (!queue?.allowPush) throw new WorkflowError("queue_push_forbidden", "This swarm did not enable queue.allowPush.");
          if (queue.stopped) return 0;
          return push(queue, args.items.map(json));
        }, ctx);
        return { output: [{ type: "text", text: JSON.stringify({ added }) }] };
      },
    }),
  ],
});

async function readQueue(engine: Engine, id: string, ctx: Context): Promise<Queue> {
  const stored = (await engine.harness.snapshot(SwarmStore, ctx))?.queues[id];
  if (!stored) throw new WorkflowError("swarm_not_found", `Missing durable queue ${id}.`);
  return copy(queueRecord(stored));
}

async function waitForWork(engine: Engine, id: string, ctx: Context): Promise<void> {
  const watch = await engine.harness.watchDoc(SwarmStore, ctx);
  if (!watch) throw new WorkflowError("swarm_not_found", `Missing durable queue ${id}.`);
  try {
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const inspect = (value: typeof watch.value) => {
        const queue = value?.queues[id] ? queueRecord(value.queues[id]) : undefined;
        if (!queue || queue.stopped || queue.items.some(item => item.status === "queued") || !queue.items.some(item => item.status === "claimed")) {
          finished = true; resolve();
        }
      };
      watch.start(async value => { inspect(value); });
      inspect(watch.value);
      void watch.closed.then(result => {
        if (!finished) reject(new WorkflowError("swarm_interrupted", `Swarm queue watch ended: ${result.reason}.`));
      });
    });
  } finally { await watch.stop(); }
}

/** Persistent worker conversations claim durable items and commit each completed result once. */
export async function runSwarm<Item, Out>(execution: Execution, key: string, options: SwarmOptions<Item, Out>): Promise<{ results: Out[]; blackboard: string; processed: number }> {
  if (!Number.isInteger(options.workers) || options.workers < 1 || options.workers > 1000)
    throw new WorkflowError("invalid_workers", "swarm.workers must be an integer from 1 to 1000.", key);
  const input = Array.isArray(options.queue) ? options.queue : (options.queue as { initial: readonly Item[] }).initial;
  const allowPush = !Array.isArray(options.queue) && !!(options.queue as { allowPush?: boolean }).allowPush;
  const { prompt, schema, ...workerOptions } = options.worker;
  const record = await execution.journal(key, "swarm", {
    workers: options.workers, queue: input, allowPush, worker: workerOptions, schema: schema ?? null, until: !!options.until,
  }, options);
  if (record.status === "completed") {
    execution.replayChildren(key);
    return await execution.engine.readResult(record) as { results: Out[]; blackboard: string; processed: number };
  }
  if (execution.reconstructing) throw new ReconstructionComplete();
  const { engine, runId, runtime } = execution;
  const queueId = `${runId}:${key}:generation:${record.generation}`;
  await runtime.commit(async tx => {
    const store = await tx.doc(SwarmStore);
    if (!store.queues[queueId]) {
      const queue: Queue = { runId, key, allowPush, stopped: false, items: [], blackboard: "", receipts: {} };
      push(queue, input.map(json)); store.queues[queueId] = json(queue) as JsonObject;
    }
    return undefined;
  }, execution.context);
  const backgrounds = new BackgroundRuntime(execution);
  const controller = new AbortController();
  const signal = AbortSignal.any([scopedSignal(runtime.signal), controller.signal]);
  const ctx = withAbortSignal(signal, execution.context);
  const agentIds: string[] = [];
  const suffix = createHash("sha256").update(key).digest("hex").slice(0, 6);
  const stopCondition = (queue: Queue) => {
    if (queue.stopped || !options.until) return;
    const complete = queue.items.filter(item => item.status === "completed");
    const stop = scriptScope(`${key}/until#${complete.length}`, () => options.until!({
      processed: complete.length, remaining: queue.items.length - complete.length,
      results: complete.map(item => copy(item.result) as Out), blackboard: queue.blackboard,
    }));
    if (stop) queue.stopped = true;
  };
  try {
    const agents = [];
    for (let index = 0; index < options.workers; index++) {
      const agent = await backgrounds.create(`${key}/worker#${index}`, {
        ...workerOptions, schema, name: `${options.label ?? "swarm"}-${suffix}-${index}`, label: `${options.label ?? "swarm"}-${index}`,
        phase: options.phase,
        instructions: `${workerOptions.instructions ?? ""}\nYou are a swarm worker. Use blackboard to read/append shared conventions.${allowPush ? " Use queue_push to enqueue newly discovered work; returned newDependents are also enqueued." : " This queue is fixed; do not add items."}`,
      }, [SwarmTools]);
      agentIds.push(agent.id); agents.push(agent);
      await runtime.commit(async tx => {
        const membership = await tx.doc(Membership, agent.conversationId);
        membership.queueId = queueId; membership.worker = index;
        return undefined;
      }, execution.context);
    }
    await Promise.all(agents.map(async (agent, index) => {
      for (;;) {
        signal.throwIfAborted();
        const item = await engine.root.commit(async tx => {
          const queue = queueRecord((await tx.doc(SwarmStore)).queues[queueId]);
          const previous = queue.items.find(item => item.status === "claimed" && item.worker === index);
          if (previous) return copy(previous);
          stopCondition(queue);
          if (queue.stopped) return undefined;
          const next = queue.items.find(item => item.status === "queued");
          if (!next) return undefined;
          next.status = "claimed"; next.worker = index;
          const text = scriptScope(`${key}/prompt#${next.id}`, () => prompt(copy(next.value) as Item, queue.blackboard));
          if (typeof text !== "string") throw new WorkflowError("invalid_prompt", "swarm.worker.prompt must return text.", key);
          next.prompt = text;
          return copy(next);
        }, ctx);
        if (!item) {
          const queue = await readQueue(engine, queueId, ctx);
          if (queue.stopped || !queue.items.some(item => item.status !== "completed")) return;
          await waitForWork(engine, queueId, ctx);
          continue;
        }
        const itemKey = `${key}/item#${item.id}`;
        await execution.journal(itemKey, "step", { operation: "swarm.item", value: item.value }, { phase: options.phase });
        const messageId = `${queueId}/item#${item.id}`;
        await enqueueBackground(engine, agent.id, messageId, item.prompt!);
        const result = await waitBackgroundMessage(engine, messageId, ctx);
        await engine.mutate(runId, async (run, tx) => {
          signal.throwIfAborted();
          const queue = queueRecord((await tx.doc(SwarmStore)).queues[queueId]);
          const current = queue.items.find(candidate => candidate.id === item.id)!;
          if (current.status === "completed") return;
          current.status = "completed"; current.result = json(result);
          const object = result && typeof result === "object" && !Array.isArray(result) ? result : undefined;
          if (typeof object?.notesForOthers === "string") append(queue, object.notesForOthers);
          if (queue.allowPush && Array.isArray(object?.newDependents)) push(queue, object.newDependents);
          stopCondition(queue);
          const step = run.steps.find(step => step.key === itemKey)!;
          step.status = "completed"; step.result = json(result); step.conversationId = String(agent.conversationId);
          step.attempts = 1; step.endedAt = runtime.now();
        });
      }
    }));
    const queue = await readQueue(engine, queueId, ctx);
    const results = queue.items.filter(item => item.status === "completed").map(item => copy(item.result) as Out);
    const result = { results, blackboard: queue.blackboard, processed: results.length };
    await engine.mutate(runId, async (run, tx) => {
      runtime.signal.throwIfAborted();
      const step = run.steps.find(step => step.key === key)!;
      step.status = "completed"; await engine.saveResult(tx, step, result); step.endedAt = runtime.now();
    });
    return result;
  } catch (error) { controller.abort(error); throw error; }
  finally {
    if (!runtime.signal.aborted) await Promise.all(agentIds.map(id => stopBackgroundAgent(engine, id, BACKGROUND_CONTEXT)));
  }
}
