import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage as answer, fauxToolCall as call } from "@earendil-works/pi-ai/providers/faux";
import { AgentRuntime as ProductionRuntime, isAgentChild } from "../src/runtime.ts";
class AgentRuntime extends ProductionRuntime {
  constructor(...[store, options]: ConstructorParameters<typeof ProductionRuntime>) { super(store, { mcp: false, ...options }); }
}
import { LoopStore } from "../src/loops.ts";
import { registerAgentTools, type Services } from "../src/tools.ts";
import { definition, fixture, scripted } from "./helpers.ts";

// No live provider, user auth, or network required: the real SDK drives all sessions and tools.
test("native session continuity survives runner recreation and changes of caller directory", async t => {
  const f = await fixture(t);
  const def = await f.store.create("tester", definition());
  const { models } = await scripted(f.agentDir, [
    ctx => { assert.match(JSON.stringify(ctx), /Test specialist persona/); return answer("remember this fact"); },
    ctx => { assert.match(JSON.stringify(ctx.messages), /remember this fact/); return answer("remembered"); },
  ]);
  let runtime = new AgentRuntime(f.store, { createModels: async () => models, noExtensions: true });
  t.after(() => runtime.close());
  const first = await runtime.run("tester", "first", { cwd: f.cwd });
  assert.equal(first.output, "remember this fact"); assert.equal(first.home, def.home);
  assert.ok(first.usage.totalTokens > 0);
  assert.equal(isAgentChild(), false);
  await runtime.close();
  runtime = new AgentRuntime(f.store, { createModels: async () => models, noExtensions: true });
  const second = await runtime.run("tester", "second", { cwd: f.root });
  assert.equal(second.sessionId, first.sessionId); assert.equal(second.output, "remembered");
  assert.match(await readFile(first.sessionFile!, "utf8"), /remember this fact/);
});

test("real write/bash/read tools run at home but can act outside it", async t => {
  const f = await fixture(t);
  const def = await f.store.create("tester", definition("tester", "tools: [write, bash, read]"));
  const outside = join(f.cwd, "input.txt");
  await writeFile(outside, "outside contents");
  const { models } = await scripted(f.agentDir, [
    answer([call("write", { path: "notes.md", content: "durable note" }), call("bash", { command: "pwd" }), call("read", { path: outside })], { stopReason: "toolUse" }),
    ctx => { const text = JSON.stringify(ctx.messages); assert.match(text, /outside contents/); assert.ok(text.includes(def.home)); return answer("done"); },
  ]);
  const runtime = new AgentRuntime(f.store, { createModels: async () => models, noExtensions: true }); t.after(() => runtime.close());
  const result = await runtime.run("tester", "work elsewhere", { cwd: f.cwd });
  assert.equal(result.output, "done");
  assert.equal(await readFile(join(def.home, "notes.md"), "utf8"), "durable note");
});

test("tool and skill selections are independent; empty lists disable only their category", async t => {
  const f = await fixture(t);
  await mkdir(join(f.agentDir, "skills/test-skill"), { recursive: true });
  await writeFile(join(f.agentDir, "skills/test-skill/SKILL.md"), "---\nname: test-skill\ndescription: Special testing expertise\n---\nInstructions");
  await f.store.create("tester", definition("tester", "tools: []\nskills: [test-skill]"));
  const { models } = await scripted(f.agentDir, [ctx => {
    assert.equal(ctx.messages.flatMap(m => m.role === "system" ? m.toolsAdded ?? [] : []).length, 0);
    assert.match(JSON.stringify(ctx), /Special testing expertise/);
    return answer("no tools");
  }]);
  const runtime = new AgentRuntime(f.store, { createModels: async () => models, noExtensions: true }); t.after(() => runtime.close());
  assert.equal((await runtime.run("tester", "hello")).output, "no tools");
  await f.store.create("missing", definition("missing", "skills: [nonexistent]"));
  await assert.rejects(runtime.run("missing", "hello"), /Unknown skills/);
});

test("approved prompt snapshot is used until approval and changes apply on next run", async t => {
  const f = await fixture(t);
  await f.store.create("tester", definition());
  const candidate = await f.store.propose("tester", (await f.store.source("tester")).replace("Test specialist persona.", "APPROVED NEW PERSONA"));
  const { models } = await scripted(f.agentDir, [
    ctx => { assert.doesNotMatch(JSON.stringify(ctx), /APPROVED NEW PERSONA/); return answer("old"); },
    ctx => { assert.match(JSON.stringify(ctx), /APPROVED NEW PERSONA/); return answer("new"); },
  ]);
  const runtime = new AgentRuntime(f.store, { createModels: async () => models, noExtensions: true }); t.after(() => runtime.close());
  assert.match((await runtime.run("tester", "hi")).warnings.join("\n"), /await human approval/);
  await f.store.approve("tester", candidate.revision);
  assert.equal((await runtime.run("tester", "hi again")).output, "new");
});

