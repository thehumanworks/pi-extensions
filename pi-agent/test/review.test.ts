import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage as answer, fauxToolCall as call } from "@earendil-works/pi-ai/providers/faux";
import { AgentRuntime } from "../src/runtime.ts";
import { LoopStore, Scheduler } from "../src/loops.ts";
import { fixture, definition, scripted } from "./helpers.ts";

// Regression cases identified during the independent review.
test("one slow agent cannot block another agent's later deadline", async t => {
  const { root } = await fixture(t);
  const loops = new LoopStore(root);
  await loops.put("slow", "work", "slow", { everyMs: 1000 }, 0);
  await loops.put("fast", "work", "fast", { everyMs: 2000 }, 0);
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const calls: string[] = [];
  const scheduler = new Scheduler(loops, async loop => { calls.push(loop.agent); if (loop.agent === "slow") await gate; return {}; });
  t.after(() => scheduler.stop());
  await scheduler.tick(1000);
  assert.deepEqual(calls, ["slow"]);
  await scheduler.tick(2000);
  assert.deepEqual(calls, ["slow", "fast"]);
  release(); await scheduler.waitForIdle();
});

test("simultaneously due loops for one agent execute serially without losing an occurrence", async t => {
  const { root } = await fixture(t);
  const loops = new LoopStore(root);
  await loops.put("tester", "one", "one", { everyMs: 1000 }, 0);
  await loops.put("tester", "two", "two", { everyMs: 1000 }, 0);
  const calls: string[] = [];
  const scheduler = new Scheduler(loops, async loop => { calls.push(loop.name); return {}; });
  t.after(() => scheduler.stop());
  await scheduler.tick(1000); await scheduler.waitForIdle();
  assert.equal(calls.length, 1);
  await scheduler.tick(1000); await scheduler.waitForIdle();
  assert.deepEqual(calls.sort(), ["one", "two"]);
  assert.ok((await loops.list()).every(l => l.last?.status === "completed"));
});

test("known busy admission is deferred, but an uncertain execution is not retried", async t => {
  const { root } = await fixture(t);
  const loops = new LoopStore(root);
  await loops.put("tester", "work", "task", { everyMs: 1000 }, 0);
  let calls = 0;
  const scheduler = new Scheduler(loops, async () => {
    if (++calls === 1) throw Object.assign(new Error("busy"), { code: "ELOCKED" });
    throw new Error("unknown external effect");
  });
  t.after(() => scheduler.stop());
  await scheduler.tick(1000); await scheduler.waitForIdle();
  let loop = (await loops.list())[0];
  assert.equal(loop.last?.status, "busy");
  await scheduler.tick(loop.nextAt); await scheduler.waitForIdle();
  loop = (await loops.list())[0];
  assert.equal(loop.last?.status, "failed");
  await scheduler.tick(loop.nextAt - 1); await scheduler.waitForIdle();
  assert.equal(calls, 2);
});

test("handled input on a resumed session cannot report the previous answer as a new reply", async t => {
  const f = await fixture(t);
  await f.store.create("tester", definition());
  await mkdir(join(f.agentDir, "extensions"));
  await writeFile(join(f.agentDir, "extensions/handle.ts"), "export default pi => { pi.on('input', e => e.text === 'handled' ? {action:'handled'} : undefined); };");
  const { models, faux } = await scripted(f.agentDir, [answer("old reply")]);
  const runtime = new AgentRuntime(f.store, { mcp: false, createModels: async () => models }); t.after(() => runtime.close());
  await runtime.run("tester", "first");
  await assert.rejects(runtime.run("tester", "handled"), /new assistant response/);
  assert.equal(faux.state.callCount, 1);
});

test("direct write of a registry definition is blocked, not treated as self-approval", async t => {
  const f = await fixture(t);
  await f.store.create("tester", definition());
  const before = await f.store.source("tester");
  const { models } = await scripted(f.agentDir, [
    answer(call("write", { path: f.store.file("tester"), content: definition("tester", "", "Unapproved") }), { stopReason: "toolUse" }),
    ctx => { assert.match(JSON.stringify(ctx.messages), /Registry files are managed by agent_manage/); return answer("will propose instead"); },
  ]);
  const runtime = new AgentRuntime(f.store, { mcp: false, noExtensions: true, createModels: async () => models }); t.after(() => runtime.close());
  await runtime.run("tester", "change yourself");
  assert.equal(await readFile(f.store.file("tester"), "utf8"), before);
});

test("a corrupted proposal cannot reuse an already displayed approval revision", async t => {
  const { store } = await fixture(t);
  await store.create("tester", definition());
  const candidate = await store.propose("tester", (await store.source("tester")).replace("Test specialist persona.", "reviewed"));
  await writeFile(join(store.state("tester"), "pending.json"), JSON.stringify({ ...candidate, source: candidate.source.replace("reviewed", "NOT reviewed") }));
  await assert.rejects(store.approve("tester", candidate.revision), /Invalid proposal revision/);
  assert.equal((await store.ensure("tester")).prompt, "Test specialist persona.");
});

test("native SDK MCP discovery, invocation and shutdown use real transports without network", async t => {
  const f = await fixture(t);
  await f.store.create("tester", definition("tester", "tools: [mcp__fake__echo]"));
  const server = join(f.root, "mcp.mjs"), pidFile = join(f.root, "pid");
  await writeFile(server, `import {createInterface} from 'node:readline'; import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
const lines=createInterface({input:process.stdin}); lines.on('close',()=>process.exit(0));
lines.on('line',line=>{const m=JSON.parse(line); if(m.id===undefined)return;
const result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fake',version:'1'}}:
m.method==='tools/list'?{tools:[{name:'echo',description:'echo',inputSchema:{type:'object',properties:{}}}]}:
{content:[{type:'text',text:'mcp offline answer'}]}; process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);
  const { models } = await scripted(f.agentDir, [
    answer(call("mcp__fake__echo", {}), { stopReason: "toolUse" }),
    ctx => { assert.match(JSON.stringify(ctx.messages), /mcp offline answer/); return answer("MCP works"); },
  ]);
  const runtime = new AgentRuntime(f.store, {
    createModels: async () => models,
    mcp: { loadConfig: () => ({ errors: [], servers: [{ name: "fake", source: server, config: { command: process.execPath, args: [server], exposure: "direct" } }] }), logPath: join(f.root, "mcp.log") },
  }); t.after(() => runtime.close());
  assert.equal((await runtime.run("tester", "use mcp")).output, "MCP works");
  const pid = Number(await readFile(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
