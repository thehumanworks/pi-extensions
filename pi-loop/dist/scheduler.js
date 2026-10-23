import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { stat } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { configure, createRegistry, defineDoc, defineExtension, defineTask, Harness, section, } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { PROTOCOL_VERSION, intervalMs, nextDue } from "./protocol.js";
const context = BACKGROUND_CONTEXT;
export const Schedules = defineDoc({
    kind: "loop.schedules", version: 1, scope: "session", initial: () => ({ schedules: {} }),
});
function answerText(entry) {
    return entry?.model?.flatMap(message => message.role === "assistant" ?
        message.content.filter(block => block.type === "text").map(block => block.text) : []).join("\n") ?? "";
}
export const LoopTask = defineTask({
    name: "loop.tick", version: 1,
    initial: input => ({ phase: "sleep", due: input.due }),
    phases: {
        sleep: async (task, runtime, ctx) => {
            const due = task.state.checkpoint.due;
            await runtime.sleep(due, ctx);
            await runtime.commit(async (tx) => {
                const schedule = (await tx.doc(Schedules)).schedules[task.input.id];
                if (!schedule || schedule.status !== "active" || schedule.taskId !== task.id)
                    return { status: "terminal", outcome: { status: "completed", result: null } };
                // Creation and checkpoint are one commit: a crash cannot create a second run.
                const child = await tx.createConversation({ ownership: { kind: "task", taskId: task.id } });
                await configure(tx, child.id, {
                    model: schedule.model, thinkingLevel: schedule.thinkingLevel, cwd: schedule.cwd,
                });
                return { status: "running", checkpoint: { phase: "run", due, conversationId: child.id } };
            }, ctx);
        },
        run: async (task, runtime, ctx) => {
            const checkpoint = task.state.checkpoint;
            const schedule = (await runtime.snapshot(Schedules, ctx))?.schedules[task.input.id];
            if (!schedule)
                throw new Error("Missing schedule.");
            const child = await runtime.conversation(checkpoint.conversationId, ctx);
            if (!child)
                throw new Error("Missing run conversation.");
            const submission = await child.submit({
                type: "input", content: schedule.prompt, requestId: `loop:${schedule.id}:${checkpoint.due}`,
            }, ctx);
            const settled = await submission.wait(ctx);
            await runtime.commit(async (tx) => {
                const current = (await tx.doc(Schedules)).schedules[task.input.id];
                const output = settled.status === "done" ? answerText(settled.answer === undefined ? undefined : await tx.entry(settled.answer)) :
                    `Unanswered: ${settled.reason}${settled.detail ? " " + JSON.stringify(settled.detail) : ""}`;
                const now = runtime.now();
                current.runs.push({ due: checkpoint.due, finishedAt: now, conversationId: checkpoint.conversationId,
                    status: settled.status, output: output.slice(0, 16_000) });
                current.runs = current.runs.slice(-20);
                current.nextRunAt = nextDue(checkpoint.due, current.interval, now);
                if (current.status !== "active")
                    return { status: "terminal", outcome: { status: "completed", result: null } };
                return { status: "running", checkpoint: { phase: "sleep", due: current.nextRunAt } };
            }, ctx);
        },
    },
    abort: async (_task, runtime, ctx) => {
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
    },
});
export async function openScheduler(storage, models) {
    const registry = createRegistry();
    registry.install(CodingTools);
    registry.install(defineExtension({
        name: "loop.runner", tasks: [LoopTask],
        sections: [section("role", () => "You are Pi, a coding assistant running a scheduled task on the host. Execute the user's task using the available tools and return its result.", { tag: false })],
    }));
    const harness = await Harness.open(storage, {
        models, registry,
        env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }),
        onReport: error => console.error("[loop]", error),
    }, context);
    const root = await harness.root(context);
    harness.resume();
    async function get(id) {
        const schedule = (await harness.snapshot(Schedules, context))?.schedules[id];
        if (!schedule || schedule.status === "deleted")
            throw new Error(`Unknown schedule: ${id}`);
        return structuredClone(schedule);
    }
    async function handle(request) {
        if (request.action === "ping")
            return { version: PROTOCOL_VERSION, pid: process.pid };
        if (request.action === "stop")
            return { stopped: true };
        if (request.action === "list") {
            const schedules = Object.values((await harness.snapshot(Schedules, context))?.schedules ?? {});
            return Promise.all(schedules.filter(s => s.status !== "deleted").map(s => describe(s)));
        }
        if (request.action === "create") {
            if (!isAbsolute(request.cwd) || !(await stat(request.cwd)).isDirectory())
                throw new Error("cwd must be an existing absolute directory.");
            if (!models.getModel(request.model.provider, request.model.modelId))
                throw new Error(`Worker cannot resolve model ${request.model.provider}/${request.model.modelId}. Use a built-in model or configure models.json; session-only provider extensions are not inherited.`);
            return root.commit(async (tx) => {
                const state = await tx.doc(Schedules);
                // Retries, including an interrupted HTTP/socket reply, reuse the original schedule.
                const existing = Object.values(state.schedules).find(s => s.requestId === request.requestId);
                if (existing)
                    return JSON.parse(JSON.stringify(existing));
                const now = Date.now();
                const interval = intervalMs(request.frequency);
                const id = randomUUID();
                const due = now + interval;
                const taskId = await tx.createTask(LoopTask, { id, due }, {
                    ownership: { kind: "conversation" }, background: true,
                });
                const schedule = { id, requestId: request.requestId, frequency: request.frequency,
                    interval, prompt: request.prompt, cwd: request.cwd, model: request.model,
                    thinkingLevel: request.thinkingLevel, createdAt: now, nextRunAt: due, status: "active", taskId, runs: [] };
                state.schedules[id] = schedule;
                return structuredClone(schedule);
            }, context);
        }
        const schedule = await get(request.id);
        if (request.action === "show")
            return describe(schedule);
        if (request.action === "pause" || request.action === "delete") {
            await root.commit(async (tx) => {
                (await tx.doc(Schedules)).schedules[request.id].status = request.action === "delete" ? "deleted" : "paused";
            }, context);
            if (schedule.taskId) {
                await harness.abortTask(schedule.taskId, context);
                await harness.waitForTask(schedule.taskId, context);
            }
            return request.action === "delete" ? { id: request.id, deleted: true } : get(request.id);
        }
        const task = schedule.taskId ? await harness.getTask(schedule.taskId, context) : undefined;
        if (schedule.status === "active" && task && task.state.status !== "terminal")
            return describe(schedule);
        return root.commit(async (tx) => {
            const current = (await tx.doc(Schedules)).schedules[request.id];
            const due = Date.now() + current.interval;
            current.taskId = await tx.createTask(LoopTask, { id: current.id, due }, {
                ownership: { kind: "conversation" }, background: true,
            });
            current.nextRunAt = due;
            current.status = "active";
            return JSON.parse(JSON.stringify(current));
        }, context);
    }
    async function describe(schedule) {
        const task = schedule.taskId ? await harness.getTask(schedule.taskId, context) : undefined;
        return { ...structuredClone(schedule), taskState: task?.state ?? null };
    }
    // Management writes from multiple Pi sessions are serialized, including abort-and-resume.
    let pending = Promise.resolve();
    return {
        harness,
        request(request) {
            if (["ping", "list", "show"].includes(request.action))
                return handle(request);
            const result = pending.then(() => handle(request));
            pending = result.catch(() => { });
            return result;
        },
        close: () => harness.close(context),
    };
}
