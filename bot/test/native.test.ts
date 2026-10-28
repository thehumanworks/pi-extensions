import test from "node:test";
import { once } from "node:events";
import { fauxAssistantMessage as answer } from "@earendil-works/pi-ai/providers/faux";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, scripted, echoTool } from "./helpers.js";
import { openBot } from "../src/runtime.js";
import { inspectBot } from "../src/project.js";

test("default global: real lifecycle, tool pipeline, additive local tools, no workspace extensions", async t => {
  const f = await fixture({ inherit: "global" }, { "tools/echo.ts": echoTool() }); t.after(f.cleanup);
  await mkdir(join(f.agentDir, "extensions"));
  await writeFile(join(f.source, "BOT.md"), (await readFile(join(f.source, "BOT.md"), "utf8")).replace('inherit: "global"\n', ""));
  const log = join(f.root, "lifecycle");
  await writeFile(join(f.agentDir, "extensions/hooks.ts"), `import { appendFileSync } from 'node:fs';
export default pi => {
 const log = s => appendFileSync(${JSON.stringify(log)}, s+'\\n');
 pi.on('session_start', () => log('start'));
 pi.on('session_shutdown', () => log('stop'));
 pi.on('before_agent_start', () => log('before'));
 pi.on('tool_result', e => ({ content: [{ type: 'text', text: 'hooked' }] }));
};`);
  await mkdir(join(f.cwd, ".pi/extensions"), { recursive: true });
  await writeFile(join(f.cwd, ".pi/extensions/no.ts"), "throw Error('workspace loaded')");
  const info = await inspectBot(f.source, { agentDir: f.agentDir });
  assert.equal(info.inherit, "global");
  await assert.rejects(readFile(log));
  const { models } = scripted([answer("native hello")]);
  const bot = await openBot(f.source, { ...f, models }); t.after(() => bot.close());
  const result = await bot.run("hello");
  assert.equal(result.status, "completed", result.error);
  assert.equal(result.output, "native hello");
  assert(result.usage.output > 0); assert.equal(result.usage.turns, 1);
  assert(!(Object.keys((await bot.listSessions())[0]).includes("nativeEntries")));
  const tool = await bot.callTool("echo", { n: 1 }, { session: result.sessionId });
  assert.equal(tool.content[0].type === "text" && tool.content[0].text, "hooked");
  await bot.close();
  assert.equal(await readFile(log, "utf8"), "start\nbefore\nstop\n");
});

