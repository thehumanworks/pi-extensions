import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { openBotProcess, type WorkerOptions } from "../src/worker-client.js";
import { serve } from "../src/server.js";
import { acquireLock } from "../src/lock.js";
import type { BotEvent } from "../src/types.js";
import { fixture, eventually, scripted } from "./helpers.js";

const quiet: WorkerOptions = { diagnostics: { write() { return true; } }, initTimeoutMs: 15_000 };
const fauxWorker = new URL("./fixtures/worker-scripted.mjs", import.meta.url);
const echo = `export default {name:'echo',description:'offline echo',parameters:{type:'object',properties:{n:{type:'number'}},required:['n']},execute:async(args,ctx)=>({content:[{type:'text',text:JSON.stringify({pid:process.pid,n:args.n,cwd:ctx.cwd,execArgv:process.execArgv,nodeOptions:process.env.NODE_OPTIONS??null})}]})};`;
const block = `export default {name:'block',description:'noncooperative tool',parameters:{type:'object',properties:{marker:{type:'string'},mode:{type:'string'}},required:['marker','mode']},execute:async(args)=>{
  const {spawn}=await import('node:child_process'); const {writeFile}=await import('node:fs/promises');
  const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore',detached:true});
  await writeFile(args.marker,JSON.stringify({worker:process.pid,descendant:child.pid}));
  if(args.mode==='cpu'){for(;;){}} await new Promise(()=>{});
}};`;
const isUnavailable = (error: unknown) => (error as { code?: string }).code === "UNAVAILABLE";
async function live(pid: number): Promise<boolean> {
  try { const stat = await readFile(`/proc/${pid}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z"; }
  catch { try { process.kill(pid, 0); return true; } catch { return false; } }
}
async function marker(path: string): Promise<{ worker: number; descendant: number }> {
  return eventually(async () => JSON.parse(await readFile(path, "utf8").catch(() => "null")), value => value !== null);
}

test("real compiled worker opens with Pi catalog/no auth, typed tools, stable errors, close/reopen and clean execArgv", async t => {
  const f = await fixture({ model: "openai/gpt-4o", tools: ["echo"] }, { "tools/echo.ts": echo }); t.after(f.cleanup);
  const options = { agentDir: f.agentDir, cwd: f.cwd };
  let bot = await (async () => {
    const previous = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = "--inspect=0 --import=/must-not-inherit-a-parent-loader.mjs";
    try { return await openBotProcess(f.source, options, quiet); }
    finally { if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous; }
  })(); t.after(() => bot.close());
  assert.equal(bot.sourceDir, f.source); assert.equal(bot.stateDir, join(f.source, ".bot"));
  const info = await bot.info(); assert.equal("format" in info, false); assert.equal(info.model, "openai/gpt-4o");
  const result = await bot.callTool("echo", { n: 7 });
  const detail = JSON.parse((result.content[0] as { text: string }).text);
  assert.notEqual(detail.pid, process.pid); assert.equal(detail.cwd, f.cwd); assert.deepEqual(detail.execArgv, []); assert.equal(detail.nodeOptions, null);
  await assert.rejects(bot.callTool("echo", { n: "wrong" }), error => (error as { code?: string }).code === "INVALID_INPUT");
  await assert.rejects(bot.getRun("drun:99999"), error => (error as { code?: string }).code === "NOT_FOUND");
  await assert.rejects(bot.watch("dconv:99999", () => {}), error => (error as { code?: string }).code === "NOT_FOUND");
  assert.deepEqual(await bot.listSessions(), []); assert.equal((await bot.reload()).changed, false);
  await bot.close(); await bot.close();
  await assert.rejects(bot.info(), isUnavailable); await assert.rejects(bot.submit("closed"), isUnavailable);
  bot = await openBotProcess(f.source, options, quiet); assert.equal((await bot.info()).name, "tester"); await bot.close();
});

test("actual dispatcher run/submit callbacks, snapshots, status, explicit cancel and forwarded run/submit AbortSignals", async t => {
  const f = await fixture({ tools: ["echo"] }, { "tools/echo.ts": echo }); t.after(f.cleanup);
  const bot = await openBotProcess(f.source, { agentDir: f.agentDir, cwd: f.cwd }, { ...quiet, workerUrl: fauxWorker }); t.after(() => bot.close());
  const events: BotEvent[] = [];
  const completed = await bot.run("offline run", { requestId: "retry", onEvent: event => events.push(event) });
  assert.equal(completed.status, "completed"); assert.match(completed.output, /Offline deterministic/); assert.ok(events.some(event => event.type === "snapshot"));
  assert.equal((await bot.run("offline run", { requestId: "retry" })).runId, completed.runId);
  assert.equal((await bot.getRun(completed.runId)).status, "completed"); assert.equal((await bot.listSessions()).length, 1);
  const watched: BotEvent[] = []; const stop = await bot.watch(completed.sessionId, event => watched.push(event));
  await eventually(async () => watched.length, value => value > 0); assert.equal(watched[0].type, "snapshot"); await stop(); await stop();
  const controller = new AbortController(); const submissionEvents: BotEvent[] = [];
  const accepted = await bot.submit("abort after acceptance", { signal: controller.signal, onEvent: event => submissionEvents.push(event) });
  controller.abort();
  await eventually(() => bot.getRun(accepted.runId), run => run.status === "cancelled");
  await eventually(async () => submissionEvents, value => value.some(event => event.type === "run_settled"));
  const queued = await bot.submit("cancel by ID"); await bot.cancel(queued.runId);
  assert.equal((await bot.getRun(queued.runId)).status, "cancelled");
  const runController = new AbortController(); const running = bot.run("cancel foreground", { signal: runController.signal, onEvent: event => {
    if (event.type === "snapshot") runController.abort();
  } });
  assert.equal((await running).status, "cancelled");
  const preAborted = new AbortController(); preAborted.abort();
  await assert.rejects(bot.run("never admitted", { signal: preAborted.signal }), { name: "AbortError" });
});

test("cooperative direct-tool cancellation reaches its actual child AbortSignal", async t => {
  const cooperative = `export default {name:'cooperative',description:'abort observer',parameters:{type:'object',properties:{marker:{type:'string'}},required:['marker']},execute:async(args,ctx)=>{
    const {writeFile}=await import('node:fs/promises');
    const stopped=new Promise(resolve=>ctx.signal.addEventListener('abort',()=>resolve({content:[{type:'text',text:'aborted in child'}]}),{once:true}));
    await writeFile(args.marker,'ready'); return stopped;
  }};`;
  const f = await fixture({ model: "openai/gpt-4o", tools: ["cooperative"] }, { "tools/cooperative.ts": cooperative }); t.after(f.cleanup);
  const bot = await openBotProcess(f.source, { agentDir: f.agentDir }, quiet); t.after(() => bot.close());
  const controller = new AbortController(); const path = join(f.root, "ready");
  const result = bot.callTool("cooperative", { marker: path }, { signal: controller.signal });
  await eventually(async () => readFile(path, "utf8").catch(() => ""), value => value === "ready");
  controller.abort(); assert.equal(((await result).content[0] as { text: string }).text, "aborted in child");
  assert.equal((await bot.info()).name, "tester");
});

test("close suspends accepted durable work instead of sending explicit cancellation", async t => {
  const f = await fixture({ tools: [] }); t.after(f.cleanup);
  const options = { agentDir: f.agentDir };
  let bot = await openBotProcess(f.source, options, { ...quiet, workerUrl: fauxWorker }); t.after(() => bot.close());
  const accepted = await bot.submit("durable accepted turn", { requestId: "durable" });
  await bot.close();
  bot = await openBotProcess(f.source, options, { ...quiet, workerUrl: fauxWorker });
  const restored = await eventually(() => bot.getRun(accepted.runId), value => ["completed", "failed"].includes(value.status));
  assert.notEqual(restored.status, "cancelled");
  assert.equal((await bot.submit("durable accepted turn", { requestId: "durable" })).runId, accepted.runId);
});

test("control calls retain capacity when the data/subscription limit is reached", async t => {
  const f = await fixture({ tools: [] }); t.after(f.cleanup);
  const bot = await openBotProcess(f.source, { agentDir: f.agentDir }, { ...quiet, maxPendingRequests: 1, workerUrl: fauxWorker }); t.after(() => bot.close());
  const run = await bot.run("create session"); const stop = await bot.watch(run.sessionId, () => {});
  await assert.rejects(bot.info(), /Too many/); await stop();
  assert.equal((await bot.info()).name, "tester");
});

test("provided Models is the explicit in-process exception and still supports scripted runs", async t => {
  const f = await fixture({ tools: ["echo"] }, { "tools/echo.ts": echo }); t.after(f.cleanup);
  const { models } = scripted([]);
  const bot = await openBotProcess(f.source, { models, agentDir: f.agentDir, cwd: f.cwd }, { workerUrl: new URL("file:///does-not-exist") }); t.after(() => bot.close());
  const detail = JSON.parse(((await bot.callTool("echo", { n: 1 })).content[0] as { text: string }).text);
  assert.equal(detail.pid, process.pid);
});

test("late initialization timeout closes the eventual runtime and releases its source flock", async t => {
  const f = await fixture({ model: "openai/gpt-4o", tools: [] }); t.after(f.cleanup);
  await assert.rejects(openBotProcess(f.source, { agentDir: f.agentDir }, { ...quiet, initTimeoutMs: 10, closeTimeoutMs: 5_000 }), /initialization timed out/);
  // The close request arrives during imports/opening; it must wait for and release the late handle.
  assert.notEqual(JSON.parse(await readFile(join(f.source, ".sdk-source.lock"), "utf8")).pid, process.pid);
  const bot = await openBotProcess(f.source, { agentDir: f.agentDir }, quiet); t.after(() => bot.close());
  assert.equal((await bot.info()).name, "tester");
});

for (const mode of ["async", "cpu"]) test(`noncooperative ${mode} direct tool: bounded close kills the process group and frees flock`, { skip: process.platform !== "linux" }, async t => {
  const f = await fixture({ model: "openai/gpt-4o", tools: ["block"] }, { "tools/block.ts": block }); t.after(f.cleanup);
  const bot = await openBotProcess(f.source, { agentDir: f.agentDir }, { ...quiet, closeTimeoutMs: 200, killTimeoutMs: 100 }); t.after(() => bot.close());
  const path = join(f.root, "pids.json"); const pending = bot.callTool("block", { marker: path, mode });
  const rejected = assert.rejects(pending, isUnavailable);
  const pids = await marker(path); const start = Date.now();
  await bot.close(); await rejected; assert.ok(Date.now() - start < 2_000);
  await eventually(async () => await live(pids.worker) || await live(pids.descendant), value => !value);
  const reopened = await openBotProcess(f.source, { agentDir: f.agentDir }, quiet); await reopened.close();
});

test("explicit direct-tool abort is forwarded, and an uncooperative call is forcibly contained", { skip: process.platform !== "linux" }, async t => {
  const f = await fixture({ model: "openai/gpt-4o", tools: ["block"] }, { "tools/block.ts": block }); t.after(f.cleanup);
  const bot = await openBotProcess(f.source, { agentDir: f.agentDir }, { ...quiet, cancellationTimeoutMs: 100, closeTimeoutMs: 100, killTimeoutMs: 100 }); t.after(() => bot.close());
  const controller = new AbortController(); const path = join(f.root, "pids.json");
  const pending = bot.callTool("block", { marker: path, mode: "cpu" }, { signal: controller.signal }); const rejected = assert.rejects(pending, isUnavailable);
  const pids = await marker(path); controller.abort(); await rejected; await bot.close();
  await eventually(async () => live(pids.descendant), value => !value);
});

test("explicit cancel replies clear their deadline, including completed/idempotent and rejected cancels", async t => {
  const f = await fixture({ tools: [] }); t.after(f.cleanup);
  const bot = await openBotProcess(f.source, { agentDir: f.agentDir }, { ...quiet, workerUrl: fauxWorker, cancellationTimeoutMs: 400 }); t.after(() => bot.close());
  const completed = await bot.run("complete before cancellation");
  await bot.cancel(completed.runId); await bot.cancel(completed.runId);
  await assert.rejects(bot.cancel("drun:99999"), error => (error as { code?: string }).code === "NOT_FOUND");
  const accepted = await bot.submit("explicitly cancelled");
  await bot.cancel(accepted.runId); await bot.cancel(accepted.runId);
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal((await bot.getRun(completed.runId)).status, "completed");
  assert.equal((await bot.getRun(accepted.runId)).status, "cancelled");
  assert.equal((await bot.info()).name, "tester", "successful/error replies must clear cancel timers, not close a healthy worker later");
});

for (const http of [false, true]) test(`${http ? "HTTP" : "direct"} explicit cancel of a CPU-blocked run fails boundedly without claiming durable cancellation`, { skip: process.platform !== "linux" }, async t => {
  const runBlock = block.replace("execute:async(args)=>", "execute:async(args,ctx)=>")
    .replace("await writeFile(args.marker,", "await writeFile(ctx.stateDir+'/blocked-pids.json',");
  const f = await fixture({ tools: ["block"] }, { "tools/block.ts": runBlock }); t.after(f.cleanup);
  const bot = await openBotProcess(f.source, { agentDir: f.agentDir }, {
    ...quiet, workerUrl: new URL("./fixtures/worker-blocked-run.mjs", import.meta.url), cancellationTimeoutMs: 100, closeTimeoutMs: 100, killTimeoutMs: 100,
  }); t.after(() => bot.close());
  const server = http ? await serve("ignored", { bot, port: 0 }) : undefined;
  if (server) t.after(() => server.close());
  let runId: string;
  if (server) {
    const response = await fetch(`${server.url}/v1/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "block in durable tool" }) });
    assert.equal(response.status, 202); runId = (await response.json()).runId;
  } else runId = (await bot.submit("block in durable tool")).runId;
  const pids = await marker(join(bot.stateDir, "blocked-pids.json"));
  t.after(() => { for (const pid of [-pids.worker, pids.descendant]) { try { process.kill(pid, "SIGKILL"); } catch {} } });
  const start = Date.now();
  if (server) {
    const response = await fetch(`${server.url}/v1/runs/${encodeURIComponent(runId)}/cancel`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(2_000),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: { code: "UNAVAILABLE", message: "Cancellation was not durably confirmed; work may be suspended. Inspect the run before retrying." } });
  } else {
    await assert.rejects(bot.cancel(runId), error => {
      assert.ok(isUnavailable(error));
      assert.match((error as Error).message, /Cancellation was not durably confirmed/);
      assert.match((error as Error).message, /stopping the worker to suspend work/);
      assert.doesNotMatch((error as Error).message, /was cancelled|is cancelled|has been cancelled/i);
      return true;
    });
  }
  assert.ok(Date.now() - start < 2_000, "explicit cancellation must not wait forever for a blocked IPC dispatcher");
  await bot.close();
  await eventually(async () => await live(pids.worker) || await live(pids.descendant), value => !value);
  const releaseSource = await acquireLock(join(f.source, ".sdk-source.lock"));
  try { const releaseState = await acquireLock(join(bot.stateDir, ".sdk-state.lock")); await releaseState(); }
  finally { await releaseSource(); }
});

