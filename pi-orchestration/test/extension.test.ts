import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowClient } from "../src/cli.ts";
import { registerOrchestration } from "../src/extension.ts";
import type { RunRecord, RunStatus } from "../src/index.ts";
import type { ControlRequest } from "../src/protocol.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<void>;
type Entry = { type: "custom"; customType: string; data: unknown } | { type: "custom_message"; customType: string; details: unknown };

function runRecord(id: string, status: RunStatus): RunRecord {
  return {
    id, status, workflow: { name: "flow", path: "/w/flow.ts", hash: "h" }, args: {}, cwd: "/w", createdAt: 1, attempt: 1,
    phases: [], steps: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, agents: 0 }, origin: { kind: "cli" },
    depth: 0, children: [], ...(status === "completed" ? { result: "done", endedAt: 2 } : {}),
  };
}

/** A fake Pi host and worker client that record what the extension does. */
function harness(statuses: Record<string, RunStatus[]>) {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  const messages: Array<{ message: { content: string; details: { kind: string; runId?: string } }; options?: { triggerTurn?: boolean } }> = [];
  const entries: Entry[] = [];
  const requests: ControlRequest[] = [];
  let launches = 0;
  const pi = {
    on: (name: string, handler: Handler) => { handlers.set(name, handler); },
    registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => { tools.set(tool.name, tool); },
    registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => { commands.set(name, command); },
    sendMessage: (message: (typeof messages)[number]["message"], options?: (typeof messages)[number]["options"]) => { messages.push({ message, options }); },
    appendEntry: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); },
    getThinkingLevel: () => "medium",
  } as unknown as ExtensionAPI;
  const client: WorkflowClient = {
    async request(request) {
      requests.push(request);
      if (request.action === "run") return { runId: `run-${++launches}`, status: "queued" };
      if (request.action === "status") {
        const queue = statuses[request.runId] ?? ["completed"];
        return runRecord(request.runId, queue.length > 1 ? queue.shift()! : queue[0]);
      }
      throw new Error(`unexpected ${request.action}`);
    },
    rpc: async () => ({}),
    ensure: async () => ({}),
  };
  const notices: string[] = [];
  const context = (sessionId = "s1", branch: Entry[] = entries) => ({
    cwd: "/w", mode: "rpc", hasUI: true, model: { provider: "faux", id: "faux-1" },
    sessionManager: { getSessionId: () => sessionId, getBranch: () => branch },
    ui: { confirm: async () => true, notify: (text: string) => { notices.push(text); }, setWidget: () => {} },
  }) as unknown as ExtensionContext;
  registerOrchestration(pi, { client, pollIntervalMs: 5, env: {} });
  const completions = () => messages.filter(item => item.message.details.kind === "completion");
  return { handlers, tools, commands, messages, entries, requests, context, completions, notices };
}

test("wait:true returns the outcome without a second completion turn", async () => {
  const h = harness({ "run-1": ["running", "completed"] });
  const ctx = h.context();
  await h.handlers.get("session_start")!({}, ctx);
  const result = await h.tools.get("workflow")!.execute("call-1", { action: "run", workflow: { name: "flow" }, wait: true }, undefined, undefined, ctx) as { details: RunRecord };
  assert.equal(result.details.status, "completed");
  await h.handlers.get("agent_settled")!({}, ctx);
  await delay(30);
  assert.deepEqual(h.completions(), []);
  assert.deepEqual(h.entries.map(entry => entry.type === "custom" ? entry.data : undefined),
    [{ runId: "run-1", home: undefined }, { runId: "run-1", home: undefined, done: true }]);

  // A restored session does not report the finished run again.
  await h.handlers.get("session_start")!({}, h.context("s1"));
  await delay(30);
  assert.deepEqual(h.completions(), []);
  await h.handlers.get("session_shutdown")!({}, ctx);
});

test("background launches report completion once, including after restore", async () => {
  const h = harness({ "run-1": ["running", "completed"] });
  const ctx = h.context();
  await h.handlers.get("session_start")!({}, ctx);
  const launched = await h.tools.get("workflow")!.execute("call-1", { action: "run", workflow: { name: "flow" } }, undefined, undefined, ctx) as { details: { runId: string } };
  assert.equal(launched.details.runId, "run-1");
  const deadline = Date.now() + 2000;
  while (!h.completions().length && Date.now() < deadline) await delay(5);
  await delay(30);
  assert.equal(h.completions().length, 1);
  assert.equal(h.completions()[0].options?.triggerTurn, true);
  assert.match(h.completions()[0].message.content, /run-1 flow completed/);

  // Restore only follows runs without a recorded completion.
  const branch: Entry[] = [
    ...h.entries,
    { type: "custom_message", customType: "workflow", details: { kind: "completion", runId: "run-1" } },
    { type: "custom", customType: "workflow_run", data: { runId: "run-2" } },
  ];
  const statusCalls = () => h.requests.filter(request => request.action === "status").map(request => (request as { runId: string }).runId);
  const before = statusCalls().length;
  await h.handlers.get("session_start")!({}, h.context("s2", branch));
  assert.deepEqual(statusCalls().slice(before), ["run-2"]);
  await h.handlers.get("session_shutdown")!({}, ctx);
});

test("a foreground /workflow run does not trigger a completion turn", async () => {
  const h = harness({ "run-1": ["running", "completed"] });
  const ctx = h.context();
  await h.handlers.get("session_start")!({}, ctx);
  await h.commands.get("workflow")!.handler("run flow --interval 10ms", ctx);
  assert.ok(h.messages.some(item => item.message.details.kind === "command" && /completed/.test(item.message.content)));
  await h.handlers.get("agent_settled")!({}, ctx);
  await delay(30);
  assert.deepEqual(h.completions(), []);
  const launch = h.requests.find(request => request.action === "run") as Extract<ControlRequest, { action: "run" }>;
  assert.deepEqual(launch.model, { provider: "faux", modelId: "faux-1" });
  assert.equal(launch.thinkingLevel, "medium");
  await h.handlers.get("session_shutdown")!({}, ctx);
});

test("headless sessions need the unattended opt-in to launch", async () => {
  const h = harness({});
  const ctx = { ...h.context(), hasUI: false } as ExtensionContext;
  await h.handlers.get("session_start")!({}, ctx);
  await assert.rejects(h.tools.get("workflow")!.execute("call-1", { action: "run", workflow: { name: "flow" } }, undefined, undefined, ctx),
    (error: { code?: string }) => error.code === "unattended_forbidden");
  assert.equal(h.requests.length, 0);
  await h.handlers.get("session_shutdown")!({}, ctx);
});
