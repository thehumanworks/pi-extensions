import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import piAgent from "../index.ts";
import { AgentRuntime } from "../src/runtime.ts";
import { fixture, definition } from "./helpers.ts";

async function harness(t: TestContext, flag?: string, hasUI = true) {
  const f = await fixture(t);
  const oldRoot = process.env.PI_AGENT_HOME, oldDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_AGENT_HOME = f.store.root; process.env.PI_CODING_AGENT_DIR = f.agentDir;
  t.after(() => { if (oldRoot === undefined) delete process.env.PI_AGENT_HOME; else process.env.PI_AGENT_HOME = oldRoot; if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir; });
  const events = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, any>();
  const tools = new Map<string, ToolDefinition>();
  const messages: any[] = [], entries: any[] = [], confirmations: string[] = [], sent: string[] = [];
  let confirm = false;
  let purpose: string | undefined;
  const ctx = {
    cwd: f.cwd, hasUI, mode: "json", isProjectTrusted: () => true, isIdle: () => true, abort() {},
    sessionManager: { getBranch: () => entries },
    ui: { setStatus() {}, setWidget() {}, notify() {}, confirm: async (title: string) => { confirmations.push(title); return confirm; }, input: async () => purpose, editor: async () => { throw new Error("New-agent flow must not ask the user to write a definition."); } },
  } as unknown as ExtensionCommandContext;
  const pi = {
    on: (name: string, callback: (...args: any[]) => any) => { events.set(name, callback); return () => events.delete(name); },
    registerCommand: (name: string, value: any) => commands.set(name, value),
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool), registerFlag() {}, getFlag: () => flag,
    sendMessage: (message: any) => messages.push(message),
    sendUserMessage: (text: string) => sent.push(text),
    appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
  } as unknown as ExtensionAPI;
  piAgent(pi);
  t.after(async () => { await events.get("session_shutdown")?.({}, ctx); });
  const command = (args: string) => commands.get("agent").handler(args, ctx);
  const start = () => events.get("session_start")!({ reason: "startup" }, ctx);
  const input = (text: string) => events.get("input")!({ text, source: "interactive" }, ctx);
  return { ...f, events, tools, messages, entries, confirmations, sent, ctx, command, start, input, purpose: (text: string | undefined) => { purpose = text; }, approve: () => { confirm = true; } };
}

test("flag/default activation routes to SDK runner and off restores ordinary Pi", async t => {
  const h = await harness(t, "tester");
  await h.store.create("tester", definition());
  const calls: string[] = [];
  t.mock.method(AgentRuntime.prototype, "run", async (name: string, task: string) => { calls.push(`${name}:${task}`); return { agent: name, output: "reply", sessionId: "id", sessionFile: "/session", warnings: [], usage: {} }; });
  await h.start();
  assert.equal((await h.input("hello")).action, "handled");
  assert.deepEqual(calls, ["tester:hello"]);
  assert.match(h.messages.at(-1).content, /reply/);
  await h.command("off");
  assert.equal((await h.input("normal")).action, "continue");
  await h.command("tester");
  assert.equal((await h.input("again")).action, "handled");
  assert.equal(calls.at(-1), "tester:again");
  assert.equal(h.entries.findLast(e => e.customType === "pi-agent.selection").data.name, "tester");
});

test("startup selection failure and runtime errors never fall back to the outer model", async t => {
  const h = await harness(t, "missing");
  await h.start();
  assert.equal((await h.input("do something")).action, "handled");
  assert.match(h.messages.at(-1).content, /Unknown agent/);
});

test("human command approval is mandatory; tool surface has no approve/delete actions", async t => {
  const h = await harness(t);
  await h.store.create("tester", definition());
  const raw = await h.store.source("tester");
  await h.store.propose("tester", raw.replace("Test specialist persona.", "changed persona"));
  await h.command("approve tester");
  assert.equal((await h.store.ensure("tester")).prompt, "Test specialist persona.");
  assert.match(h.messages[0].content, /CURRENT:[\s\S]*PROPOSED/);
  h.approve();
  await h.command("approve tester");
  assert.equal((await h.store.ensure("tester")).prompt, "changed persona");
  const manage = h.tools.get("agent_manage")!;
  const schema = JSON.stringify(manage.parameters);
  assert.doesNotMatch(schema, /"const":"delete"|"const":"approve"/);
  await h.command("delete tester");
  assert.match(h.confirmations.at(-1)!, /Delete agent/);
  await assert.rejects(h.store.ensure("tester"), /deleted/);
});

test("headless commands cannot approve or delete even when a confirmation stub says yes", async t => {
  const h = await harness(t, undefined, false);
  await h.store.create("tester", definition());
  await h.store.propose("tester", (await h.store.source("tester")).replace("Test specialist persona.", "changed"));
  h.approve();
  await h.command("approve tester"); await h.command("delete tester");
  assert.equal(h.confirmations.length, 0);
  assert.equal((await h.store.ensure("tester")).prompt, "Test specialist persona.");
  assert.match(h.messages.at(-1).content, /human UI/);
});

test("model management proposes edits and schedules loops without granting administration", async t => {
  const h = await harness(t);
  const manage = h.tools.get("agent_manage")!;
  await manage.execute("create", { action: "create", name: "tester", description: "Tests", prompt: "Original" }, undefined, undefined, h.ctx as any);
  const original = await h.store.source("tester");
  const edit = await manage.execute("edit", { action: "edit", name: "tester", definition: original.replace("Original", "Changed") }, undefined, undefined, h.ctx as any);
  assert.match(JSON.stringify(edit), /awaiting-human-approval/);
  assert.equal((await h.store.ensure("tester")).prompt, "Original");
  const loop = h.tools.get("agent_loop")!;
  await loop.execute("schedule", { action: "put", agent: "tester", name: "tick", task: "check notes", everyMs: 1000 }, undefined, undefined, h.ctx as any);
  const listed = await loop.execute("list", { action: "list" }, undefined, undefined, h.ctx as any);
  assert.match(JSON.stringify(listed), /check notes/);
});