test("native user MCP: stdio discovery, call, tool gates, exclusions, and shutdown; inspect stays offline", async t => {
  const f = await fixture({ inherit: "global", excludeMcpServers: ["blocked"], excludeTools: ["mcp__fake__secret"] }); t.after(f.cleanup);
  const server = join(f.root, "mcp.mjs"), marker = join(f.root, "started");
  await writeFile(server, `import {createInterface} from 'node:readline'; import {appendFileSync,writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(join(f.root, 'pid'))},String(process.pid));
appendFileSync(${JSON.stringify(marker)}, 'start\\n');
const lines = createInterface({input:process.stdin});
lines.on('close',()=>process.exit(0));
lines.on('line',line=>{ const m=JSON.parse(line); if(m.id===undefined)return;
let result;
if(m.method==='initialize') result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fake',version:'1'}};
else if(m.method==='tools/list') result={tools:['echo','secret'].map(name=>({name,description:name,inputSchema:{type:'object',properties:{}}}))};
else if(m.method==='tools/call') result={content:[{type:'text',text:'native mcp answer'}]};
else {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'unsupported'}})+'\\n');return;}
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);
  await writeFile(join(f.agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
    fake: { command: process.execPath, args: [server], exposure: "direct" },
    blocked: { command: process.execPath, args: ["-e", "throw Error('excluded server started')"] },
  } }));
  await mkdir(join(f.cwd, ".pi"));
  await writeFile(join(f.cwd, ".pi/mcp.json"), JSON.stringify({ mcpServers: { fake: { command: "/must-not-run" } } }));
  await inspectBot(f.source, { agentDir: f.agentDir }); await assert.rejects(readFile(marker));
  const { fauxToolCall: call } = await import("@earendil-works/pi-ai/providers/faux");
  const { models } = scripted([
    ctx => {
      assert.match(JSON.stringify(ctx), /mcp__fake__echo/);
      assert.doesNotMatch(JSON.stringify(ctx), /mcp__fake__secret/);
      return answer(call("mcp__fake__echo", {}), { stopReason: "toolUse" });
    },
    ctx => { assert.match(JSON.stringify(ctx.messages), /native mcp answer/); return answer("MCP worked"); },
  ]);
  const bot = await openBot(f.source, { ...f, models }); t.after(() => bot.close());
  const result = await bot.run("use mcp");
  assert.equal(result.status, "completed", result.error); assert.equal(result.output, "MCP worked");
  assert.equal(await readFile(marker, "utf8"), "start\n");
  await bot.close();
  const pid = Number(await readFile(join(f.root, "pid"), "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  // Default MCP exposure is codemode, not direct. It must work without bespoke adapters.
  await writeFile(join(f.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { fake: { command: process.execPath, args: [server] } } }));
  const indirectModels = scripted([
    answer(call("codemode", { code: "return await tools.mcp__fake__echo({});" }), { stopReason: "toolUse" }),
    ctx => { assert.match(JSON.stringify(ctx.messages), /native mcp answer/); return answer("codemode worked"); },
  ]).models;
  const indirect = await openBot(f.source, { ...f, models: indirectModels }); t.after(() => indirect.close());
  const indirectResult = await indirect.run("use default MCP exposure");
  assert.equal(indirectResult.status, "completed", indirectResult.error); assert.equal(indirectResult.output, "codemode worked");
  await indirect.close();
});

test("global exclusions do not execute factories/servers; explicit tools stays restrictive", async t => {
  const f = await fixture({ inherit: "global", tools: ["echo"], excludeTools: ["echo"], excludeExtensions: ["danger*"], excludeMcpServers: ["*"] }, { "tools/echo.ts": echoTool() }); t.after(f.cleanup);
  await mkdir(join(f.agentDir, "extensions"));
  await writeFile(join(f.agentDir, "extensions/danger.ts"), "throw Error('excluded extension executed')");
  await writeFile(join(f.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { bad: { command: "/never-execute" } } }));
  const { models } = scripted([ctx => { assert.doesNotMatch(JSON.stringify(ctx), /"name":"echo"/); return answer("excluded"); }]);
  const bot = await openBot(f.source, { ...f, models }); t.after(() => bot.close());
  const run = await bot.run("hello"); assert.equal(run.status, "completed", run.error);
  const result = await bot.callTool("echo", { n: 1 }); assert.equal(result.isError, true);
});

test("native cancellation reaches a local tool and closes lifecycle resources exactly once", async t => {
  const f = await fixture({ inherit: "global", tools: ["wait"] }); t.after(f.cleanup);
  const marker = join(f.root, "cancelled"), log = join(f.root, "stops");
  await mkdir(join(f.source, "tools"));
  await writeFile(join(f.source, "tools/wait.ts"), `import {Type} from 'typebox'; import {writeFile} from 'node:fs/promises';
export default {name:'wait',description:'wait',parameters:Type.Object({}),execute:async(_args,ctx)=>new Promise((resolve,reject)=>{
 ctx.signal.addEventListener('abort',()=>{writeFile(${JSON.stringify(marker)},'aborted').then(()=>reject(new Error('aborted')));},{once:true});
})};`);
  await mkdir(join(f.agentDir, "extensions"));
  await writeFile(join(f.agentDir, "extensions/lifecycle.ts"), `import {appendFileSync} from 'node:fs'; export default pi=>{pi.on('session_shutdown',()=>appendFileSync(${JSON.stringify(log)},'stop\\n'));};`);
  const { fauxToolCall: call } = await import("@earendil-works/pi-ai/providers/faux");
  const { models } = scripted([answer(call("wait", {}), { stopReason: "toolUse" })]);
  const bot = await openBot(f.source, { ...f, models }); t.after(() => bot.close());
  const controller = new AbortController();
  const run = await bot.run("wait", { signal: controller.signal, onEvent: event => { if (event.type === "tool_execution_start") setTimeout(() => controller.abort(), 10); } });
  assert.equal(run.status, "cancelled", run.error); assert.equal(await readFile(marker, "utf8"), "aborted");
  await bot.close(); await bot.close(); assert.equal(await readFile(log, "utf8"), "stop\n");
});

test("native transcript resumes after reopen and invalid extension reload keeps the live generation", async t => {
  const f = await fixture({ inherit: "global" }); t.after(f.cleanup);
  await mkdir(join(f.agentDir, "extensions"));
  const extension = join(f.agentDir, "extensions/valid.ts");
  await writeFile(extension, "export default pi => {pi.on('session_start',()=>{});};");
  const { models } = scripted([answer("remember this"), ctx => { assert.match(JSON.stringify(ctx.messages), /remember this/); return answer("remembered"); }]);
  let bot = await openBot(f.source, { ...f, models }); t.after(() => bot.close());
  const first = await bot.run("first"); assert.equal(first.status, "completed", first.error);
  const revision = (await bot.info()).revision;
  await writeFile(extension, "export default () => {throw Error('invalid draft')}");
  const reload = await bot.reload(); assert.equal(reload.changed, false); assert.match(reload.diagnostics.join("\n"), /invalid draft/); assert.equal((await bot.info()).revision, revision);
  await writeFile(extension, "export default pi => {pi.on('session_start',()=>{});};");
  await bot.close(); bot = await openBot(f.source, { ...f, models });
  const second = await bot.run("second", { session: first.sessionId });
  assert.equal(second.status, "completed", second.error); assert.equal(second.output, "remembered");
});

test("interrupted native requests are failed closed, never replayed", async t => {
  const { spawn } = await import("node:child_process");
  const { eventually } = await import("./helpers.js");
  const f = await fixture({ inherit: "global", tools: ["effect"] }); t.after(f.cleanup);
  const marker = join(f.root, "effect"), admitted = join(f.root, "admitted");
  await mkdir(join(f.source, "tools"));
  await writeFile(join(f.source, "tools/effect.ts"), `import {Type} from 'typebox'; import {appendFileSync} from 'node:fs';
export default {name:'effect',description:'effect',parameters:Type.Object({}),execute:async()=>{
 appendFileSync(${JSON.stringify(marker)},'effect\\n'); await new Promise(()=>setInterval(()=>{},1000));
}};`);
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
import {openBot} from ${JSON.stringify(new URL("../src/runtime.ts", import.meta.url).href)};
import {scripted} from ${JSON.stringify(new URL("./helpers.ts", import.meta.url).href)};
import {fauxAssistantMessage as answer,fauxToolCall as call} from '@earendil-works/pi-ai/providers/faux';
import {writeFile} from 'node:fs/promises';
const {models}=scripted([answer(call('effect',{}),{stopReason:'toolUse'})]);
const bot=await openBot(${JSON.stringify(f.source)},{agentDir:${JSON.stringify(f.agentDir)},models});
const run=await bot.submit('effect'); await writeFile(${JSON.stringify(admitted)},run.runId);
`], { stdio: ["ignore", "ignore", "pipe"] });
  t.after(() => { child.kill("SIGKILL"); });
  let stderr = ""; child.stderr.on("data", value => { stderr += value; });
  await eventually(async () => readFile(marker, "utf8").catch(() => ""), value => value === "effect\n", 10000).catch(error => { throw new Error(`${error}\n${stderr}`); });
  const id = await readFile(admitted, "utf8");
  const exit = once(child, "exit"); child.kill("SIGKILL"); await exit;
  const { models, faux } = scripted([answer("must not replay")]);
  const bot = await openBot(f.source, { ...f, models }); t.after(() => bot.close());
  const recovered = await eventually(() => bot.getRun(id), run => run.status === "failed");
  assert.match(recovered.error ?? "", /not replayed/); assert.equal(faux.state.callCount, 0);
  assert.equal(await readFile(marker, "utf8"), "effect\n");
});

