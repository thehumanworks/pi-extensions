import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { acquireLock } from "../src/lock.js";
import { openBot } from "../src/runtime.js";
import { initBot } from "../src/project.js";
import { fauxAssistantMessage as answer, fauxToolCall as call } from "@earendil-works/pi-ai/providers/faux";
import { echoTool, eventually, fixture, scripted } from "./helpers.js";

test("durable runs resume/reopen; new-session request IDs dedupe; tools, usage, events, cwd", async t => {
  const f = await fixture({ tools: ["echo"] }, { "tools/echo.ts": echoTool() }); t.after(f.cleanup);
  const { models, faux } = scripted([answer(call("echo", { n: 2 }), { stopReason: "toolUse" }), answer("Finished"), (ctx) => { assert(ctx.messages.some(m => m.role === "assistant")); return answer("Continued"); }]);
  let bot = await openBot(f.source, { models, agentDir: f.agentDir, cwd: f.cwd }); t.after(() => bot.close());
  const events: string[] = [];
  const result = await bot.run("hello", { requestId: "same", onEvent: event => events.push(event.type) });
  assert.equal(result.status, "completed"); assert.equal(result.output, "Finished"); assert.equal(result.toolCalls, 1); assert.equal(result.usage.turns, 2); assert(result.usage.output > 0);
  assert.match(result.runId, /^drun:/); assert.match(result.sessionId, /^dconv:/); assert.equal(result.cwd, f.cwd);
  assert(events.includes("snapshot")); assert(events.includes("tool_execution_start"));
  await bot.close(); bot = await openBot(f.source, { models, agentDir: f.agentDir });
  assert.equal((await bot.getRun(result.runId)).output, "Finished");
  await assert.rejects(bot.run("different retry message", { requestId: "same" }), error => (error as {code:string}).code === "CONFLICT");
  await assert.rejects(bot.run("hello", { requestId: "same", session: result.sessionId }), error => (error as {code:string}).code === "CONFLICT");
  const duplicate = await bot.run("hello", { requestId: "same" }); assert.equal(duplicate.runId, result.runId); assert.equal(faux.state.callCount, 2);
  const continued = await bot.run("continue", { session: result.sessionId }); assert.equal(continued.output, "Continued"); assert.equal(continued.cwd, f.cwd);
  await assert.rejects(bot.submit("bad cwd", { session: result.sessionId, cwd: f.root }), /bound to/);
  assert.equal((await bot.listSessions()).length, 1);
  let snapshot = false; const stop = await bot.watch(result.sessionId, e => { if (e.type === "snapshot") snapshot = true; }); assert(snapshot); await stop();
});

test("same-run self-edit reloads imported code; invalid draft preserves previous code and is repairable", async t => {
  const f = await fixture({ tools: ["bot_write", "echo"] }, { "tools/echo.ts": echoTool() }); t.after(f.cleanup);
  const { models } = scripted([
    answer(call("bot_write", { area: "source", path: "tools/echo.ts", content: echoTool("v2") }), { stopReason: "toolUse" }),
    answer(call("echo", { n: 7 }), { stopReason: "toolUse" }),
    ctx => { assert.match(JSON.stringify(ctx.messages), /v2:7/); return answer(call("bot_write", { area: "source", path: "tools/echo.ts", content: "export default { broken" }), { stopReason: "toolUse" }); },
    ctx => { assert.match(JSON.stringify(ctx.messages), /Capability reload rejected/); return answer(call("echo", { n: 8 }), { stopReason: "toolUse" }); },
    ctx => { assert.match(JSON.stringify(ctx.messages), /v2:8/); return answer(call("bot_write", { area: "source", path: "tools/echo.ts", content: echoTool("v3") }), { stopReason: "toolUse" }); },
    answer(call("echo", { n: 9 }), { stopReason: "toolUse" }),
    ctx => { assert.match(JSON.stringify(ctx.messages), /v3:9/); return answer("repaired"); },
  ]);
  const bot = await openBot(f.source, { models, agentDir: f.agentDir, cwd: f.cwd }); t.after(() => bot.close());
  const result = await bot.run("Improve yourself"); assert.equal(result.status, "completed", result.error); assert.equal(result.output, "repaired"); assert.equal(result.toolCalls, 6);
  assert.deepEqual((await bot.info()).diagnostics, []);
});

