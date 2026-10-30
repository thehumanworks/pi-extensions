import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowClient } from "../src/cli.ts";
import { WorkflowError } from "../src/errors.ts";
import { registerOrchestration } from "../src/extension.ts";
import { BIN_PATH, README_PATH } from "../src/guide.ts";
import type { RunRecord, RunStatus } from "../src/index.ts";
import type { ControlRequest } from "../src/protocol.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<void>;
type Entry = { type: "custom"; customType: string; data: unknown } | { type: "custom_message"; customType: string; details: unknown };

function runRecord(id: string, status: RunStatus): RunRecord {
  return {
    id, status, workflow: { name: "flow", path: "/w/flow.ts", hash: "h" }, args: {}, cwd: "/w", model: "faux/faux-1", createdAt: 1, attempt: 1,
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
  let launches = 0;
  const pi = {
    on: (name: string, handler: Handler) => { handlers.set(name, handler); },
    registerTool: (tool: Parameters<typeof tools.set>[1] & { name: string }) => { tools.set(tool.name, tool); },
    registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => { commands.set(name, command); },
    sendMessage: (message: (typeof messages)[number]["message"], options?: (typeof messages)[number]["options"]) => { messages.push({ message, options }); },
    appendEntry: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); },
    getThinkingLevel: () => "medium",
  } as unknown as ExtensionAPI;
  const client: WorkflowClient = {
    async request(request) {
      requests.push(request);
      if (request.action === "run") return { runId: `run-${++launches}`, status: "queued", ...(request.model ? { model: request.model } : {}) };
      if (request.action === "status") {
        const queue = statuses[request.runId] ?? ["completed"];
        return runRecord(request.runId, queue.length > 1 ? queue.shift()! : queue[0]);
      }
      if (request.action === "result" && request.runId === "run-gate") throw new WorkflowError("result_not_ready", 'Run run-gate is waiting for signal "go"; deliver it, then read the result.');
      if (request.action === "signal") return { runId: request.runId, key: request.key, accepted: true };
      // The run finishes just as the agent asks for its result.
      if (request.action === "result") { statuses[request.runId] = ["completed"]; return "done"; }
      if (request.action === "catalog") return [];
      if (request.action === "list") return [runRecord("run-2", "completed"), { ...runRecord("run-3", "running"), origin: { kind: "workflow", parentRunId: "run-2", stepKey: "child" } }];
      throw new Error(`unexpected ${request.action}`);
    },
    rpc: async () => ({}),
    ensure: async () => ({}),
  };
  const notices: string[] = [];
  const prompts = { confirms: 0 };
  const agent = { busy: false };
  const context = (sessionId = "s1", branch: Entry[] = entries) => ({
    cwd: "/w", mode: "rpc", hasUI: true, model: { provider: "faux", id: "faux-1" }, isIdle: () => !agent.busy,
    sessionManager: { getSessionId: () => sessionId, getBranch: () => branch },
    ui: {
      confirm: async () => { prompts.confirms++; return false; },
      notify: (text: string) => { notices.push(text); }, setWidget: () => {},
      setStatus: () => { assert.fail("workflow launches must not set footer status"); },
    },
  }) as unknown as ExtensionContext;
  registerOrchestration(pi, { client, pollIntervalMs: 5, env, printOutput: () => {} });
  const completions = () => messages.filter(item => item.message.details.kind === "completion");
  return { handlers, tools, commands, messages, entries, requests, context, completions, notices, agent, statuses, prompts };
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
  assert.equal(launch.model, "faux/faux-1");
  assert.equal(launch.thinkingLevel, "medium");
  await h.handlers.get("session_shutdown")!({}, ctx);
});

test("root tool and /workflow launches need no interaction in any Pi mode", async () => {
  const exitCode = process.exitCode;
  try {
    for (const mode of ["tui", "rpc", "print", "json"] as const) {
      const h = harness({ "run-1": ["completed"], "run-2": ["running"] });
      const ctx = { ...h.context(), mode, hasUI: mode === "tui" || mode === "rpc" } as ExtensionContext;
      try {
        await h.handlers.get("session_start")!({}, ctx);
        const result = await h.tools.get("workflow")!.execute("call-1",
          { action: "run", workflow: { name: "flow" }, wait: true }, undefined, undefined, ctx) as { details: RunRecord };
        assert.equal(result.details.status, "completed", mode);
        await h.commands.get("workflow")!.handler("run flow --bg --json", ctx);
        assert.ok(h.messages.some(item => /"runId":"run-2"/.test(item.message.content)), mode);
        assert.equal(h.requests.filter(request => request.action === "run").length, 2, mode);
        assert.equal(h.prompts.confirms, 0, mode);
      } finally { await h.handlers.get("session_shutdown")!({}, ctx); }
    }
  } finally { process.exitCode = exitCode; }
});