test("global and home extensions get lifecycle events; caller workspace resources do not load", async t => {
  const f = await fixture(t);
  const def = await f.store.create("tester", definition());
  const marker = join(f.root, "lifecycle");
  await mkdir(join(f.agentDir, "extensions"));
  await writeFile(join(f.agentDir, "extensions/log.ts"), `import {appendFileSync} from 'node:fs'; export default pi => {
    pi.on('session_start',()=>appendFileSync(${JSON.stringify(marker)},'start\\n'));
    pi.on('session_shutdown',()=>appendFileSync(${JSON.stringify(marker)},'stop\\n'));
  };`);
  await mkdir(join(f.cwd, ".pi/extensions"), { recursive: true });
  await writeFile(join(f.cwd, ".pi/extensions/bad.ts"), "throw new Error('caller workspace must not load')");
  await mkdir(join(def.home, ".pi/extensions"), { recursive: true });
  await writeFile(join(def.home, ".pi/extensions/home.ts"), "export default pi => { pi.on('before_agent_start', e => { e.systemPromptOptions.sections.home_test = 'home extension active'; }); };");
  await writeFile(join(def.home, ".pi/SYSTEM.md"), "unapproved system replacement");
  const { models } = await scripted(f.agentDir, [ctx => {
    assert.match(JSON.stringify(ctx), /home extension active/);
    assert.doesNotMatch(JSON.stringify(ctx), /unapproved system replacement/);
    return answer("lifecycle");
  }]);
  const runtime = new AgentRuntime(f.store, { createModels: async () => models }); t.after(() => runtime.close());
  await runtime.run("tester", "hello", { cwd: f.cwd });
  assert.equal(await readFile(marker, "utf8"), "start\nstop\n");
});

test("nested delegation shares no parent history, resumes specialist and blocks cycles", async t => {
  const f = await fixture(t);
  await f.store.create("parent", definition("parent"));
  await f.store.create("child", definition("child"));
  const { models } = await scripted(f.agentDir, [
    answer(call("agent_run", { name: "child", task: "self-contained task" }), { stopReason: "toolUse" }),
    ctx => { assert.doesNotMatch(JSON.stringify(ctx.messages), /PARENT SECRET/); return answer("child answer"); },
    ctx => { assert.match(JSON.stringify(ctx.messages), /child answer/); return answer("parent answer"); },
  ]);
  let services: Services;
  const runtime = new AgentRuntime(f.store, { createModels: async () => models, noExtensions: true, extension: (name, chain) => pi => registerAgentTools(pi, services, name, chain) });
  services = { store: f.store, runtime, loops: new LoopStore(f.store.root) }; t.after(() => runtime.close());
  assert.equal((await runtime.run("parent", "PARENT SECRET")).output, "parent answer");
  await assert.rejects(runtime.run("child", "cycle", { chain: ["child"] }), /cycle/);
});

test("codemode cannot bypass explicit tool restrictions through deferred tools", async t => {
  const f = await fixture(t);
  await f.store.create("tester", definition("tester", "tools: [codemode]"));
  await mkdir(join(f.agentDir, "extensions"));
  const marker = join(f.root, "forbidden");
  await writeFile(join(f.agentDir, "extensions/secret.ts"), `import {Type} from 'typebox'; import {writeFileSync} from 'node:fs'; export default pi => {
    pi.registerTool({name:'secret',label:'secret',description:'secret',exposure:'codemode',parameters:Type.Object({}),execute:async()=>{writeFileSync(${JSON.stringify(marker)},'BAD'); return {content:[{type:'text',text:'BAD'}],details:{}};}});
  };`);
  const { models } = await scripted(f.agentDir, [
    answer(call("codemode", { code: "return await tools.secret({});" }), { stopReason: "toolUse" }),
    ctx => { assert.match(JSON.stringify(ctx.messages), /excluded by tester|tools.secret does not exist/); return answer("blocked"); },
  ]);
  const runtime = new AgentRuntime(f.store, { createModels: async () => models }); t.after(() => runtime.close());
  assert.equal((await runtime.run("tester", "try forbidden")).output, "blocked");
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("cancellation reaches real SDK tools; same-agent concurrency fails busy and releases lock", async t => {
  const f = await fixture(t);
  await f.store.create("tester", definition());
  const { models } = await scripted(f.agentDir, [answer(call("bash", { command: "sleep 30" }), { stopReason: "toolUse" }), answer("after cancel")]);
  const runtime = new AgentRuntime(f.store, { createModels: async () => models, noExtensions: true }); t.after(() => runtime.close());
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>(r => { started = r; });
  const first = runtime.run("tester", "wait", { signal: controller.signal, onEvent: e => { if (e.type === "tool_execution_start") started(); } });
  const rejected = assert.rejects(first, /cancel|abort/i);
  await ready;
  await assert.rejects(runtime.run("tester", "concurrent"), (e: NodeJS.ErrnoException) => e.code === "ELOCKED");
  controller.abort(new Error("cancelled"));
  await rejected;
  assert.equal((await runtime.run("tester", "after")).output, "after cancel");
});

test("unknown explicit models and unsupported foreign restrictions never silently fall back", async t => {
  const f = await fixture(t);
  await f.store.create("tester", definition("tester", "model: does-not-exist/nothing"));
  await f.store.create("foreign", definition("foreign", "permissionMode: plan"));
  const { models, faux } = await scripted(f.agentDir, []);
  const runtime = new AgentRuntime(f.store, { createModels: async () => models, noExtensions: true }); t.after(() => runtime.close());
  await assert.rejects(runtime.run("tester", "hello"), /not found|Unknown|No models|Could not/i);
  await assert.rejects(runtime.run("foreign", "hello"), /Unsupported runtime fields/);
  assert.equal(faux.state.callCount, 0);
});