test("unexpected worker exit rejects pending calls and notifies watch subscribers", async t => {
  const crash = `export default {name:'crash',description:'exit',parameters:{type:'object'},execute:async()=>{process.exit(23)}};`;
  const f = await fixture({ tools: ["crash"] }, { "tools/crash.ts": crash }); t.after(f.cleanup);
  const bot = await openBotProcess(f.source, { agentDir: f.agentDir }, { ...quiet, workerUrl: fauxWorker }); t.after(() => bot.close());
  const run = await bot.run("create session"); const events: BotEvent[] = [];
  const stop = await bot.watch(run.sessionId, event => events.push(event));
  await assert.rejects(bot.callTool("crash", {}), isUnavailable);
  assert.ok(events.some(event => event.type === "error")); await stop(); await bot.close();
  await assert.rejects(bot.listSessions(), isUnavailable);
});

test("parent SIGKILL during a CPU-bound tool cannot orphan the worker or its descendants", { skip: process.platform !== "linux" }, async t => {
  const f = await fixture({ model: "openai/gpt-4o", tools: ["block"] }, { "tools/block.ts": block }); t.after(f.cleanup);
  const path = join(f.root, "pids.json");
  const script = `import {openBotProcess} from ${JSON.stringify(new URL("../dist/worker-client.js", import.meta.url).href)};
    const bot=await openBotProcess(${JSON.stringify(f.source)},{agentDir:${JSON.stringify(f.agentDir)}},{initTimeoutMs:15000});
    await bot.callTool('block',{marker:${JSON.stringify(path)},mode:'cpu'});`;
  const supervisor = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" });
  t.after(() => { if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill("SIGKILL"); });
  const pids = await marker(path);
  t.after(() => { for (const pid of [-pids.worker, pids.descendant]) { try { process.kill(pid, "SIGKILL"); } catch {} } });
  const exited = new Promise(resolve => supervisor.once("exit", resolve)); supervisor.kill("SIGKILL"); await exited;
  await eventually(async () => await live(pids.worker) || await live(pids.descendant), value => !value);
  const reopened = await openBotProcess(f.source, { agentDir: f.agentDir }, quiet); await reopened.close();
});