test("/agent new collects only a purpose, asks the active session for a proposal, and accepts after review", async t => {
  const h = await harness(t);
  h.purpose("Review changes for security and test gaps");
  await h.command("new");
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /Review changes for security and test gaps/);
  assert.equal((await h.store.list()).agents.length, 0);
  assert.ok(h.entries.some(e => e.customType === "pi-agent.creation-draft" && e.data.id));
  const tool = h.tools.get("agent_draft")!;
  await tool.execute("proposal", { action: "propose", definition: definition("reviewer", "", "First draft") }, undefined, undefined, h.ctx as any);
  await h.command("accept"); // Declined by human: remains only a draft.
  assert.equal((await h.store.list()).agents.length, 0);
  await tool.execute("revision", { action: "propose", definition: definition("reviewer", "", "Improved draft") }, undefined, undefined, h.ctx as any);
  await h.command("eval check edge cases");
  assert.match(h.sent.at(-1)!, /check edge cases/);
  await assert.rejects(h.tools.get("agent_manage")!.execute("bypass", { action: "create", name: "reviewer", description: "Reviews" }, undefined, undefined, h.ctx as any), /only the human/);
  h.approve();
  await h.command("accept");
  assert.equal((await h.store.ensure("reviewer")).prompt, "Improved draft");
  assert.match(h.messages.at(-1).content, /Your current agent remains selected/);
  assert.equal(h.entries.findLast(e => e.customType === "pi-agent.creation-draft").data.id, null);
});

test("cancelled description and rejected draft do not create an agent", async t => {
  const h = await harness(t);
  await h.command("new");
  assert.equal(h.sent.length, 0);
  h.purpose("Investigate failures");
  await h.command("new debugger");
  const tool = h.tools.get("agent_draft")!;
  await tool.execute("proposal", { action: "propose", definition: definition("debugger") }, undefined, undefined, h.ctx as any);
  h.approve();
  await h.command("reject");
  assert.equal((await h.store.list()).agents.length, 0);
  await assert.rejects(tool.execute("late", { action: "propose", definition: definition("debugger") }, undefined, undefined, h.ctx as any), /closed/);
});

test("new-agent drafting is routed through the selected specialist, not a separate generator", async t => {
  const h = await harness(t, "mentor");
  await h.store.create("mentor", definition("mentor"));
  await h.start();
  h.purpose("Review this project");
  await h.command("new reviewer");
  let author = "", drafting = false;
  t.mock.method(AgentRuntime.prototype, "run", async (name: string, _task: string, options: any) => {
    author = name; drafting = options.drafting;
    return { agent: name, output: "proposal", sessionId: "id", sessionFile: "/session", warnings: [], usage: {} };
  });
  await h.input(h.sent[0]);
  assert.equal(author, "mentor"); assert.equal(drafting, true);
  await h.command("off");
  assert.match(h.messages.at(-1).content, /before leaving its author/);
});

test("headless commands cannot accept creation drafts, and draft tools expose no accept/reject operation", async t => {
  const h = await harness(t);
  h.purpose("Testing"); await h.command("new tester");
  const tool = h.tools.get("agent_draft")!;
  assert.doesNotMatch(JSON.stringify(tool.parameters), /"const":"accept"|"const":"reject"/);
  await tool.execute("proposal", { action: "propose", definition: definition() }, undefined, undefined, h.ctx as any);
  h.approve();
  Object.assign(h.ctx, { hasUI: false });
  await h.command("accept");
  assert.equal(h.confirmations.length, 0);
  assert.match(h.messages.at(-1).content, /human UI/);
  assert.equal((await h.store.list()).agents.length, 0);
});

test("delegation retains the creation-review guard without granting the delegate authoring tools", async t => {
  const h = await harness(t);
  h.purpose("Review code"); await h.command("new reviewer");
  t.mock.method(AgentRuntime.prototype, "run", async function(this: AgentRuntime, name: string, _task: string, options: any) {
    const delegatedTools = new Map<string, ToolDefinition>();
    const child = { registerTool: (tool: ToolDefinition) => delegatedTools.set(tool.name, tool), on() {} } as unknown as ExtensionAPI;
    await this.options.extension!(name, [name], options)(child);
    assert.equal(delegatedTools.has("agent_draft"), false);
    const manage = delegatedTools.get("agent_manage")!;
    await assert.rejects(manage.execute("bypass", { action: "create", name: "reviewer", description: "Reviews" }, undefined, undefined, h.ctx as any), /only the human/);
    return { agent: name, output: "blocked", sessionId: "id", sessionFile: "/session", warnings: [], usage: {} };
  });
  await h.tools.get("agent_run")!.execute("delegate", { name: "helper", task: "Create reviewer on my behalf" }, undefined, undefined, h.ctx as any);
  assert.equal((await h.store.list()).agents.length, 0);
});

test("main-session built-in writes cannot bypass the new-agent acceptance command", async t => {
  const h = await harness(t);
  h.purpose("Review"); await h.command("new reviewer");
  const result = await h.events.get("tool_call")!({ toolName: "write", input: { path: h.store.file("reviewer"), content: "bad" } }, h.ctx);
  assert.equal(result.block, true);
  assert.match(result.reason, /Only the human/);
});
