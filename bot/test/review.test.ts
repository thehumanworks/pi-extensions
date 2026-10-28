import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, symlink, link, stat } from "node:fs/promises";
import { join } from "node:path";
import { Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { fauxAssistantMessage as answer, fauxToolCall as call } from "@earendil-works/pi-ai/providers/faux";
import { openBot } from "../src/runtime.js";
import { loadProject } from "../src/project.js";
import { acquireLock } from "../src/lock.js";
import { SNAPSHOT_POLICY } from "../src/snapshot.js";
import { fixture, scripted, echoTool, eventually } from "./helpers.js";

const code = (expected: string) => (error: unknown) => (error as { code: string }).code === expected;
function deferred<T = void>() { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

test("stored active revision wins over a stale active.json, including local imports and skills", async t => {
  const f = await fixture({ tools: ["echo"], skills: ["local"] }, {
    "tools/echo.ts": `import {version} from '../lib/version.ts';\n${echoTool().replace('"v1"', 'version')}`,
    "lib/version.ts": "import data from './models.json'; export const version=data.version;",
    "lib/models.json": JSON.stringify({ version: "first" }),
    "skills/local/SKILL.md": "---\nname: local\ndescription: Persistent local skill\n---\nSkill content.\n",
    "skills/local/asset.txt": "asset content",
  }); t.after(f.cleanup);
  const { models } = scripted([]);
  let bot = await openBot(f.source, { models, agentDir: f.agentDir }); t.after(() => bot.close());
  const old = (await bot.info()).revision;
  await writeFile(join(f.source, "lib/models.json"), JSON.stringify({ version: "second" }));
  assert((await bot.reload()).changed); const current = (await bot.info()).revision; assert.notEqual(current, old);
  await writeFile(join(bot.stateDir, "revisions/active.json"), JSON.stringify({ revision: old }));
  await writeFile(join(f.source, "tools/echo.ts"), "export default { broken"); await bot.close();
  bot = await openBot(f.source, { models, agentDir: f.agentDir });
  assert.equal((await bot.info()).revision, current); assert.match(JSON.stringify(await bot.callTool("echo", { n: 1 })), /second:1/);
  assert.equal(await readFile(join(bot.stateDir, "revisions", current, "source/skills/local/asset.txt"), "utf8"), "asset content");
});

test("unknown model draft falls back, but an explicit invalid model override fails", async t => {
  const f = await fixture({ tools: ["echo"] }, { "tools/echo.ts": echoTool("good") }); t.after(f.cleanup);
  const { models, faux } = scripted([]);
  let bot = await openBot(f.source, { models, agentDir: f.agentDir }); const revision = (await bot.info()).revision; await bot.close();
  await writeFile(join(f.source, "BOT.md"), (await readFile(join(f.source, "BOT.md"), "utf8")).replace("faux/faux-1", "unknown/model"));
  bot = await openBot(f.source, { models, agentDir: f.agentDir }); t.after(() => bot.close());
  assert.equal((await bot.info()).revision, revision); assert.match((await bot.info()).diagnostics.join("\n"), /last known good/);
  assert.match(JSON.stringify(await bot.callTool("echo", { n: 1 })), /good:1/); await bot.close();
  await assert.rejects(openBot(f.source, { models, agentDir: f.agentDir, model: "unknown/override" }), code("INVALID_INPUT"));
  assert.equal(faux.state.callCount, 0);
  await writeFile(join(f.source, "BOT.md"), "invalid persona draft");
  bot = await openBot(f.source, { models, agentDir: f.agentDir, model: "faux/faux-1" });
  assert.equal((await bot.info()).revision, revision); await bot.close();
});

test("checkpoint tampering cannot silently replace restored tool code", async t => {
  const f = await fixture({ tools: ["echo"] }, { "tools/echo.ts": echoTool("trusted") }); t.after(f.cleanup);
  const { models, faux } = scripted([]); const bot = await openBot(f.source, { models, agentDir: f.agentDir });
  const revision = (await bot.info()).revision; await bot.close();
  await writeFile(join(bot.stateDir, "revisions", revision, "source/tools/echo.ts"), echoTool("tampered"));
  await writeFile(join(f.source, "tools/echo.ts"), "export default { broken");
  await assert.rejects(openBot(f.source, { models, agentDir: f.agentDir }), code("UNAVAILABLE")); assert.equal(faux.state.callCount, 0);
});

test("pending safe tool restores imported implementation before inspecting an invalid model draft", async t => {
  const tool = `import {defineTool,Type} from '@nothumanwork/bot';import {readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';import {version} from '../lib/version.ts';
export default defineTool({name:'pending',description:'pending',parameters:Type.Object({}),replay:'safe',execute:async(_,ctx)=>{const path=join(ctx.cwd,'started');if(await readFile(path,'utf8').catch(()=>''))return version;await writeFile(path,'yes');await new Promise((_,reject)=>ctx.signal.addEventListener('abort',()=>reject(ctx.signal.reason),{once:true}));return version;}});`;
  const f = await fixture({ tools: ["pending"] }, { "tools/pending.ts": tool, "lib/version.ts": "export const version='pinned-import';" }); t.after(f.cleanup);
  const first = scripted([answer(call("pending", {}), { stopReason: "toolUse" })]);
  let bot = await openBot(f.source, { models: first.models, agentDir: f.agentDir, cwd: f.cwd }); t.after(() => bot.close());
  const run = await bot.submit("work"); await eventually(() => readFile(join(f.cwd, "started"), "utf8").catch(() => ""), value => value === "yes"); await bot.close();
  await writeFile(join(f.source, "BOT.md"), (await readFile(join(f.source, "BOT.md"), "utf8")).replace("faux/faux-1", "unknown/model"));
  await writeFile(join(f.source, "lib/version.ts"), "export const version='WRONG';");
  const next = scripted([ctx => { assert.match(JSON.stringify(ctx.messages), /pinned-import/); return answer("recovered"); }]);
  bot = await openBot(f.source, { models: next.models, agentDir: f.agentDir });
  const result = await eventually(() => bot.getRun(run.runId), value => ["completed", "failed"].includes(value.status));
  assert.equal(result.status, "completed", result.error); assert.equal(result.output, "recovered");
});

test("global defaultTools changes affect fingerprint and activate on reload", async t => {
  const f = await fixture({ inherit: "global" }); t.after(f.cleanup);
  await writeFile(join(f.agentDir, "settings.json"), JSON.stringify({ defaultTools: ["read"] }));
  const { models } = scripted([]); const bot = await openBot(f.source, { models, agentDir: f.agentDir }); t.after(() => bot.close());
  const old = (await bot.info()).revision; assert.deepEqual((await bot.info()).tools.map(t => t.name), ["read", "bot_history"]);
  await writeFile(join(f.agentDir, "settings.json"), JSON.stringify({ defaultTools: ["read", "bash"] }));
  assert((await bot.reload()).changed); assert.notEqual((await bot.info()).revision, old); assert.deepEqual((await bot.info()).tools.map(t => t.name), ["read", "bash", "bot_history"]);
});

test("invalid settings/model catalog values fail quickly without provider calls or leaked locks", async t => {
  const f = await fixture({ tools: [] }); t.after(f.cleanup); const { models, faux } = scripted([]);
  for (const config of [null, [], { defaultModel: {} }, { defaultTools: false }, { retry: { maxRetries: 1000000000 } }, { compaction: { reserveTokens: -1 } }]) {
    await writeFile(join(f.agentDir, "settings.json"), JSON.stringify(config));
    await assert.rejects(openBot(f.source, { models, agentDir: f.agentDir }), code("INVALID_INPUT"));
  }
  await writeFile(join(f.agentDir, "settings.json"), "{}");
  await assert.rejects(openBot(f.source, { models, agentDir: f.agentDir, model: 12 as unknown as string }), code("INVALID_INPUT"));
  const original = models.getModel.bind(models); models.getModel = (...args) => { const model = original(...args); return model && { ...model, contextWindow: 0 }; };
  await assert.rejects(openBot(f.source, { models, agentDir: f.agentDir }), code("INVALID_INPUT")); models.getModel = original;
  const bot = await openBot(f.source, { models, agentDir: f.agentDir }); await bot.close(); assert.equal(faux.state.callCount, 0);
});

test("pre-admission and during-validation signal aborts admit no sessions", async t => {
  const f = await fixture({ tools: [] }); t.after(f.cleanup); const { models, faux } = scripted([]);
  const bot = await openBot(f.source, { models, agentDir: f.agentDir }); t.after(() => bot.close());
  const first = new AbortController(); first.abort(); await assert.rejects(bot.submit("aborted", { signal: first.signal }));
  const controller = new AbortController(); const original = models.getModel.bind(models);
  models.getModel = (...args) => { controller.abort(); return original(...args); };
  await assert.rejects(bot.submit("aborted while validating", { signal: controller.signal })); models.getModel = original;
  assert.deepEqual(await bot.listSessions(), []); assert.equal(faux.state.callCount, 0);
});

test("signal abort immediately after storage commit cancels the admitted durable run", async t => {
  const f = await fixture({ tools: [] }); t.after(f.cleanup); const { models } = scripted([answer("slow response")], 10);
  const bot = await openBot(f.source, { models, agentDir: f.agentDir }); t.after(() => bot.close());
  const controller = new AbortController(); const original = SqliteStorage.prototype.commit; let aborted = false;
  SqliteStorage.prototype.commit = async function(writes, context) {
    const seq = await original.call(this, writes, context);
    if (!aborted && writes.some(write => write.type === "task" && write.value.kind === "bot.dispatch")) { aborted = true; controller.abort(); }
    return seq;
  };
  t.after(() => { SqliteStorage.prototype.commit = original; });
  const record = await bot.submit("post-commit abort", { signal: controller.signal }); assert(aborted);
  assert.equal((await eventually(() => bot.getRun(record.runId), value => value.status === "cancelled")).status, "cancelled");
});

test("close drains getRun readers and stale task snapshots never overwrite successful records", async t => {
  const f = await fixture({ tools: [] }); t.after(f.cleanup); const { models } = scripted([answer("A streaming answer that finishes after the read begins")], 200);
  const open = Harness.open; let harness!: Awaited<ReturnType<typeof Harness.open>>;
  Harness.open = async (...args) => { harness = await open(...args); return harness; };
  t.after(() => { Harness.open = open; });
  const bot = await openBot(f.source, { models, agentDir: f.agentDir }); t.after(() => bot.close());
  const accepted = await bot.submit("stream"); await eventually(() => bot.getRun(accepted.runId), value => value.status === "running");
  const started = deferred(); const released = deferred(); const original = harness.getTask.bind(harness); let once = true;
  harness.getTask = async (...args) => { if (once) { once = false; started.resolve(); await released.promise; } return original(...args); };
  t.after(() => { harness.getTask = original; released.resolve(); });
  const read = bot.getRun(accepted.runId); await started.promise;
  const complete = await eventually(() => bot.getRun(accepted.runId), value => value.status === "completed");
  let closed = false; const closing = bot.close().then(() => { closed = true; });
  await new Promise(r => setTimeout(r, 20)); assert.equal(closed, false); released.resolve();
  assert.equal((await read).status, "completed"); await closing;
  const reopened = await openBot(f.source, { models, agentDir: f.agentDir }); t.after(() => reopened.close());
  assert.equal((await reopened.getRun(accepted.runId)).output, complete.output);
});

test("close from an admission event does not deadlock run waiters or lose queued work", { timeout: 10000 }, async t => {
  const f = await fixture({ tools: [] }); t.after(f.cleanup);
  const slow = scripted([answer("a slow response that close interrupts")], 10);
  const bot = await openBot(f.source, { models: slow.models, agentDir: f.agentDir });
  let closing: Promise<void> | undefined; let runId: string | undefined;
  await assert.rejects(bot.run("close during admission", { onEvent: event => { if (!closing && event.type === "snapshot") { runId = event.runId; closing = bot.close(); } } }), code("UNAVAILABLE"));
  await closing; assert(runId);
  const next = scripted([answer("resumed after callback close")]);
  const reopened = await openBot(f.source, { models: next.models, agentDir: f.agentDir }); t.after(() => reopened.close());
  const record = await eventually(() => reopened.getRun(runId!), value => value.status === "completed"); assert.equal(record.output, "resumed after callback close");
});

test("queued continuation cancellation has zero usage, even after an expensive previous run", async t => {
  const f = await fixture({ tools: [] }); t.after(f.cleanup); const { models } = scripted([answer("first"), answer("blocking response that takes time")], 200);
  const bot = await openBot(f.source, { models, agentDir: f.agentDir }); t.after(() => bot.close());
  const first = await bot.run("first"); assert(first.usage.output > 0);
  const blocking = await bot.submit("blocking");
  const queued = await bot.submit("never execute", { session: first.sessionId }); await bot.cancel(queued.runId);
  const cancelled = await bot.getRun(queued.runId); assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(cancelled.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }); assert.equal(cancelled.toolCalls, 0);
  await bot.cancel(blocking.runId);
});

test("failed provider responses retain error/output/usage and event callback failures do not fail runs", async t => {
  const f = await fixture({ tools: [] }); t.after(f.cleanup);
  const { models } = scripted([answer("partial answer", { stopReason: "error", errorMessage: "scripted provider failure" }), answer("callback survived")]);
  await writeFile(join(f.agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
  const bot = await openBot(f.source, { models, agentDir: f.agentDir }); t.after(() => bot.close());
  const failed = await bot.run("fail"); assert.equal(failed.status, "failed"); assert.match(failed.error ?? "", /scripted provider failure/);
  assert.match(failed.output, /partial answer/); assert(failed.usage.output > 0); assert.equal(failed.usage.turns, 1);
  const recovered = await bot.run("succeed", { onEvent: () => { throw new Error("broken observer"); } });
  assert.equal(recovered.status, "completed"); assert.equal(recovered.output, "callback survived"); assert.equal(recovered.error, undefined);
});

test("invalid result isError is rejected and mutation tools do not advertise safe replay", async t => {
  const invalid = `import {defineTool,Type} from '@nothumanwork/bot';export default defineTool({name:'invalid',description:'invalid',parameters:Type.Object({}),execute:async()=>({content:[{type:'text',text:'bad'}],isError:'false'})});`;
  const f = await fixture({ tools: ["invalid", "read", "write", "edit", "bash", "bot_read", "bot_write", "bot_edit", "bot_reload"] }, { "tools/invalid.ts": invalid }); t.after(f.cleanup);
  const project = await loadProject(f.source, { agentDir: f.agentDir });
  for (const name of ["write", "edit", "bash", "bot_write", "bot_edit", "bot_reload", "invalid"]) assert.notEqual(project.tools.find(t => t.name === name)!.replay, "safe", name);
  assert.equal(project.tools.find(t => t.name === "read")!.replay, "safe"); assert.equal(project.tools.find(t => t.name === "bot_read")!.replay, "safe");
  const { models } = scripted([]); const bot = await openBot(f.source, { models, agentDir: f.agentDir }); t.after(() => bot.close());
  await assert.rejects(bot.callTool("invalid", {}), /isError must be boolean/);
});

test("source aliases contend on the same lock; symlink and hardlink lock attacks do not truncate files", async t => {
  const f = await fixture({ tools: [] }); t.after(f.cleanup); const { models } = scripted([]);
  await symlink(f.source, join(f.root, "source-alias"), "dir");
  const bot = await openBot(f.source, { models, agentDir: f.agentDir });
  await assert.rejects(openBot(join(f.root, "source-alias"), { models, agentDir: f.agentDir }), code("CONFLICT")); await bot.close();
  const victim = join(f.root, "precious.txt"); await writeFile(victim, "DO NOT TRUNCATE");
  const symbolic = join(f.root, "symbolic.lock"); await symlink(victim, symbolic); await assert.rejects(acquireLock(symbolic), code("CONFLICT"));
  const hard = join(f.root, "hard.lock"); await link(victim, hard); await assert.rejects(acquireLock(hard), code("CONFLICT"));
  assert.equal(await readFile(victim, "utf8"), "DO NOT TRUNCATE");
});

test("bounded snapshots and ephemeral copies exclude secrets, binary junk and aliased state", async t => {
  const f = await fixture({ tools: ["echo"] }, { "tools/echo.ts": echoTool(), "lib/asset.bin": "asset", ".env.production": "FAKE_SECRET", ".envlocal": "FAKE_SECRET", "auth.json": "FAKE_SECRET", "credentials.yaml": "FAKE_SECRET" }); t.after(f.cleanup);
  const nestedState = join(f.source, "lib/instance-state"); await mkdir(nestedState); await writeFile(join(nestedState, "precious.txt"), "state survives");
  const stateAlias = join(f.root, "state-alias"); await symlink(nestedState, stateAlias, "dir");
  await writeFile(join(f.source, "junk.bin"), Buffer.alloc(SNAPSHOT_POLICY.maxFileBytes + 1));
  const project = await loadProject(f.source, { stateDir: stateAlias, agentDir: f.agentDir });
  assert.equal(project.info.stateDir, nestedState); assert(!Object.keys(project.files).some(path => /env|auth|credentials|instance-state|junk/.test(path)));
  assert.equal(Buffer.from(project.files["lib/asset.bin"]!, "base64").toString(), "asset");
  const { models } = scripted([]); const bot = await openBot(f.source, { models, agentDir: f.agentDir, stateDir: stateAlias, ephemeral: true });
  assert.equal(await readFile(join(bot.sourceDir, "lib/asset.bin"), "utf8"), "asset");
  await assert.rejects(stat(join(bot.sourceDir, ".env.production"))); await assert.rejects(stat(join(bot.sourceDir, "lib/instance-state"))); await bot.close();
  assert.equal(await readFile(join(nestedState, "precious.txt"), "utf8"), "state survives"); assert.equal(await readFile(join(f.source, ".env.production"), "utf8"), "FAKE_SECRET");
  await assert.rejects(openBot(f.source, { models, agentDir: f.agentDir, stateDir: join(f.root, "source-alias-parent", "..") }), code("INVALID_INPUT"));
  await writeFile(join(f.source, "lib/too-big.bin"), Buffer.alloc(SNAPSHOT_POLICY.maxFileBytes + 1));
  await assert.rejects(loadProject(f.source, { stateDir: stateAlias, agentDir: f.agentDir }), /2 MiB\/file/);
});