test("compiled CLI serve uses a worker by default and SIGTERM contains a CPU tool and detached descendant", { skip: process.platform !== "linux" }, async t => {
  const f = await fixture({ model: "openai/gpt-4o", tools: ["echo", "block"] }, { "tools/echo.ts": echo, "tools/block.ts": block }); t.after(f.cleanup);
  const supervisor = spawn(process.execPath, [new URL("../bin/bot.mjs", import.meta.url).pathname, "serve", f.source, "--port", "0"], {
    env: { ...process.env, PI_CODING_AGENT_DIR: f.agentDir }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = ""; let stdout = "";
  supervisor.stderr.on("data", chunk => stderr += chunk); supervisor.stdout.on("data", chunk => stdout += chunk);
  t.after(() => { if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill("SIGKILL"); });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    supervisor.once("error", reject); supervisor.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const url = await eventually(async () => /Listening on (http:\/\/\S+)/.exec(stderr)?.[1], value => value !== undefined, 15_000);
  assert.match(stderr, /unauthenticated/);
  const echoed = await (await fetch(`${url}/v1/tools/echo`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: { n: 4 } }) })).json();
  const detail = JSON.parse(echoed.content[0].text); assert.notEqual(detail.pid, supervisor.pid);
  const path = join(f.root, "pids.json");
  const blocked = fetch(`${url}/v1/tools/block`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: { marker: path, mode: "cpu" } }) }).catch(() => undefined);
  const pids = await marker(path);
  t.after(() => { for (const pid of [-pids.worker, pids.descendant]) { try { process.kill(pid, "SIGKILL"); } catch {} } });
  supervisor.kill("SIGTERM"); assert.deepEqual(await exited, { code: 0, signal: null }); await blocked;
  await eventually(async () => await live(pids.worker) || await live(pids.descendant), value => !value);
  assert.equal(stdout, "");
});

