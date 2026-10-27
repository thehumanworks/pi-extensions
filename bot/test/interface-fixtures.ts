import assert from "node:assert/strict";
import type { BotEvent, BotHandle, BotInfo, BotRunRecord, BotSessionInfo, RunOptions } from "../src/types.js";

export const INFO: BotInfo = {
  name: "fixture", description: "offline fixture", sourceDir: "/source", stateDir: "/state", format: 2,
  inherit: "none", revision: "revision-1", tools: [{ name: "echo", source: "/source/tools/echo.ts" }], skills: [], diagnostics: [],
};
export function fixture() {
  const runs = new Map<string, BotRunRecord>();
  const listeners = new Map<string, Set<(event: BotEvent) => void>>();
  const submitted: Array<{ message: string; options?: RunOptions }> = [];
  const cancelled: string[] = [];
  let closed = 0; let unsubscribed = 0;
  const missing = () => Object.assign(new Error("Resource not found"), { code: "NOT_FOUND" });
  const emit = (sessionId: string, event: BotEvent) => { for (const listener of listeners.get(sessionId) ?? []) listener(event); };
  const complete = (id: string, status: BotRunRecord["status"] = "completed") => {
    const run = runs.get(id); if (!run) throw missing();
    run.status = status; run.output = status === "completed" ? "done" : ""; run.updatedAt = new Date().toISOString();
    emit(run.sessionId, { type: "run", sessionId: run.sessionId, runId: run.runId, data: { ...run } });
  };
  const bot: BotHandle = {
    sourceDir: INFO.sourceDir, stateDir: INFO.stateDir,
    async info() { return INFO; },
    async submit(message, options) {
      submitted.push({ message, options });
      if (options?.requestId) {
        const index = submitted.findIndex(item => item.options?.requestId === options.requestId);
        if (index < submitted.length - 1) return { ...[...runs.values()][index] };
      }
      const id = `run-${runs.size + 1}`;
      const sessionId = options?.session && !["new", "last"].includes(options.session) ? options.session : `session-${runs.size + 1}`;
      const date = new Date().toISOString();
      const run: BotRunRecord = {
        runId: id, sessionId, bot: INFO.name, cwd: "/configured-workspace", status: "queued", output: "",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }, toolCalls: 0,
        createdAt: date, updatedAt: date,
      };
      runs.set(id, run); return { ...run };
    },
    async run(message, options) { const accepted = await bot.submit(message, options); complete(accepted.runId); return bot.getRun(accepted.runId); },
    async getRun(id) { const run = runs.get(id); if (!run) throw missing(); return { ...run }; },
    async listSessions() {
      return [...new Map([...runs.values()].map(run => [run.sessionId, {
        sessionId: run.sessionId, cwd: run.cwd, createdAt: run.createdAt, updatedAt: run.updatedAt,
      } satisfies BotSessionInfo])).values()];
    },
    async watch(session, listener) {
      const set = listeners.get(session) ?? new Set(); listeners.set(session, set); set.add(listener);
      listener({ type: "snapshot", sessionId: session, data: { runs: [...runs.values()].filter(run => run.sessionId === session).map(run => ({ ...run })) } });
      let stopped = false;
      return async () => { if (stopped) return; stopped = true; set.delete(listener); unsubscribed++; };
    },
    async cancel(id) { if (!runs.has(id)) throw missing(); cancelled.push(id); complete(id, "cancelled"); },
    async callTool(name, input, options) {
      if (name !== "echo") throw missing();
      return { content: [{ type: "text", text: JSON.stringify({ input, session: options?.session }) }] };
    },
    async reload() { return { changed: false, revision: INFO.revision, diagnostics: [] }; },
    async close() { closed++; },
  };
  return { bot, runs, submitted, cancelled, listeners, emit, complete, get closed() { return closed; }, get unsubscribed() { return unsubscribed; } };
}
export async function eventually(predicate: () => boolean, message = "condition did not settle"): Promise<void> {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.ok(predicate(), message);
}