test("direct tools validate schemas and respect selected capabilities; ephemeral isolates source and state", async t => {
  const f = await fixture({ tools: ["echo", "bot_write"] }, { "tools/echo.ts": echoTool() }); t.after(f.cleanup);
  const { models } = scripted([]);
  const bot = await openBot(f.source, { models, ephemeral: true, agentDir: f.agentDir, cwd: f.cwd }); t.after(() => bot.close());
  assert.notEqual(bot.sourceDir, f.source); assert.notEqual(bot.stateDir, join(f.source, ".bot"));
  assert.match(JSON.stringify(await bot.callTool("echo", { n: 4 })), /v1:4/);
  await assert.rejects(bot.callTool("echo", { n: "no" }), /validation|number|Invalid/i);
  await assert.rejects(bot.callTool("bash", {}), /not enabled/);
  await bot.callTool("bot_write", { area: "source", path: "tools/echo.ts", content: echoTool("scratch") });
  assert.match(JSON.stringify(await bot.callTool("echo", { n: 1 })), /scratch/);
  assert.match(await readFile(join(f.source, "tools/echo.ts"), "utf8"), /v1/);
  await assert.rejects(bot.callTool("bot_write", { area: "memory", path: "runtime.sqlite", content: "bad" }), /Memory access/);
});

test("queued requests survive close and restart; cross-process ownership locks release", async t => {
  const f = await fixture({ tools: [] }); t.after(f.cleanup);
  const slow = scripted([answer("A very long streaming answer that should be interrupted by close")], 5);
  let bot = await openBot(f.source, { models: slow.models, agentDir: f.agentDir, cwd: f.cwd }); t.after(() => bot.close());
  await assert.rejects(openBot(f.source, { models: slow.models, agentDir: f.agentDir }), /already open/);
  const first = await bot.submit("first"); const second = await bot.submit("second");
  await eventually(() => bot.getRun(first.runId), r => r.status === "running");
  await bot.close(); await bot.close();
  const fast = scripted([answer("Recovered"), answer("Second")]);
  bot = await openBot(f.source, { models: fast.models, agentDir: f.agentDir });
  const a = await eventually(() => bot.getRun(first.runId), r => ["completed", "failed"].includes(r.status));
  const b = await eventually(() => bot.getRun(second.runId), r => r.status === "completed");
  assert.equal(a.status, "completed", a.error); assert.equal(b.output, "Second");
});

test("cancellation by run signal stops owned work; cancellation of queued run does not stop another", async t => {
  const f = await fixture({ tools: [] }); t.after(f.cleanup);
  const { models } = scripted([answer("long streaming response that will not finish before cancellation")], 10);
  const bot = await openBot(f.source, { models, agentDir: f.agentDir }); t.after(() => bot.close());
  const controller = new AbortController(); const running = bot.run("slow", { signal: controller.signal });
  const sessions = await eventually(() => bot.listSessions(), s => s.length > 0);
  assert(sessions.length); const queued = await bot.submit("queued"); await bot.cancel(queued.runId); assert.equal((await bot.getRun(queued.runId)).status, "cancelled");
  controller.abort(); const result = await running; assert.equal(result.status, "cancelled");
});

test("saved Pi model defaults are usable without inheritance and unknown models fail before execution", async t => {
  const f = await fixture({ model: undefined, tools: [] }); t.after(f.cleanup);
  // Remove undefined YAML produced by the simple fixture author, leaving the field absent.
  await writeFile(join(f.source, "BOT.md"), (await readFile(join(f.source, "BOT.md"), "utf8")).replace("model: undefined\n", ""));
  await writeFile(join(f.agentDir, "settings.json"), JSON.stringify({ defaultProvider: "faux", defaultModel: "faux-1" }));
  const { models, faux } = scripted([answer("saved default")]);
  const bot = await openBot(f.source, { models, agentDir: f.agentDir }); t.after(() => bot.close());
  assert.equal((await bot.run("hi")).output, "saved default");
  await assert.rejects(openBot(join(f.source, "BOT.md"), { models, stateDir: join(f.root, "other"), model: "no/model", agentDir: f.agentDir }), /already open/);
  await bot.close();
  await assert.rejects(openBot(f.source, { models, model: "no/model", agentDir: f.agentDir }), /Unknown or ambiguous model/); assert.equal(faux.state.callCount, 1);
});

