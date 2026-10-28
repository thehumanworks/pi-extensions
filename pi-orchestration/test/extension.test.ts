import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowClient } from "../src/cli.ts";
import { registerOrchestration } from "../src/extension.ts";
import { BIN_PATH, README_PATH } from "../src/guide.ts";
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
function harness(statuses: Record<string, RunStatus[]>, env: NodeJS.ProcessEnv = {}) {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, { description: string; promptGuidelines?: string[]; parameters: { properties: Record<string, any> }; execute: (...args: unknown[]) => Promise<unknown> }>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  const messages: Array<{ message: { content: string; details: { kind: string; runId?: string } }; options?: { triggerTurn?: boolean } }> = [];
  const entries: Entry[] = [];
  const requests: ControlRequest[] = [];
  const settings: Record<string, unknown> = {};
  let launches = 0;
  const pi = {
    on: (name: string, handler: Handler) => { handlers.set(name, handler); },
    registerTool: (tool: Parameters<typeof tools.set>[1] & { name: string }) => { tools.set(tool.name, tool); },
    registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => { commands.set(name, command); },
    sendMessage: (message: (typeof messages)[number]["message"], options?: (typeof messages)[number]["options"]) => { messages.push({ message, options }); },
    appendEntry: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); },
    getThinkingLevel: () => "medium",
    getSettings: () => structuredClone(settings),
  } as unknown as ExtensionAPI;
  const client: WorkflowClient = {
    async request(request) {
      requests.push(request);
      if (request.action === "run") return { runId: `run-${++launches}`, status: "queued" };
      if (request.action === "status") {
        const queue = statuses[request.runId] ?? ["completed"];
        return runRecord(request.runId, queue.length > 1 ? queue.shift()! : queue[0]);
      }
      // The run finishes just as the agent asks for its result.
      if (request.action === "result") { statuses[request.runId] = ["completed"]; return "done"; }
      if (request.action === "catalog") return [];
      throw new Error(`unexpected ${request.action}`);
    },
    rpc: async () => ({}),
    ensure: async () => ({}),
  };
  const notices: string[] = [];
  const statusBar = new Map<string, string>();
  const prompts = { confirms: 0, accept: true };
  const agent = { busy: false };
  const context = (sessionId = "s1", branch: Entry[] = entries) => ({
    cwd: "/w", mode: "rpc", hasUI: true, model: { provider: "faux", id: "faux-1" }, isIdle: () => !agent.busy,
    sessionManager: { getSessionId: () => sessionId, getBranch: () => branch },
    ui: {
      confirm: async () => { prompts.confirms++; return prompts.accept; },
      notify: (text: string) => { notices.push(text); }, setWidget: () => {},
      setStatus: (key: string, text: string | undefined) => { if (text === undefined) statusBar.delete(key); else statusBar.set(key, text); },
    },
  }) as unknown as ExtensionContext;
  registerOrchestration(pi, { client, pollIntervalMs: 5, env });
  const completions = () => messages.filter(item => item.message.details.kind === "completion");
  return { handlers, tools, commands, messages, entries, requests, context, completions, notices, agent, statuses, settings, statusBar, prompts };
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
  assert.ok(h.messages.some(item => item.message.details.kind === "command" && /completed[^]*\n\ndone$/.test(item.message.content)));
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

test("launches ask by default, and a declined launch never reaches the worker", async () => {
  const h = harness({});
  const ctx = h.context();
  await h.handlers.get("session_start")!({}, ctx);
  h.prompts.accept = false;
  await assert.rejects(h.tools.get("workflow")!.execute("call-1", { action: "run", workflow: { name: "flow" } }, undefined, undefined, ctx),
    (error: { code?: string }) => error.code === "cancelled");
  assert.equal(h.prompts.confirms, 1);
  assert.equal(h.requests.length, 0);
  assert.equal(h.statusBar.size, 0);
  await h.handlers.get("session_shutdown")!({}, ctx);
});

