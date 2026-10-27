import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import { defineTask, type Task, type TaskRuntime } from "@earendil-works/pi-durable";
import { WorkflowError } from "../errors.ts";
import type { StepContext } from "../index.ts";
import type { Engine } from "./index.ts";
import { json, RunStore, storedRun } from "./store.ts";
import { outsideScript } from "./scopes.ts";

type EffectInput = { runId: string; key: string; retries: number };
type EffectState = { phase: "execute"; attempt: number } | { phase: "backoff"; attempt: number; until: number };
export type EffectTask = Task<EffectInput, EffectState, JsonValue, object>;
export type EffectCallback = (context: StepContext) => Promise<unknown>;

export function effectTask(getEngine: () => Engine): EffectTask {
  return defineTask<EffectInput, EffectState, JsonValue>({
    name: "workflow.step", version: 1, initial: () => ({ phase: "execute", attempt: 1 }),
    phases: {
      backoff: async (task, runtime, ctx) => {
        await runtime.sleepUntil(task.state.checkpoint.until, { phase: "execute", attempt: task.state.checkpoint.attempt }, ctx);
      },
      execute: async (task, runtime, ctx) => {
        const { runId, key, retries } = task.input;
        const attempt = task.state.checkpoint.attempt;
        try {
          const callback = await getEngine().effect(runId, key, runtime.signal);
          // An external effect may have happened before its completion commit. Never replay it silently.
          if (await runtime.memo(`effect:${attempt}`, ctx))
            throw new WorkflowError("interrupted_step", `Step ${key} was interrupted before its completion commit. Inspect external effects, then retry --from '${key}' if safe.`, key);
          await runtime.memo(`effect:${attempt}`, true, ctx);
          let cwd = "";
          await runtime.commit(async tx => {
            const run = storedRun((await tx.doc(RunStore)).runs[runId]);
            const step = run.steps.find(item => item.key === key)!;
            step.attempts = attempt; step.startedAt ??= runtime.now(); step.status = "running";
            cwd = run.cwd;
            return undefined;
          }, ctx);
          const result = json(await outsideScript(() => callback({ signal: runtime.signal, cwd,
            log: message => { void getEngine().mutate(runId, run => { run.logs.push({ time: runtime.now(), message }); }).catch(() => {}); },
          })));
          await runtime.commit(async tx => {
            const step = storedRun((await tx.doc(RunStore)).runs[runId]).steps.find(item => item.key === key)!;
            await getEngine().saveResult(tx, step, result);
            step.status = "completed"; step.endedAt = runtime.now();
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }, ctx);
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          const message = error instanceof Error ? error.message : String(error);
          await runtime.commit(async tx => {
            const step = storedRun((await tx.doc(RunStore)).runs[runId]).steps.find(item => item.key === key)!;
            step.error = { message, reason: error instanceof WorkflowError ? error.code : "step_failed" };
            if (attempt <= retries && !(error instanceof WorkflowError && error.code === "interrupted_step"))
              return { status: "running", checkpoint: { phase: "backoff", attempt: attempt + 1,
                until: runtime.now() + getEngine().settings.retryBackoffMs * 2 ** (attempt - 1) } };
            step.status = "failed"; step.endedAt = runtime.now();
            return { status: "terminal", outcome: { status: "failed", error: { message } } };
          }, ctx);
        }
      },
    },
    abort: async (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
  });
}
