import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage as answer, fauxToolCall as call } from "@earendil-works/pi-ai/providers/faux";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openBot } from "../src/runtime.js";
import { openBotProcess } from "../src/worker-client.js";
import { main } from "../src/cli.js";
import { registerPiBot } from "../src/pi.js";
import { fixture, scripted } from "./helpers.js";

const workerOptions = { diagnostics: { write() { return true; } }, initTimeoutMs: 15000, workerUrl: new URL("./fixtures/worker-scripted.mjs", import.meta.url) };

test("SDK, worker and CLI all recall the same home while executing in different workspaces", async t => {
  const f = await fixture({ maintenance: true }); t.after(f.cleanup);
  const { models } = scripted([answer("SDK agreement: launch in November.")]);
  const embedded = await openBot(f.source, { models, agentDir: f.agentDir, cwd: f.cwd });
  const initial = await embedded.run("Plan the launch."); await embedded.close();
  const worker = await openBotProcess(f.source, { agentDir: f.agentDir, cwd: f.root }, workerOptions); t.after(() => worker.close());
  assert.equal(worker.stateDir, join(f.source, ".bot"));
  const recalled = await worker.callTool("bot_history", { action: "search", query: "November" });
  assert.match(JSON.stringify(recalled), /launch in November/); assert(JSON.stringify(recalled).includes(initial.sessionId));
  const second = await worker.run("Worker followup from another workspace");
  assert.equal(second.status, "completed", second.error); assert.equal(second.cwd, f.root);
  await worker.close();
  let stdout = "", stderr = "";
  const exit = await main(["tool", "call", f.source, "bot_history", "--input", JSON.stringify({ action: "list" }), "--json", "--cwd", f.agentDir], {
    stdout: { write(chunk) { stdout += chunk; return true; } }, stderr: { write(chunk) { stderr += chunk; return true; } },
    openBot: (source, options) => openBotProcess(source, { ...options, agentDir: f.agentDir }, workerOptions),
  });
  assert.equal(exit, 0, stderr);
  const sessions = JSON.parse(JSON.parse(stdout).content[0].text).items;
  assert.deepEqual(sessions.map((item: { sessionId: string }) => item.sessionId), [second.sessionId, initial.sessionId]);
  assert.deepEqual(sessions.map((item: { cwd: string }) => item.cwd), [f.root, f.cwd]);
});

test("Pi bot_run can recall an SDK chat from another cwd and thread", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const workspace = join(f.root, "pi-workspace"); await mkdir(workspace);
  const first = scripted([answer("Previous decision: choose the blue variant.")]);
  const embedded = await openBot(f.source, { models: first.models, agentDir: f.agentDir, cwd: f.cwd });
  const original = await embedded.run("Which variant?"); await embedded.close();
  const next = scripted([
    answer(call("bot_history", { action: "search", query: "blue variant" }), { stopReason: "toolUse" }),
    ctx => { assert.match(JSON.stringify(ctx.messages), /Previous decision/); assert(JSON.stringify(ctx.messages).includes(original.sessionId)); return answer("We chose blue."); },
  ]);
  const tools: Record<string, any> = {}, events: Record<string, any> = {};
  registerPiBot({ registerTool: (tool: { name: string }) => { tools[tool.name] = tool; }, registerCommand() {}, registerFlag() {},
    on: (name: string, handler: unknown) => { events[name] = handler; },
  } as unknown as ExtensionAPI, { root: () => f.root, openBot: (source, options) => openBot(source, { ...options, models: next.models, agentDir: f.agentDir }) });
  t.after(() => events.session_shutdown());
  const result = await tools.bot_run.execute("recall", { bot: f.source, task: "What did we choose before?" }, undefined, undefined, { cwd: workspace, hasUI: false });
  assert.equal(result.details.output, "We chose blue."); assert.equal(result.details.status, "completed");
  assert.equal(result.details.cwd, workspace); assert.notEqual(result.details.sessionId, original.sessionId);
});