test("settings approval auto launches without asking, headless included, but never from inside a run", async () => {
  const h = harness({ "run-1": ["running"], "run-2": ["running"] });
  h.settings.workflow = { approval: "auto" };
  const ctx = h.context();
  await h.handlers.get("session_start")!({}, ctx);
  assert.equal(h.statusBar.get("workflow-approval"), "workflows auto-approved");
  const tool = h.tools.get("workflow")!;
  await tool.execute("call-1", { action: "run", workflow: { name: "flow" } }, undefined, undefined, ctx);
  // Without a UI, auto stands in for PI_WORKFLOW_ALLOW_UNATTENDED.
  await tool.execute("call-2", { action: "run", workflow: { name: "flow" } }, undefined, undefined, { ...ctx, hasUI: false } as ExtensionContext);
  assert.equal(h.prompts.confirms, 0);
  assert.equal(h.requests.filter(request => request.action === "run").length, 2);
  await h.handlers.get("session_shutdown")!({}, ctx);

  const nested = harness({}, { PI_WORKFLOW_RUN_ID: "parent" });
  nested.settings.workflow = { approval: "auto" };
  const inner = nested.context();
  await nested.handlers.get("session_start")!({}, inner);
  await assert.rejects(nested.tools.get("workflow")!.execute("call-1", { action: "run", workflow: { name: "flow" } }, undefined, undefined, inner),
    (error: { code?: string }) => error.code === "not_from_root");
  assert.equal(nested.requests.length, 0);
  await nested.handlers.get("session_shutdown")!({}, inner);
});

