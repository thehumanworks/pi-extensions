import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { registerPiBot } from "@nothumanwork/bot/pi";
import { initBot, openBot, type BotHandle, type BotRunRecord } from "@nothumanwork/bot";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage as answer } from "@earendil-works/pi-ai/providers/faux";
import { DefaultResourceLoader, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";

const pause = () => new Promise(resolve => setTimeout(resolve, 20));
async function until(predicate: () => boolean) {
  const end = Date.now() + 10_000;
  while (!predicate()) { if (Date.now() > end) throw new Error("Timed out"); await pause(); }
}
function harness(root: string, open: (source: string, options: any) => Promise<BotHandle>, flag?: string) {
  const tools: Record<string, any> = {}, commands: Record<string, any> = {}, events: Record<string, any> = {};
  const notices: string[] = [], messages: any[] = [], branch: any[] = [], statuses: any[] = [], widgets: Array<{ key: string; lines?: string[] }> = [];
  const pi = {
    registerFlag() {}, getFlag: () => flag,
    registerTool: (tool: any) => { tools[tool.name] = tool; },
    registerCommand: (name: string, command: any) => { commands[name] = command; },
    on: (name: string, handler: any) => { events[name] = handler; },
    appendEntry: (customType: string, data: unknown) => { branch.push({ type: "custom", customType, data }); },
    sendMessage: (message: any, options: unknown) => { messages.push({ ...message, options }); },
  };
  const ctx = { cwd: root, hasUI: true, sessionManager: { getBranch: () => branch }, ui: {
    notify: (message: string) => { notices.push(message); }, setStatus: (...args: unknown[]) => statuses.push(args), setWidget: (key: string, lines?: string[]) => { widgets.push({ key, lines }); },
    select: async (_title: string, choices: string[]) => choices[0], confirm: async () => true,
    input: async () => undefined, editor: async () => undefined,
  } };
  registerPiBot(pi as unknown as ExtensionAPI, { root: () => root, openBot: open });
  events.session_start({}, ctx);
  return { tools, commands, events, ctx, notices, messages, branch, statuses, widgets };
}
async function setup(t: TestContext, responses = [answer("SDK reply"), answer("Continued")], tokensPerSecond = 100000) {
  const root = await mkdtemp(join(tmpdir(), "pi-bot-ui-")); t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "reviewer"), agentDir = join(root, "user");
  await initBot(source, { name: "reviewer", model: "faux/faux-1" });
  const faux = fauxProvider({ tokensPerSecond }); const models = createModels(); models.setProvider(faux.provider); faux.setResponses(responses);
  let opens = 0;
  const f = harness(root, async (source, options) => { opens++; return openBot(source, { ...options, models, agentDir }); });
  t.after(() => f.events.session_shutdown());
  return { ...f, root, source, faux, opens: () => opens };
}

test("the extension entry point only registers the SDK adapter and rendering", () => {
  const calls: string[] = [];
  extension({ registerTool: (tool: any) => calls.push(tool.name), registerCommand: (name: string) => calls.push(name),
    on() {}, registerFlag() {}, registerToolRenderer: () => calls.push("tool renderer"), registerMessageRenderer: () => calls.push("message renderer"),
  } as unknown as ExtensionAPI);
  assert.deepEqual(calls, ["bot_manage", "bot_run", "bot", "tool renderer", "message renderer"]);
});

test("the actual Pi resource loader loads the thin extension and SDK dependency", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-bot-load-")); t.after(() => rm(root, { recursive: true, force: true }));
  const resources = new DefaultResourceLoader({ cwd: root, agentDir: join(root, "user"), settingsManager: SettingsManager.inMemory({}),
    additionalExtensionPaths: [fileURLToPath(new URL("../index.ts", import.meta.url))], noSkills: true, noPromptTemplates: true, noThemes: true });
  await resources.reload(); const loaded = resources.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const bot = loaded.extensions.find(item => item.tools.has("bot_run"));
  assert(bot); assert(bot.flags.has("bot")); assert(bot.commands.has("bot"));
});