test("MCP configuration is fingerprinted, not copied into source checkpoints", async t => {
  const f = await fixture({ inherit: "global", excludeMcpServers: ["*"] }); t.after(f.cleanup);
  const file = join(f.agentDir, "mcp.json");
  await writeFile(file, JSON.stringify({ mcpServers: { secret: { url: "https://unused.invalid/mcp", headers: { Authorization: "private-token-never-snapshot" } } } }));
  const { models } = scripted([]);
  const bot = await openBot(f.source, { ...f, models }); t.after(() => bot.close());
  const revision = (await bot.info()).revision;
  const { readdir } = await import("node:fs/promises");
  const root = join(bot.stateDir, "revisions", revision);
  async function contents(path: string): Promise<string> {
    const parts = await Promise.all((await readdir(path, { withFileTypes: true })).map(entry => entry.isDirectory() ? contents(join(path, entry.name)) : readFile(join(path, entry.name), "utf8")));
    return parts.join("\n");
  }
  assert.doesNotMatch(await contents(root), /private-token-never-snapshot/);
  await writeFile(file, JSON.stringify({ mcpServers: {} }));
  assert.notEqual((await bot.reload()).revision, revision);
});

test("cancelling a queued native continuation does not abort the active request", async t => {
  const { eventually } = await import("./helpers.js");
  const f = await fixture({ inherit: "global" }); t.after(f.cleanup);
  const { models } = scripted([answer("active request finishes normally")], 15);
  const bot = await openBot(f.source, { ...f, models }); t.after(() => bot.close());
  const first = await bot.submit("first");
  await eventually(() => bot.getRun(first.runId), run => run.status === "running");
  const second = await bot.submit("queued", { session: first.sessionId });
  await bot.cancel(second.runId);
  assert.equal((await bot.getRun(second.runId)).status, "cancelled");
  const finished = await eventually(() => bot.getRun(first.runId), run => run.status === "completed", 10000);
  assert.equal(finished.output, "active request finishes normally");
});