test("inner tool and /workflow launches still fail with not_from_root in any Pi mode", async () => {
  const exitCode = process.exitCode;
  try {
    for (const mode of ["tui", "rpc", "print", "json"] as const) {
      const h = harness({}, { PI_WORKFLOW_RUN_ID: "parent", PI_WORKFLOW_STEP: "root/agent#0" });
      const ctx = { ...h.context(), mode, hasUI: mode === "tui" || mode === "rpc" } as ExtensionContext;
      try {
        await h.handlers.get("session_start")!({}, ctx);
        await assert.rejects(h.tools.get("workflow")!.execute("call-1",
          { action: "run", workflow: { name: "flow" } }, undefined, undefined, ctx),
          (error: { code?: string; message: string }) => error.code === "not_from_root" && error.message.startsWith("not_from_root: "));
        await h.commands.get("workflow")!.handler("run flow --bg --json", ctx);
        const reply = h.messages.find(item => item.message.details.kind === "command");
        assert.equal(JSON.parse(reply!.message.content).error.code, "not_from_root", mode);
        assert.equal(h.requests.length, 0, mode);
        assert.equal(h.prompts.confirms, 0, mode);
      } finally { await h.handlers.get("session_shutdown")!({}, ctx); }
    }
  } finally { process.exitCode = exitCode; }
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
  assert.deepEqual(tool.parameters.properties.value.anyOf.map((item: { type: string }) => item.type), ["object", "array", "string", "number", "boolean", "null"]);

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
  const ctx = { ...h.context(), model: undefined } as ExtensionContext;
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
  assert.deepEqual(Object.keys(status.details).sort(), ["model", "result", "runId", "status", "summary", "workflow"]);
  assert.equal(status.content[0].text, `${status.details.summary}\ndone`);
  const verbose = await tool.execute("call-4", { action: "status", runId: "run-2", verbose: true }, undefined, undefined, ctx) as ToolReply;
  assert.ok(Array.isArray(verbose.details.steps));
  assert.match(verbose.content[0].text, /\n\nResult:\ndone$/);
  await assert.rejects(tool.execute("call-5", { action: "result", runId: "run-gate" }, undefined, undefined, ctx),
    (error: Error) => error.message === 'result_not_ready: Run run-gate is waiting for signal "go"; deliver it, then read the result. Check it with {"action":"status","runId":"run-gate"}.');
  const signalled = await tool.execute("call-6", { action: "signal", runId: "run-gate", key: "go", value: { ok: true } }, undefined, undefined, ctx) as ToolReply;
  assert.equal(signalled.content[0].text, 'Signal "go" accepted. Check the run with {"action":"status","runId":"run-gate"}.');
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

test("the CLI's --json and the tool's details share one run shape, with the model as a string", async () => {
  const h = harness({ "run-1": ["completed"], "run-2": ["waiting_signal"] });
  const ctx = h.context();
  await h.handlers.get("session_start")!({}, ctx);
  const tool = h.tools.get("workflow")!;
  const call = async (args: Record<string, unknown>) => (await tool.execute("call", args, undefined, undefined, ctx) as ToolReply).details;
  const command = async (line: string) => {
    const before = h.messages.length;
    await h.commands.get("workflow")!.handler(`${line} --json`, ctx);
    const replies = h.messages.slice(before).filter(item => item.message.details.kind === "command");
    assert.equal(replies.length, 1, line);
    return JSON.parse(replies[0].message.content);
  };

  assert.deepEqual(await call({ action: "run", workflow: { name: "flow" } }), { runId: "run-1", status: "queued", model: "faux/faux-1" });
  assert.deepEqual(await command("run flow --bg"), { runId: "run-2", status: "queued", model: "faux/faux-1" });
  assert.deepEqual(h.requests.filter(request => request.action === "run").map(request => (request as { model?: unknown }).model), ["faux/faux-1", "faux/faux-1"]);

  for (const runId of ["run-1", "run-2"]) {
    const brief = await call({ action: "status", runId });
    assert.equal(brief.runId, runId);
    assert.equal(brief.workflow, "flow");
    assert.equal(brief.model, "faux/faux-1");
    assert.deepEqual(await command(`status ${runId}`), brief);
    assert.deepEqual(await command(`poll ${runId} --once`), brief);
  }
  const verbose = await call({ action: "status", runId: "run-1", verbose: true });
  assert.deepEqual(await command("status run-1 --verbose"), verbose);
  assert.equal(verbose.id, "run-1");

  const list = await call({ action: "list" });
  assert.deepEqual(list.map((item: { runId: string; model: string; parentRunId?: string }) => [item.runId, item.model, item.parentRunId]),
    [["run-2", "faux/faux-1", undefined], ["run-3", "faux/faux-1", "run-2"]]);
  assert.deepEqual(await command("list"), list);

  // A foreground launch prints the same brief view once, without a second id field.
  h.statuses["run-3"] = ["completed"];
  const attached = await command("run flow --interval 10ms");
  assert.deepEqual(attached, await call({ action: "status", runId: "run-3" }));
  await h.handlers.get("session_shutdown")!({}, ctx);
});