test("malformed replies and unavailable worker modules reject without crashing the host", async () => {
  await assert.rejects(openBotProcess("unused", {}, {
    ...quiet, workerUrl: new URL("./fixtures/worker-invalid.mjs", import.meta.url), closeTimeoutMs: 50, killTimeoutMs: 50,
  }), isUnavailable);
  await assert.rejects(openBotProcess("unused", {}, {
    ...quiet, workerUrl: new URL("./fixtures/does-not-exist.mjs", import.meta.url), closeTimeoutMs: 50, killTimeoutMs: 50,
  }), isUnavailable);
});

test("diagnostics use a bounded stderr sink and IPC requests are bounded", async t => {
  const noisy = `export default {name:'noisy',description:'diagnostics',parameters:{type:'object'},execute:async()=>{console.log('x'.repeat(10000));console.error('y'.repeat(10000));return {content:[{type:'text',text:'ok'}]}}};`;
  const f = await fixture({ model: "openai/gpt-4o", tools: ["noisy"] }, { "tools/noisy.ts": noisy }); t.after(f.cleanup);
  let diagnostics = "";
  const bot = await openBotProcess(f.source, { agentDir: f.agentDir }, { ...quiet, maxDiagnosticsBytes: 32, maxMessageBytes: 2048, diagnostics: { write(chunk: string | Uint8Array) { diagnostics += chunk.toString(); return true; } } }); t.after(() => bot.close());
  assert.equal(((await bot.callTool("noisy", {})).content[0] as { text: string }).text, "ok");
  assert.ok(diagnostics.length < 100); assert.ok(!diagnostics.includes(f.agentDir));
  await assert.rejects(bot.callTool("noisy", "x".repeat(3000)), error => (error as { code?: string }).code === "INVALID_INPUT");
  assert.equal((await bot.info()).name, "tester");
});