async function coldMcp(t: { after(fn: () => Promise<void>): void }, exposure: string, fields: Record<string, unknown> = {}) {
  const f = await fixture({ inherit: "global", excludeTools: ["mcp__cold__denied", "bot_*"], ...fields }); t.after(f.cleanup);
  const server = join(f.root, "cold.mjs"), ready = join(f.root, "release"), waiting = join(f.root, "waiting"), calls = join(f.root, "calls");
  await writeFile(server, `import {createInterface} from 'node:readline'; import {watch,existsSync,writeFileSync,appendFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(join(f.root, "pid"))},String(process.pid));
const lines=createInterface({input:process.stdin}); lines.on('close',()=>process.exit(0));
lines.on('line',async line=>{const m=JSON.parse(line); if(m.id===undefined)return; let result;
if(m.method==='initialize') result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'cold',version:'1'}};
else if(m.method==='tools/list') {
 writeFileSync(${JSON.stringify(waiting)},'waiting');
 if(!existsSync(${JSON.stringify(ready)})) await new Promise(resolve=>{const w=watch(${JSON.stringify(f.root)},()=>{if(existsSync(${JSON.stringify(ready)})){w.close();resolve();}});});
 result={tools:['echo','blocked','denied','hidden'].map(name=>({name,description:name,inputSchema:{type:'object',properties:{n:{type:'number'}},required:['n']}}))};
} else if(m.method==='tools/call') {appendFileSync(${JSON.stringify(calls)},m.params.name+'\\n');result={content:[{type:'text',text:'cold:'+m.params.arguments.n}]};}
else {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'unsupported'}})+'\\n');return;}
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);
  await writeFile(join(f.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { cold: { command: process.execPath, args: [server], exposure, toolExposure: { hidden: "hidden" } } } }));
  await mkdir(join(f.agentDir, "extensions"));
  await writeFile(join(f.agentDir, "extensions/gate.ts"), `import {Type} from 'typebox'; import {appendFileSync} from 'node:fs';
export default pi=>{
 pi.registerTool({name:'global_runtime_tool',description:'runtime global',parameters:Type.Object({}),execute:async()=>({content:[],details:undefined})});
 pi.on('tool_call',e=>{if(e.toolName==='mcp__cold__blocked') {appendFileSync(${JSON.stringify(join(f.root, "gated"))},String(!!e.parentToolCallId));return {block:true,reason:'permission denied'};}});
 pi.on('session_shutdown',()=>appendFileSync(${JSON.stringify(join(f.root, "shutdown"))},'shutdown\\n'));
};`);
  const { models, faux } = scripted([]);
  const bot = await openBot(f.source, { ...f, models }); t.after(() => bot.close());
  return { ...f, ready, waiting, calls, bot, faux };
}

for (const exposure of ["direct", "codemode", "deferred"]) test(`cold direct callTool waits for Pi MCP readiness (${exposure}), preserves nested gates, and updates info`, async t => {
  const { eventually } = await import("./helpers.js");
  const f = await coldMcp(t, exposure);
  assert(!(await f.bot.info()).tools.some(tool => tool.name === "global_runtime_tool"));
  let settled = false;
  const pending = f.bot.callTool("mcp__cold__echo", { n: 7 }).finally(() => { settled = true; });
  await eventually(() => readFile(f.waiting, "utf8").catch(() => ""), value => value === "waiting");
  assert.equal(settled, false, "must await the server's readiness, not fail unknown-tool");
  await writeFile(f.ready, "release");
  const result = await pending;
  assert.equal(result.isError, false, JSON.stringify(result)); assert.match(JSON.stringify(result.content), /cold:7/);
  assert.equal(f.faux.state.callCount, 0);
  const names = (await f.bot.info()).tools.map(tool => tool.name);
  assert(names.includes("mcp__cold__echo")); assert(names.includes("global_runtime_tool"));
  assert(!names.includes("mcp__cold__denied")); assert(!names.includes("mcp__cold__hidden")); assert(!names.some(name => name.startsWith("pi_runtime_dispatch_")));
  assert.equal((await f.bot.callTool("mcp__cold__blocked", { n: 1 })).isError, true);
  assert.equal(await readFile(join(f.root, "gated"), "utf8"), "true");
  assert.equal((await f.bot.callTool("mcp__cold__denied", { n: 1 })).isError, true);
  assert.equal((await f.bot.callTool("mcp__cold__hidden", { n: 1 })).isError, true);
  assert.equal((await f.bot.callTool("mcp__cold__echo", { n: "invalid" })).isError, true);
  assert.equal((await f.bot.callTool("mcp__cold__absent", { n: 1 })).isError, true);
  assert.equal(await readFile(f.calls, "utf8"), "echo\n", "blocked/hidden/excluded/invalid nested calls must never reach the server");
});

test("aborting cold direct MCP readiness settles before native session shutdown and closes the server", async t => {
  const { eventually } = await import("./helpers.js");
  const f = await coldMcp(t, "codemode");
  const controller = new AbortController();
  const pending = f.bot.callTool("mcp__cold__echo", { n: 1 }, { signal: controller.signal });
  await eventually(() => readFile(f.waiting, "utf8").catch(() => ""), value => value === "waiting");
  controller.abort();
  const result = await pending;
  assert.equal(result.isError, true);
  await assert.rejects(readFile(f.calls)); await assert.rejects(readFile(join(f.root, "shutdown")));
  await f.bot.close();
  assert.equal(await readFile(join(f.root, "shutdown"), "utf8"), "shutdown\n");
  const pid = Number(await readFile(join(f.root, "pid"), "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("CLI tool call uses cold inherited MCP without a model request", async t => {
  const { main } = await import("../src/cli.js");
  const { eventually } = await import("./helpers.js");
  const { Readable } = await import("node:stream");
  const f = await coldMcp(t, "codemode");
  let output = "", errors = "";
  const pending = main(["tool", "call", f.source, "mcp__cold__echo", "--input", '{"n":9}', "--json"], {
    openBot: async () => f.bot, cwd: f.cwd, env: {}, stdin: Readable.from([]), signal: new AbortController().signal,
    stdout: { write(chunk) { output += chunk.toString(); return true; } },
    stderr: { write(chunk) { errors += chunk.toString(); return true; } },
  });
  await eventually(() => readFile(f.waiting, "utf8").catch(() => ""), value => value === "waiting");
  await writeFile(f.ready, "release");
  assert.equal(await pending, 0, errors); assert.equal(JSON.parse(output).isError, false);
  assert.match(output, /cold:9/); assert.equal(f.faux.state.callCount, 0);
  assert.equal(await readFile(join(f.root, "shutdown"), "utf8"), "shutdown\n");
});

test("cold authored direct call works and its transient issuer never enters the conversation", async t => {
  const f = await fixture({ inherit: "global" }, { "tools/echo.ts": echoTool() }); t.after(f.cleanup);
  const { models } = scripted([answer("first"), ctx => {
    assert.doesNotMatch(JSON.stringify(ctx.messages), /bot-direct:|pi_runtime_dispatch_|v1:42/);
    return answer("continued");
  }]);
  const bot = await openBot(f.source, { ...f, models }); t.after(() => bot.close());
  assert.equal((await bot.callTool("echo", { n: 42 })).isError, false);
  assert.deepEqual(await bot.listSessions(), []);
  const first = await bot.run("first");
  assert.equal((await bot.callTool("echo", { n: 42 }, { session: first.sessionId })).isError, false);
  const second = await bot.run("continue", { session: first.sessionId });
  assert.equal(second.status, "completed", second.error);
});

test("readiness dispatch cannot widen an explicit tools allowlist", async t => {
  const { eventually } = await import("./helpers.js");
  const f = await coldMcp(t, "codemode", { tools: ["global_runtime_tool"] });
  const pending = f.bot.callTool("mcp__cold__echo", { n: 1 });
  await eventually(() => readFile(f.waiting, "utf8").catch(() => ""), value => value === "waiting");
  await writeFile(f.ready, "release");
  const result = await pending;
  assert.equal(result.isError, true); assert.match(JSON.stringify(result.content), /excluded by BOT.md/);
  await assert.rejects(readFile(f.calls));
  assert.deepEqual((await f.bot.info()).tools.map(tool => tool.name), ["global_runtime_tool"]);
});

test("inherit none with a local native factory registers codemode but does not activate it", async t => {
  const f = await fixture({ inherit: "none" }, { "extensions/report.ts": `import {Type} from 'typebox';
export default pi=>pi.registerTool({name:'report',description:'report native tool selection',parameters:Type.Object({}),
execute:async()=>({content:[{type:'text',text:JSON.stringify({active:pi.getActiveTools(),registered:pi.getAllTools().map(t=>t.name)})}],details:undefined})});` });
  t.after(f.cleanup);
  const { models, faux } = scripted([]);
  const bot = await openBot(f.source, { ...f, models }); t.after(() => bot.close());
  const result = await bot.callTool("report", {});
  assert.equal(result.isError, false);
  const content = result.content[0]; assert.equal(content.type, "text");
  const selection = JSON.parse(content.type === "text" ? content.text : "{}");
  assert(selection.registered.includes("codemode")); assert(!selection.active.includes("codemode"));
  assert(!selection.active.includes("tool_search"));
  assert(!(await bot.info()).tools.some(tool => tool.name === "codemode"));
  assert.equal(faux.state.callCount, 0);
});