test("/workflow approval overrides settings for one session and survives a restore", async () => {
  const h = harness({ "run-1": ["running"], "run-2": ["running"] });
  h.settings.workflow = { approval: "auto" };
  const ctx = h.context();
  await h.handlers.get("session_start")!({}, ctx);
  const command = h.commands.get("workflow")!;
  const lastOutput = () => h.messages.filter(item => item.message.details.kind === "command").at(-1)?.message.content;
  await command.handler("approval", ctx);
  assert.equal(lastOutput(), "Workflow launches start without asking (settings.json workflow.approval).");

  await command.handler("approval ask", ctx);
  assert.match(lastOutput()!, /^Workflow launches ask for approval \(this session;/);
  assert.equal(h.statusBar.size, 0);
  await h.tools.get("workflow")!.execute("call-1", { action: "run", workflow: { name: "flow" } }, undefined, undefined, ctx);
  assert.equal(h.prompts.confirms, 1);

  // The choice is part of the session: another session starts from settings, and resuming restores it.
  await h.handlers.get("session_start")!({}, h.context("s2", []));
  assert.equal(h.statusBar.get("workflow-approval"), "workflows auto-approved");
  await h.handlers.get("session_start")!({}, ctx);
  assert.equal(h.statusBar.size, 0);
  await h.tools.get("workflow")!.execute("call-2", { action: "run", workflow: { name: "flow" } }, undefined, undefined, ctx);
  assert.equal(h.prompts.confirms, 2);

  delete h.settings.workflow;
  await command.handler("approval auto", ctx);
  assert.equal(h.statusBar.get("workflow-approval"), "workflows auto-approved");
  await command.handler("approval reset", ctx);
  assert.equal(lastOutput(), "Workflow launches ask for approval (default).");
  assert.deepEqual(h.entries.filter(entry => entry.type === "custom" && entry.customType === "workflow_approval")
    .map(entry => (entry as { data: unknown }).data), [{ mode: "ask" }, { mode: "auto" }, {}]);

  await command.handler("approval yolo", ctx);
  assert.ok(h.notices.includes("Usage: /workflow approval [ask|auto|reset]"));
  await h.handlers.get("session_shutdown")!({}, ctx);
});

test("an invalid approval setting refuses launches instead of guessing", async () => {
  const h = harness({});
  h.settings.workflow = { approval: "yes" };
  const ctx = h.context();
  await h.handlers.get("session_start")!({}, ctx);
  assert.ok(h.notices.some(text => /workflow\.approval must be "ask" or "auto", not "yes"/.test(text)));
  await assert.rejects(h.tools.get("workflow")!.execute("call-1", { action: "run", workflow: { name: "flow" } }, undefined, undefined, ctx),
    (error: { code?: string }) => error.code === "invalid_setting");
  assert.equal(h.prompts.confirms, 0);
  assert.equal(h.requests.length, 0);
  await h.handlers.get("session_shutdown")!({}, ctx);
});

type ToolReply = { content: Array<{ text: string }>; details: any };

test("the tool explains every action and an empty catalog teaches authoring", async () => {
  const h = harness({});
  const ctx = h.context();
  const tool = h.tools.get("workflow")!;
  for (const action of tool.parameters.properties.action.anyOf.map((item: { const: string }) => item.const))
    assert.match(tool.description, new RegExp(`\\b${action}\\b`), action);
  assert.ok(tool.promptGuidelines?.some(line => /`pi workflow` is not a command/.test(line)));
  assert.match(tool.parameters.properties.budget.properties.maxAgents.description, /Cap only/);

  const catalog = await tool.execute("call-1", { action: "catalog" }, undefined, undefined, ctx) as ToolReply;
  assert.match(catalog.content[0].text, /^No saved workflows \(searched \/w\/\.pi\/workflows and .*\)\. To write one, call guide/);
  assert.deepEqual(catalog.details.workflows, []);
  assert.equal(catalog.details.searched[0], "/w/.pi/workflows");

  // Without `workflow` on PATH, the guide gives a shell command that works anyway.
  const guide = await tool.execute("call-2", { action: "guide" }, undefined, undefined, ctx) as ToolReply;
  assert.match(guide.content[0].text, /defineWorkflow\(/);
  assert.ok(guide.content[0].text.includes(README_PATH));
  assert.ok(guide.content[0].text.includes(`node ${BIN_PATH} run review-file`));
  assert.ok(guide.content[0].text.includes("This session's model is faux/faux-1:medium."));
});

test("reading a finished run's outcome replaces the completion turn, and status stays brief", async () => {
  const h = harness({ "run-1": ["running"], "run-2": ["completed"] });
  const ctx = h.context();
  await h.handlers.get("session_start")!({}, ctx);
  const tool = h.tools.get("workflow")!;
  const launched = await tool.execute("call-1", { action: "run", workflow: { name: "flow" } }, undefined, undefined, ctx) as ToolReply;
  assert.match(launched.content[0].text, /^Run run-1 queued\. No model is set/);
  await delay(20);
  const result = await tool.execute("call-2", { action: "result", runId: "run-1" }, undefined, undefined, ctx) as ToolReply;
  assert.equal(result.details, "done");
  await h.handlers.get("agent_settled")!({}, ctx);
  await delay(30);
  assert.deepEqual(h.completions(), []);
  assert.ok(h.entries.some(entry => entry.type === "custom" && (entry.data as { done?: boolean }).done && (entry.data as { runId: string }).runId === "run-1"));

  const status = await tool.execute("call-3", { action: "status", runId: "run-2" }, undefined, undefined, ctx) as ToolReply;
  assert.deepEqual(Object.keys(status.details).sort(), ["result", "runId", "status", "summary", "workflow"]);
  assert.equal(status.content[0].text, `${status.details.summary}\ndone`);
  const verbose = await tool.execute("call-4", { action: "status", runId: "run-2", verbose: true }, undefined, undefined, ctx) as ToolReply;
  assert.ok(Array.isArray(verbose.details.steps));
  assert.match(verbose.content[0].text, /\n\nResult:\ndone$/);
  await h.handlers.get("session_shutdown")!({}, ctx);
});

test("a run that ends mid-turn waits for the turn, in case the agent reads it first", async () => {
  const h = harness({ "run-1": ["running"], "run-2": ["running"] });
  const ctx = h.context();
  await h.handlers.get("session_start")!({}, ctx);
  const tool = h.tools.get("workflow")!;
  h.agent.busy = true;
  await tool.execute("call-1", { action: "run", workflow: { name: "flow" } }, undefined, undefined, ctx);
  await tool.execute("call-2", { action: "run", workflow: { name: "flow" } }, undefined, undefined, ctx);
  h.statuses["run-1"] = ["completed"];
  h.statuses["run-2"] = ["completed"];
  await delay(30);
  assert.deepEqual(h.completions(), []);
  // The agent checks run-1 itself during the turn; run-2 is left for the notification.
  await tool.execute("call-3", { action: "status", runId: "run-1" }, undefined, undefined, ctx);
  h.agent.busy = false;
  await h.handlers.get("agent_settled")!({}, ctx);
  await delay(30);
  assert.deepEqual(h.completions().map(item => item.message.details.runId), ["run-2"]);
  await h.handlers.get("session_shutdown")!({}, ctx);
});