test("default ModelRuntime uses existing Pi user auth paths independently of state and inheritance", async t => {
  const f = await fixture({ tools: [] }); t.after(f.cleanup);
  const { models } = scripted([answer("default runtime")]);
  const original = ModelRuntime.create; const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = f.agentDir;
  let called = false;
  ModelRuntime.create = async options => {
    called = true;
    assert.equal(options?.authPath, join(f.agentDir, "auth.json"));
    assert.equal(options?.modelsPath, join(f.agentDir, "models.json"));
    assert.equal(options?.allowModelNetwork, false);
    return models as unknown as ModelRuntime;
  };
  t.after(() => { ModelRuntime.create = original; if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  const bot = await openBot(f.source, { stateDir: join(f.root, "relocated") }); t.after(() => bot.close());
  assert(called); assert.equal((await bot.run("hi")).output, "default runtime");
});

test("kernel lock survives competing processes and safely recovers stale PID metadata", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const path = join(f.root, "ownership.lock");
  const child = spawn(process.execPath, [fileURLToPath(new URL("./lock.test-helper.mjs", import.meta.url)), path], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  await once(child.stdout!, "data");
  await assert.rejects(acquireLock(path), /already open/);
  const before = await readFile(path, "utf8");
  child.kill("SIGKILL"); await once(child, "exit");
  const release = await acquireLock(path); assert.notEqual(await readFile(path, "utf8"), before);
  await release(); assert.match(await readFile(path, "utf8"), /pid/); // no unlink/recreation race
});

test("unsafe external tool effects are interrupted, never replayed after restart", async t => {
  const tool = `import {defineTool,Type} from '@nothumanwork/bot'; import {appendFile} from 'node:fs/promises'; import {join} from 'node:path';
export default defineTool({name:'effect',description:'external effect',parameters:Type.Object({}),execute:async(_,ctx)=>{await appendFile(join(ctx.cwd,'effects'),'x'); await new Promise((_,reject)=>ctx.signal.addEventListener('abort',()=>reject(ctx.signal.reason),{once:true})); return 'done';}});`;
  const f = await fixture({ tools: ["effect"] }, { "tools/effect.ts": tool }); t.after(f.cleanup);
  const first = scripted([answer(call("effect", {}), { stopReason: "toolUse" })]);
  let bot = await openBot(f.source, { models: first.models, agentDir: f.agentDir, cwd: f.cwd }); t.after(() => bot.close());
  const accepted = await bot.submit("effect");
  await eventually(() => readFile(join(f.cwd, "effects"), "utf8").catch(() => ""), value => value === "x");
  await bot.close();
  const resumed = scripted([ctx => { assert.match(JSON.stringify(ctx.messages), /interrupted/i); return answer("effect interrupted"); }]);
  bot = await openBot(f.source, { models: resumed.models, agentDir: f.agentDir });
  const result = await eventually(() => bot.getRun(accepted.runId), r => r.status === "completed");
  assert.equal(result.output, "effect interrupted"); assert.equal(await readFile(join(f.cwd, "effects"), "utf8"), "x");
});

test("last good local checkpoint survives invalid source across restart", async t => {
  const f = await fixture({ tools: ["echo", "bot_write"] }, { "tools/echo.ts": echoTool("valid") }); t.after(f.cleanup);
  const { models } = scripted([]);
  let bot = await openBot(f.source, { models, agentDir: f.agentDir }); t.after(() => bot.close());
  await writeFile(join(f.source, "tools/echo.ts"), "export default { broken");
  const reload = await bot.reload(); assert(reload.diagnostics.length); await bot.close();
  bot = await openBot(f.source, { models, agentDir: f.agentDir });
  assert((await bot.info()).diagnostics.some(d => d.includes("last known good")));
  assert.match(JSON.stringify(await bot.callTool("echo", { n: 1 })), /valid:1/);
  await bot.callTool("bot_write", { area: "source", path: "tools/echo.ts", content: echoTool("repaired") });
  assert.match(JSON.stringify(await bot.callTool("echo", { n: 1 })), /repaired:1/);
});

test("interrupted replay-safe calls use their local code checkpoint before activating new drafts", async t => {
  const old = `import {defineTool,Type} from '@nothumanwork/bot'; import {readFile,writeFile} from 'node:fs/promises'; import {join} from 'node:path';
export default defineTool({name:'version',description:'version',parameters:Type.Object({}),replay:'safe',execute:async(_,ctx)=>{const path=join(ctx.cwd,'started'); if(await readFile(path,'utf8').catch(()=>''))return 'old'; await writeFile(path,'yes'); await new Promise((_,reject)=>ctx.signal.addEventListener('abort',()=>reject(ctx.signal.reason),{once:true})); return 'old';}});`;
  const replacement = `import {defineTool,Type} from '@nothumanwork/bot'; export default defineTool({name:'version',description:'version',parameters:Type.Object({}),replay:'safe',execute:async()=> 'new'});`;
  const f = await fixture({ tools: ["version"] }, { "tools/version.ts": old }); t.after(f.cleanup);
  const first = scripted([answer(call("version", {}), { stopReason: "toolUse" })]);
  let bot = await openBot(f.source, { models: first.models, agentDir: f.agentDir, cwd: f.cwd }); t.after(() => bot.close());
  const run = await bot.submit("which version");
  await eventually(() => readFile(join(f.cwd, "started"), "utf8").catch(() => ""), value => value === "yes");
  await bot.close(); await writeFile(join(f.source, "tools/version.ts"), replacement);
  const next = scripted([ctx => { assert.match(JSON.stringify(ctx.messages), /"text":"old"/); return answer("Recovered old implementation"); }]);
  bot = await openBot(f.source, { models: next.models, agentDir: f.agentDir });
  const result = await eventually(() => bot.getRun(run.runId), r => r.status === "completed" || r.status === "failed");
  assert.equal(result.status, "completed", result.error);
  assert.equal(result.output, "Recovered old implementation");
  assert.match(JSON.stringify(await bot.callTool("version", {})), /new/);
});

test("scaffold auto-discovers newly authored tools, skills and persona in the same run", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const source = join(f.root, "fresh");
  await initBot(source, { model: "faux/faux-1", prompt: "Initial persona." });
  const definition = (await readFile(join(source, "BOT.md"), "utf8")).replace("Initial persona.", "Improved persona in the same conversation.");
  const { models } = scripted([
    answer([
      call("bot_write", { area: "source", path: "tools/new_tool.ts", content: echoTool("fresh-code", "new_tool") }),
      call("bot_write", { area: "source", path: "skills/new-skill/SKILL.md", content: "---\nname: new-skill\ndescription: Fresh skill visible immediately\n---\nNew skill instructions.\n" }),
      call("bot_write", { area: "source", path: "BOT.md", content: definition }),
    ], { stopReason: "toolUse" }),
    ctx => { const text = JSON.stringify(ctx.messages); assert.match(text, /Improved persona/); assert.match(text, /Fresh skill visible immediately/); assert.match(text, /new_tool/); return answer(call("new_tool", { n: 5 }), { stopReason: "toolUse" }); },
    ctx => { assert.match(JSON.stringify(ctx.messages), /fresh-code:5/); return answer("autonomously improved"); },
  ]);
  const bot = await openBot(source, { models, agentDir: f.agentDir }); t.after(() => bot.close());
  const result = await bot.run("Improve your capabilities"); assert.equal(result.status, "completed", result.error); assert.equal(result.output, "autonomously improved");
  assert.equal(result.toolCalls, 4); assert((await bot.info()).tools.some(t => t.name === "new_tool"));
  assert(!(await readFile(join(source, "BOT.md"), "utf8")).includes("tools: ["));
});

test("public errors have stable transport-neutral codes", async t => {
  const f = await fixture({ tools: [] }); t.after(f.cleanup);
  const { models } = scripted([answer("ok")]);
  const code = (expected: string) => (error: unknown) => (error as {code:string}).code === expected;
  await assert.rejects(openBot(join(f.root, "missing"), { models, agentDir: f.agentDir }), code("NOT_FOUND"));
  await assert.rejects(openBot(f.source, { models, model: "missing/model", agentDir: f.agentDir }), code("INVALID_INPUT"));
  const bot = await openBot(f.source, { models, agentDir: f.agentDir, cwd: f.cwd });
  await assert.rejects(openBot(f.source, { models, agentDir: f.agentDir }), code("CONFLICT"));
  await assert.rejects(bot.submit(""), code("INVALID_INPUT"));
  await assert.rejects(bot.getRun("drun:99999"), code("NOT_FOUND"));
  await assert.rejects(bot.callTool("bash", {}), code("NOT_FOUND"));
  const record = await bot.run("hi");
  await assert.rejects(bot.submit("hi", { session: record.sessionId, cwd: f.root }), code("CONFLICT"));
  await bot.close(); await assert.rejects(bot.info(), code("UNAVAILABLE"));
});