test("bot_run uses SDK-owned durable conversations, resumes and reports usage without pi spawning", async t => {
  const f = await setup(t);
  const result = await f.tools.bot_run.execute("id", { bot: "reviewer", task: "Review" }, undefined, undefined, f.ctx);
  const record = result.details as BotRunRecord;
  assert.equal(record.status, "completed"); assert.equal(record.output, "SDK reply"); assert.match(record.sessionId, /^dconv:/);
  assert(result.usage.totalTokens > 0); assert.equal(f.opens(), 1);
  const continued = await f.tools.bot_run.execute("id2", { bot: f.source, task: "Continue", session: record.sessionId }, undefined, undefined, f.ctx);
  assert.equal(continued.details.output, "Continued"); assert.equal(continued.details.sessionId, record.sessionId); assert.equal(f.opens(), 1);
  await assert.rejects(f.tools.bot_run.execute("bad", { bot: "http://localhost:1234", task: "x", cwd: "/etc" }, undefined, undefined, f.ctx), /server's workspace/);
});

test("bot_run partial updates show the reply text as it is generated", async t => {
  const f = await setup(t, [answer("Streamed SDK reply")]);
  const updates: any[] = [];
  const result = await f.tools.bot_run.execute("id", { bot: "reviewer", task: "Review" }, undefined, (update: any) => updates.push(update), f.ctx);
  assert.equal(result.details.output, "Streamed SDK reply");
  assert.equal(updates[0].content[0].text, "reviewer: working…");
  const partial = updates.filter(update => update.details.output);
  assert(partial.length > 0, "the preview is rebuilt from run events");
  assert.equal(partial.at(-1).details.output, "Streamed SDK reply"); assert.equal(partial.at(-1).content[0].text, "Streamed SDK reply");
});

test("direct chat shows the streaming reply in the progress widget, then clears it", async t => {
  const reply = "Live widget reply streamed while the bot is still answering.";
  const f = await setup(t, [answer(reply)], 100);
  await f.commands.bot.handler("reviewer", f.ctx);
  f.events.input({ text: "first" }, f.ctx);
  await until(() => f.messages.some(m => m.customType === "bot-reply"));
  const progress = f.widgets.filter(widget => widget.key === "pi-bot-progress");
  const shown = progress.filter(widget => widget.lines).map(widget => widget.lines!.slice(1).join("\n"));
  assert.match(progress.find(widget => widget.lines)!.lines![0], /^reviewer · drun:/);
  assert(shown.some(text => text && reply.startsWith(text) && text !== reply), `a partial reply was shown: ${JSON.stringify(shown)}`);
  assert.equal(shown.at(-1), reply);
  await until(() => f.widgets.at(-1)?.key === "pi-bot-progress" && f.widgets.at(-1)?.lines === undefined);
});

test("direct chat handles input without running a second Pi model loop and queues followups in one durable session", async t => {
  const f = await setup(t);
  await f.commands.bot.handler("reviewer", f.ctx);
  assert.deepEqual(f.events.input({ text: "first" }, f.ctx), { action: "handled" });
  assert.deepEqual(f.events.input({ text: "second" }, f.ctx), { action: "handled" });
  await until(() => f.messages.filter(m => m.customType === "bot-reply").length === 2);
  const replies = f.messages.filter(m => m.customType === "bot-reply");
  assert.equal(replies[0].details.sessionId, replies[1].details.sessionId);
  assert.equal(replies[0].content, "SDK reply"); assert.equal(replies[1].content, "Continued");
  assert(f.messages.every(m => m.options.triggerTurn === false));
  assert.equal(f.messages.filter(m => m.customType === "bot-input").length, 2);
  await f.commands.bot.handler("exit", f.ctx);
  assert.equal(f.events.input({ text: "ordinary Pi" }, f.ctx), undefined);
  assert.equal(f.branch.at(-1).data.selected, false);
});

test("bot selection survives Pi reload as a reference, never copying native Pi history", async t => {
  const f = await setup(t);
  await f.commands.bot.handler("reviewer", f.ctx);
  f.events.input({ text: "first" }, f.ctx);
  await until(() => f.messages.some(m => m.customType === "bot-reply"));
  const first = f.messages.find(m => m.customType === "bot-reply").details.sessionId;
  await f.events.session_shutdown();
  f.events.session_start({}, f.ctx);
  f.events.input({ text: "second" }, f.ctx);
  await until(() => f.messages.filter(m => m.customType === "bot-reply").length === 2);
  assert.equal(f.messages.filter(m => m.customType === "bot-reply")[1].details.sessionId, first);
  assert.equal(f.opens(), 2);
});

test("manage uses new-format SDK definitions; [] disables tools and null restores discovery", async t => {
  const f = await setup(t);
  const call = (params: unknown) => f.tools.bot_manage.execute("id", params, undefined, undefined, f.ctx);
  await call({ action: "create", name: "scout", description: "Explore", prompt: "Be direct.", model: "faux/faux-1" });
  await call({ action: "edit", name: "scout", tools: [], edits: [{ oldText: "Be direct.", newText: "Be direct. Cite files." }] });
  const info = await call({ action: "show", name: "scout" }); assert.deepEqual(info.details.tools, []);
  await call({ action: "edit", name: "scout", tools: null });
  assert((await call({ action: "show", name: "scout" })).details.tools.some((tool: any) => tool.name === "bot_write"));
  assert.match(await readFile(join(f.root, "scout", "BOT.md"), "utf8"), /Cite files/);
  await f.commands.bot.handler("delete scout", f.ctx);
  assert(f.notices.some(message => message.includes("Archived to")));
  const actions = f.tools.bot_manage.parameters.properties.action.anyOf.map((value: any) => value.const);
  assert(!actions.includes("delete"));
});

test("interactive exit releases idle ownership so archive works", async t => {
  const f = await setup(t);
  await f.commands.bot.handler("reviewer", f.ctx);
  await f.commands.bot.handler("delete reviewer", f.ctx); assert(f.notices.some(n => n.includes("Exit this bot")));
  await f.commands.bot.handler("exit", f.ctx);
  await f.commands.bot.handler("delete reviewer", f.ctx); assert(f.notices.some(n => n.includes("Archived to")));
});

test("invalid --bot never falls back to an ordinary Pi model request", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-bot-flag-")); t.after(() => rm(root, { recursive: true, force: true }));
  const f = harness(root, async () => { throw new Error("should not open"); }, "missing");
  await until(() => f.notices.length > 0);
  assert.deepEqual(f.events.input({ text: "request" }, f.ctx), { action: "handled" });
  await f.commands.bot.handler("exit", f.ctx);
  assert.equal(f.events.input({ text: "ordinary Pi" }, f.ctx), undefined);
  await f.events.session_shutdown();
});

test("cancellation flows to the SDK and headless direct mode is explicit", async t => {
  const f = await setup(t, [answer("waiting")]);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.tools.bot_run.execute("id", { bot: "reviewer", task: "x" }, controller.signal, undefined, f.ctx));
  assert.equal(f.faux.state.callCount, 0);
  await f.commands.bot.handler("reviewer", f.ctx);
  assert.deepEqual(f.events.input({ text: "no UI" }, { ...f.ctx, hasUI: false }), { action: "handled" });
});
