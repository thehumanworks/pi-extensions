import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import memoryExtension from "../index.ts";
import { MemoryStore, evidenceHash, serializeMemory } from "../src/store.ts";
import { resolveProjectKey } from "../src/project.ts";
import { readConfig } from "../src/config.ts";
import { mergeSettings } from "../src/settings.ts";
import { readFile } from "node:fs/promises";
import { expandReferences } from "../src/ui.ts";
import { autocomplete } from "../src/ui.ts";
import { ProposalManager } from "../src/maintenance.ts";
import { CapturePipeline } from "../src/capture.ts";

interface HarnessOptions { capture?: Record<string, unknown>; memory?: Record<string, unknown>; cwd?: string; context?: Record<string, unknown>; sessionManager?: unknown }

/** The extension with a fake Pi. `cwd` reuses another harness's directory, as a restarted process would. */
async function harness(t: TestContext, mode = "inject", enabled = true, captureEnabled = false, options: HarnessOptions = {}) {
  const cwd = options.cwd ?? await mkdtemp(join(tmpdir(), "pi-memory-extension-")), root = join(cwd, "memory");
  const events = new Map<string, Function>(), tools = new Map<string, any>(), commands = new Map<string, any>();
  let entries: any[] = [];
  const notifications: string[] = [];
  const pi = {
    on: (event: string, handler: Function) => { events.set(event, handler); return () => events.delete(event); },
    registerFlag: () => {}, getFlag: () => undefined,
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    // Capture jobs retry after 10 ms here rather than 30 s.
    getSettings: () => ({ memory: { enabled, dir: root, mode, capture: { enabled: captureEnabled, ...(captureEnabled ? { model: "test/test", retryDelayMs: 10 } : {}), ...options.capture }, ...options.memory } }),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command), registerMessageRenderer: () => {},
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd, mode: "json", hasUI: true, isIdle: () => true, hasPendingMessages: () => false, isProjectTrusted: () => true,
    ui: { notify: (message: string) => notifications.push(message) },
    sessionManager: options.sessionManager ?? { getBranch: () => entries, getSessionId: () => "test-session", getSessionFile: () => undefined, getLeafId: () => entries.at(-1)?.id },
    ...options.context,
  } as unknown as ExtensionContext;
  const previousTrace = process.env.PI_MEMORY_TRACE;
  process.env.PI_MEMORY_TRACE = join(cwd, "trace.jsonl");
  memoryExtension(pi);
  await events.get("session_start")!({}, ctx);
  t.after(async () => {
    await events.get("session_shutdown")!({}, ctx);
    if (!options.cwd) await rm(cwd, { recursive: true, force: true });
    if (previousTrace === undefined) delete process.env.PI_MEMORY_TRACE; else process.env.PI_MEMORY_TRACE = previousTrace;
  });
  return { cwd, root, events, tools, commands, ctx, notifications, entries: () => [...entries], branch: (next: any[]) => { entries = next; } };
}

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

/** Trace events of compaction capture jobs, in order. */
async function jobEvents(h: { cwd: string }): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(join(h.cwd, "trace.jsonl"), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(event => event.event === "capture-job");
}

const completed = async (h: { cwd: string }) => (await jobEvents(h)).filter(event => event.status === "completed").length;

/** Pi compacted: the hook returns at once, and the capture finishes later as a background job. */
async function compact(h: { cwd: string; events: Map<string, Function>; ctx: ExtensionContext }) {
  const before = await completed(h);
  const started = performance.now();
  assert.equal(h.events.get("session_compact")!({}, h.ctx), undefined, "the hook returns synchronously");
  assert.ok(performance.now() - started < 50, `hook took ${(performance.now() - started).toFixed(1)} ms`);
  await until(async () => await completed(h) > before, "the capture job");
}

const fact = { title: "Test policy", body: "Run tests before committing.", type: "feedback", scope: "project", confidence: 0.95, source: { entries: ["u1"], origin: "user_statement" } };
const reply = (output: unknown) => ({ result: async () => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify(output) }] }) });
const testModel = { id: "test", provider: "test", maxTokens: 6000 };

test("/memory model validates, checks the registry, and persists a nested patch without clobbering siblings", async t => {
  assert.deepEqual(mergeSettings({ capture: { enabled: true, onCompact: false }, mode: "agent" }, { capture: { model: "p/m" } }), { capture: { enabled: true, onCompact: false, model: "p/m" }, mode: "agent" });
  assert.deepEqual(mergeSettings({ capture: "bad" }, { capture: { model: "p/m" } }), { capture: { model: "p/m" } });
  const agentDir = await mkdtemp(join(tmpdir(), "pi-memory-agent-")), previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(agentDir, { recursive: true, force: true }); });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark", memory: { capture: { enabled: true, onCompact: false } } }));
  const h = await harness(t);
  const handler = h.commands.get("memory").handler, known = { id: "m", provider: "p" };
  Object.assign(h.ctx, { modelRegistry: { getModelOfType: () => undefined, find: (provider: string, id: string) => provider === "p" && id === "m" ? known : undefined, hasConfiguredAuth: (m: unknown) => m === known } });
  const settings = async () => JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
  await handler("model", h.ctx);
  assert.match(h.notifications.at(-1)!, /^capture off; dream off; retrieval off\./);
  for (const bad of ["model capture", "model other p/m", "model capture nonsense", "model capture p/m extra"]) { await handler(bad, h.ctx); assert.match(h.notifications.at(-1)!, /Use \/memory model|provider\/modelId/); }
  await handler("model capture p/unknown", h.ctx); assert.match(h.notifications.at(-1)!, /Unknown model p\/unknown\. Nothing saved\./);
  assert.deepEqual((await settings()).memory, { capture: { enabled: true, onCompact: false } });
  await handler("model capture p/m", h.ctx); assert.match(h.notifications.at(-1)!, /^Saved memory\.capture\.model = p\/m\./);
  await handler("model dream off", h.ctx);
  assert.deepEqual(await settings(), { theme: "dark", memory: { capture: { enabled: true, onCompact: false, model: "p/m" }, dream: { model: "off" } } });
  assert.equal(readConfig(await settings(), agentDir, {}, {}).capture.enabled, true);
});

test("/memory model reports whether a retrieval selector runs as a classifier", async t => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-memory-agent-")), previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(agentDir, { recursive: true, force: true }); });
  const h = await harness(t);
  const handler = h.commands.get("memory").handler, classifier = { id: "c", provider: "p" }, chat = { id: "c", provider: "p" };
  let available = [classifier];
  Object.assign(h.ctx, { modelRegistry: { getAvailableOfType: async () => available, getModelOfType: () => classifier, find: () => chat, hasConfiguredAuth: () => true } });
  await handler("model retrieval p/c", h.ctx);
  assert.match(h.notifications.at(-1)!, /^Saved memory\.retrieval\.model = p\/c as a classifier\./);
  available = [];
  await handler("model retrieval p/c", h.ctx);
  assert.match(h.notifications.at(-1)!, /as a chat model, because its classifier is unavailable with the current credentials\./);
  await handler("model capture p/c", h.ctx);
  assert.match(h.notifications.at(-1)!, /^Saved memory\.capture\.model = p\/c as a chat model/);
  available = [classifier];
  await handler("model capture p/c", h.ctx);
  assert.match(h.notifications.at(-1)!, /^Saved memory\.capture\.model = p\/c as a classifier; raw entries wait until memory\.dream\.model is set\./);
});

test("a retrieval classifier decides recall from the prompt and the project's context files", async t => {
  const previous = process.env.PI_MEMORY_RETRIEVAL_MODEL;
  process.env.PI_MEMORY_RETRIEVAL_MODEL = "p/c";
  t.after(() => { if (previous === undefined) delete process.env.PI_MEMORY_RETRIEVAL_MODEL; else process.env.PI_MEMORY_RETRIEVAL_MODEL = previous; });
  const h = await harness(t);
  const store = new MemoryStore(h.root, resolveProjectKey(h.cwd)); await store.initialize();
  t.after(() => store.close());
  const source = { session: "prior", entries: ["u1"], origin: "user_statement" as const };
  const relevant = await store.save({ title: "Aurora staging tests", body: "Run aurora verify for staging tests.", source });
  const noise = await store.save({ title: "Aurora staging lunch", body: "The Aurora staging team has lunch at noon.", source });
  let state: any;
  Object.assign(h.ctx, { modelRegistry: { getAvailableOfType: async () => [{ id: "c", provider: "p" }], classify: async (_model: unknown, input: any) => {
    state = input.state;
    return { stopReason: "stop", answers: { [relevant.id]: { type: "score", score: 2.6, confidence: 1 }, [noise.id]: { type: "score", score: 0.2, confidence: 1 } } };
  } } });
  const contextFiles = [{ path: join(h.cwd, "AGENTS.md"), content: "Aurora staging service." }];
  const result = await h.events.get("before_agent_start")!({ messageType: "user", prompt: "Aurora staging tests", systemPromptOptions: { sections: {}, contextFiles } }, h.ctx);
  assert.deepEqual(result.message.details.ids, [relevant.id]);
  assert.equal(state.request, "Aurora staging tests");
  assert.equal(state.codebase.instructions[0].excerpt, "Aurora staging service.");
});

test("disabled memory performs no filesystem initialization or tool registration", async t => {
  const h = await harness(t, "inject", false);
  assert.equal(h.tools.size, 0);
  await assert.rejects(stat(h.root), { code: "ENOENT" });
  assert.equal(await h.events.get("before_agent_start")!({ prompt: "tests", messageType: "user", systemPromptOptions: { sections: {} } }, h.ctx), undefined);
});

test("recall appends once, tools and prompt stay stable, compaction and tree restore recall eligibility", async t => {
  const h = await harness(t);
  const store = new MemoryStore(h.root, resolveProjectKey(h.cwd)); await store.initialize();
  t.after(() => store.close());
  const item = await store.save({ title: "Aurora testing", body: "Run aurora verify for staging tests.", source: { session: "prior", entries: ["u1"], origin: "user_statement" } });
  const before = () => ({ messageType: "user", prompt: "Aurora staging tests", systemPromptOptions: { sections: {} as Record<string, string> } });
  const e1 = before(), first = await h.events.get("before_agent_start")!(e1, h.ctx);
  assert.deepEqual(first.message.details.ids, [item.id]);
  assert.ok(!h.events.has("context") && !h.events.has("context_with_system"));
  const toolDeclarations = [...h.tools.values()].map(tool => ({ name: tool.name, exposure: tool.exposure, description: tool.description }));
  assert.ok(toolDeclarations.every(tool => tool.exposure === "codemode"));
  const e2 = before();
  assert.equal(await h.events.get("before_agent_start")!(e2, h.ctx), undefined);
  assert.deepEqual(e1.systemPromptOptions, e2.systemPromptOptions);
  await h.events.get("session_compact")!({}, h.ctx);
  assert.ok((await h.events.get("before_agent_start")!(before(), h.ctx)).message);
  h.branch([]); await h.events.get("session_tree")!({}, h.ctx);
  assert.ok((await h.events.get("before_agent_start")!(before(), h.ctx)).message);
  assert.deepEqual([...h.tools.values()].map(tool => ({ name: tool.name, exposure: tool.exposure, description: tool.description })), toolDeclarations);
});

test("agent mode exposes six tools and never auto-recalls; references and current scope still work", async t => {
  const h = await harness(t, "agent");
  assert.equal(h.tools.size, 6); assert.ok([...h.tools.values()].every(tool => tool.exposure === "direct"));
  h.branch([{ id: "user", type: "message", message: { role: "user", content: "Remember to run cobalt verify." } }]);
  const saved = await h.tools.get("memory_save").execute("call", { type: "project", title: "Cobalt tests", content: "Run cobalt verify.", evidenceQuote: "run cobalt verify" }, undefined, undefined, h.ctx);
  const id = saved.structuredContent.result.id;
  assert.equal(await h.events.get("before_agent_start")!({ messageType: "user", prompt: "Cobalt tests", systemPromptOptions: { sections: {} } }, h.ctx), undefined);
  const expanded = await h.events.get("input")!({ text: `Use #mem:${id}` }, h.ctx);
  assert.equal(expanded.action, "transform"); assert.match(expanded.text, /cobalt verify/);
  const read = await h.tools.get("memory_get").execute("get", { ids: [id] });
  assert.equal(read.structuredContent.result.length, 1);
});

test("clear in non-interactive mode requires --yes and archive-only keeps evidence", async t => {
  const h = await harness(t); (h.ctx as any).hasUI = false;
  const store = new MemoryStore(h.root, resolveProjectKey(h.cwd)); await store.initialize(); t.after(() => store.close());
  await store.save({ title: "Validation", body: "Run validation.", source: { session: "prior", entries: ["u1"], origin: "user_statement" } });
  await h.commands.get("memory").handler("clear project", h.ctx);
  await store.reindex(); assert.equal(store.list().length, 1);
  await h.commands.get("memory").handler("clear project --archive-only --yes", h.ctx);
  await store.reindex(); assert.equal(store.list().length, 0); assert.equal(store.list({ includeArchived: true }).length, 1);
});

test("settings enforce kill switches, budget boundaries, models, and deliberate overrides", () => {
  assert.equal(readConfig({ memory: { enabled: true } }, "/tmp/agent", { "no-memory": true }, {}).enabled, false);
  assert.equal(readConfig({}, "/tmp/agent", {}, { PI_MEMORY_DISABLED: "yes" }).enabled, false);
  assert.equal(readConfig({ memory: { mode: "agent" } }, "/tmp/agent", { "memory-mode": "both" }, {}).mode, "both");
  assert.throws(() => readConfig({ memory: { retrieval: { budgetTokens: -1 } } }, "/tmp/agent", {}, {}));
  assert.throws(() => readConfig({ memory: { capture: { model: "nonsense" } } }, "/tmp/agent", {}, {}));
  // Background model calls require an explicitly configured model; the session model is never used implicitly.
  const implicit = readConfig({ memory: { capture: { enabled: true }, dream: { enabled: true } } }, "/tmp/agent", {}, {});
  assert.equal(implicit.capture.enabled, false); assert.equal(implicit.capture.model, undefined);
  assert.equal(implicit.dream.enabled, false); assert.equal(implicit.dream.model, undefined);
  const explicit = readConfig({ memory: { capture: { model: "p/m" }, dream: { model: "p/d" } } }, "/tmp/agent", {}, {});
  assert.equal(explicit.capture.enabled, true); assert.equal(explicit.capture.model, "p/m");
  assert.equal(explicit.dream.enabled, true); assert.equal(explicit.dream.model, "p/d");
  // Compaction captures retry in the background; each attempt is bounded.
  assert.deepEqual([explicit.capture.timeoutMs, explicit.capture.retries, explicit.capture.retryDelayMs], [120000, 2, 30000]);
  assert.equal(readConfig({ memory: { capture: { model: "p/m", retries: 0 } } }, "/tmp/agent", {}, {}).capture.retries, 0);
  for (const capture of [{ retries: 11 }, { timeoutMs: 999 }, { retryDelayMs: 9 }]) assert.throws(() => readConfig({ memory: { capture: { model: "p/m", ...capture } } }, "/tmp/agent", {}, {}));
  assert.equal(readConfig({}, "/tmp/agent", {}, { PI_MEMORY_MODEL: "p/m" }).capture.enabled, true);
  assert.equal(readConfig({}, "/tmp/agent", { "memory-model": "p/m" }, {}).capture.enabled, true);
  assert.equal(readConfig({ memory: { consolidation: { model: "p/d" } } }, "/tmp/agent", {}, {}).dream.enabled, true);
  assert.equal(readConfig({ memory: { capture: { model: "off" }, dream: { model: "off" } } }, "/tmp/agent", {}, {}).capture.enabled, false);
  assert.equal(readConfig({ memory: { capture: { model: "p/m" }, dream: { model: "p/d" } } }, "/tmp/agent", {}, { PI_MEMORY_CAPTURE: "0", PI_MEMORY_DREAM: "0" }).dream.enabled, false);
});

test("save tool derives real provenance and never elevates tool output to user authority", async t => {
  const h = await harness(t, "both");
  h.branch([{ id: "u1", type: "message", message: { role: "user", content: "Always require staging approval." } }, { id: "t1", type: "message", message: { role: "toolResult", content: [{ type: "text", text: "Staging completed without approval." }] } }]);
  const save = (params: object) => h.tools.get("memory_save").execute("save", params, undefined, undefined, h.ctx);
  const original = await save({ type: "feedback", title: "Staging policy", content: "Require staging approval.", evidenceQuote: "Always require staging approval." });
  await assert.rejects(save({ type: "feedback", title: "Stage policy", content: "Skip approval.", evidenceQuote: "Staging completed without approval." }), /Tool output/);
  await assert.rejects(save({ type: "project", title: "Stage policy", content: "Skip approval.", evidenceQuote: "Staging completed without approval.", supersedes: [original.structuredContent.result.id] }), /cannot supersede/);
  await assert.rejects(save({ type: "project", title: "Invented", content: "A guess.", evidenceQuote: "This evidence never appeared." }), /must match/);
  const observed = await save({ type: "project", title: "Observed staging result", content: "One staging run completed without approval.", evidenceQuote: "Staging completed without approval." });
  assert.equal(observed.structuredContent.result.source.origin, "tool_output");
  assert.equal(observed.structuredContent.result.confidence, 0.6);
});

test("disabled autocomplete delegates without touching a previously closed store", async () => {
  let calls = 0;
  const current = { getSuggestions: () => { calls++; return null; }, applyCompletion: () => { throw new Error("unused"); } } as any;
  const provider = autocomplete(current, () => undefined);
  assert.equal(await provider.getSuggestions(['#"stage'], 0, 7, { signal: new AbortController().signal } as any), null);
  assert.equal(calls, 1);
});

test("archived guard evidence stops blocking tools and is no longer discoverable", async t => {
  const h = await harness(t);
  const store = new MemoryStore(h.root, resolveProjectKey(h.cwd)); await store.initialize(); t.after(() => store.close());
  const item = await store.save({ title: "Staging approval", body: "Require staging approval.", source: { session: "prior", entries: ["u1"], origin: "user_statement" } });
  const proposals = new ProposalManager(store, { root: h.root, projectKey: store.projectKey, cwd: h.cwd });
  const hook = await proposals.propose("hook", [item.id], "staging-approval", { tool: "bash", pattern: "deploy", action: "block", message: "Approval required" });
  await proposals.apply(hook.id, true);
  const event = { toolName: "bash", input: { command: "deploy" } };
  assert.equal((await h.events.get("tool_call")!(event, h.ctx)).block, true);
  await store.archive(item.id);
  assert.equal(await h.events.get("tool_call")!(event, h.ctx), undefined);
});

test("explicit references are not repeated by automatic recall, including after branch restoration", async t => {
  const h = await harness(t, "both");
  const store = new MemoryStore(h.root, resolveProjectKey(h.cwd)); await store.initialize(); t.after(() => store.close());
  const item = await store.save({ title: "Cobalt staging", body: "Run cobalt check before staging.", source: { session: "prior", entries: ["u1"], origin: "user_statement" } });
  const expanded = await h.events.get("input")!({ text: `Use #mem:${item.id} for Cobalt staging` }, h.ctx);
  const request = () => ({ messageType: "user", prompt: expanded.text, systemPromptOptions: { sections: {} } });
  assert.equal(await h.events.get("before_agent_start")!(request(), h.ctx), undefined);
  h.branch([...h.entries(), { type: "message", id: "reference", message: { role: "user", content: expanded.text } }]);
  await h.events.get("session_tree")!({}, h.ctx);
  assert.equal(await h.events.get("before_agent_start")!(request(), h.ctx), undefined);
});

test("expired or archived recall is invalidated append-only before later actions", async t => {
  const h = await harness(t, "both");
  const store = new MemoryStore(h.root, resolveProjectKey(h.cwd)); await store.initialize(); t.after(() => store.close());
  const item = await store.save({ title: "Cobalt temporary routing", body: "Route Cobalt rehearsal to zone-b.", retention: "short", expiresAt: new Date(Date.now() + 60000).toISOString(), source: { session: "prior", entries: ["u1"], origin: "user_statement" } });
  const request = () => ({ messageType: "user", prompt: "Cobalt rehearsal routing", systemPromptOptions: { sections: {} } });
  const first = await h.events.get("before_agent_start")!(request(), h.ctx);
  assert.deepEqual(first.message.details.ids, [item.id]);
  await store.archive(item.id, "Rehearsal finished");
  const next = await h.events.get("before_agent_start")!(request(), h.ctx);
  assert.deepEqual(next.message.details.retiredIds, [item.id]);
  assert.match(next.message.content, /no longer apply/);
  assert.equal(await h.events.get("before_agent_start")!(request(), h.ctx), undefined);
});


test("same-ID canonical edits invalidate old evidence, re-recall each version, and survive tree restoration", async t => {
  const h = await harness(t, "both");
  const store = new MemoryStore(h.root, resolveProjectKey(h.cwd)); await store.initialize(); t.after(() => store.close());
  const item = await store.save({ title: "Cobalt routing", body: "Route Cobalt rehearsal to zone-a.", source: { session: "prior", entries: ["u1"], origin: "user_statement" } });
  const path = join(store.scopeDirectory(), "items", `${item.id}.md`);
  const request = () => ({ messageType: "user", prompt: "Cobalt rehearsal routing", systemPromptOptions: { sections: {} } });
  const history: any[] = [];
  const first = await h.events.get("before_agent_start")!(request(), h.ctx);
  assert.equal(first.message.details.versions[item.id], evidenceHash(item));
  history.push({ type: "custom_message", ...first.message });
  let current = item;
  const edits = [
    { body: "Route Cobalt rehearsal to zone-b." },
    { confidence: 0.8 },
    { source: { ...item.source, entries: ["u2"] } },
    { retention: "short" as const, expiresAt: new Date(Date.now() + 60000).toISOString() },
  ];
  for (const edit of edits) {
    current = { ...current, ...edit };
    await writeFile(path, serializeMemory(current));
    h.branch(history); await h.events.get("session_tree")!({}, h.ctx);
    const changed = await h.events.get("before_agent_start")!(request(), h.ctx);
    assert.deepEqual(changed.message.details.retiredIds, [item.id]);
    assert.deepEqual(changed.message.details.ids, [item.id]);
    assert.equal(changed.message.details.versions[item.id], evidenceHash(current));
    assert.match(changed.message.content, /Earlier versions/);
    history.push({ type: "custom_message", ...changed.message });
    h.branch(history); await h.events.get("session_tree")!({}, h.ctx);
    assert.equal(await h.events.get("before_agent_start")!(request(), h.ctx), undefined);
  }
  await writeFile(path, serializeMemory({ ...current, scope: "project:another-project" }));
  const moved = await h.events.get("before_agent_start")!(request(), h.ctx);
  assert.deepEqual(moved.message.details.retiredIds, [item.id]);
  assert.deepEqual(moved.message.details.ids, []);
});

test("fixed session digest receives append-only correction when its source changes", async t => {
  const h = await harness(t);
  const store = new MemoryStore(h.root, resolveProjectKey(h.cwd)); await store.initialize(); t.after(() => store.close());
  const item = await store.save({ title: "Cobalt staging policy", body: "Cobalt staging requires owner approval.", type: "feedback", importance: 9, source: { session: "prior", entries: ["u1"], origin: "user_statement" } });
  await store.consolidate();
  await h.events.get("session_start")!({}, h.ctx);
  const request = () => ({ messageType: "user", prompt: "Cobalt staging policy", systemPromptOptions: { sections: {} as Record<string, string> } });
  const first = request();
  assert.equal(await h.events.get("before_agent_start")!(first, h.ctx), undefined);
  assert.match(first.systemPromptOptions.sections.memory!, /owner approval/);
  await writeFile(join(store.scopeDirectory(), "items", `${item.id}.md`), serializeMemory({ ...item, body: "Cobalt staging requires release-manager approval." }));
  const next = request(), corrected = await h.events.get("before_agent_start")!(next, h.ctx);
  assert.equal(next.systemPromptOptions.sections.memory, first.systemPromptOptions.sections.memory);
  assert.deepEqual(corrected.message.details.retiredIds, [item.id]);
  assert.deepEqual(corrected.message.details.ids, [item.id]);
  assert.match(corrected.message.content, /release-manager approval/);
  assert.equal(await h.events.get("before_agent_start")!(request(), h.ctx), undefined);
});

test("session recall ceiling stops new evidence once the branch has used its budget, across restarts", async t => {
  process.env.PI_MEMORY_SESSION_BUDGET = "450";
  t.after(() => { delete process.env.PI_MEMORY_SESSION_BUDGET; });
  const h = await harness(t);
  const store = new MemoryStore(h.root, resolveProjectKey(h.cwd)); await store.initialize(); t.after(() => store.close());
  await store.save({ title: "Aurora staging policy", body: "Aurora staging requires owner approval before deploys.", keywords: ["aurora"], source: { session: "prior", entries: ["u1"], origin: "user_statement" } });
  await store.save({ title: "Cobalt routing policy", body: "Cobalt routing uses the rehearsal queue.", keywords: ["cobalt"], source: { session: "prior", entries: ["u2"], origin: "user_statement" } });
  const request = (prompt: string) => ({ messageType: "user", prompt, systemPromptOptions: { sections: {} } });
  const first = await h.events.get("before_agent_start")!(request("Aurora staging deploy"), h.ctx);
  assert.equal(first.message.details.ids.length, 1);
  const used = Buffer.byteLength(first.message.content);
  assert.ok(used > 250 && used <= 450, `first recall used ${used}`);
  // The remaining budget cannot fit a whole second item, so nothing new is injected.
  assert.equal(await h.events.get("before_agent_start")!(request("Cobalt routing change"), h.ctx), undefined);
  // A fresh process restores the spent budget from persisted recall messages on the branch.
  h.branch([{ type: "custom_message", customType: "pi-memory/recall", content: "x".repeat(450), details: { ids: [] } }]);
  await h.events.get("session_tree")!({}, h.ctx);
  assert.equal(await h.events.get("before_agent_start")!(request("Cobalt routing change"), h.ctx), undefined);
  // Compaction or an empty branch frees the ceiling again.
  h.branch([]);
  await h.events.get("session_tree")!({}, h.ctx);
  assert.equal((await h.events.get("before_agent_start")!(request("Cobalt routing change"), h.ctx)).message.details.ids.length, 1);
});

test("legacy recall records without fingerprints are invalidated conservatively", async t => {
  const h = await harness(t);
  const store = new MemoryStore(h.root, resolveProjectKey(h.cwd)); await store.initialize(); t.after(() => store.close());
  const item = await store.save({ title: "Cobalt policy", body: "Require Cobalt staging approval.", source: { session: "prior", entries: ["u1"], origin: "user_statement" } });
  h.branch([{ type: "custom_message", customType: "pi-memory/recall", details: { ids: [item.id] } }]);
  await h.events.get("session_tree")!({}, h.ctx);
  const result = await h.events.get("before_agent_start")!({ messageType: "user", prompt: "Cobalt policy", systemPromptOptions: { sections: {} } }, h.ctx);
  assert.deepEqual(result.message.details.retiredIds, [item.id]);
  assert.deepEqual(result.message.details.ids, [item.id]);
});

test("changed provenance disables an applied guard even when the body is unchanged", async t => {
  const h = await harness(t);
  const store = new MemoryStore(h.root, resolveProjectKey(h.cwd)); await store.initialize(); t.after(() => store.close());
  const item = await store.save({ title: "Cobalt approval", body: "Require Cobalt staging approval.", source: { session: "prior", entries: ["u1"], origin: "user_statement" } });
  const proposals = new ProposalManager(store, { root: h.root, projectKey: store.projectKey, cwd: h.cwd });
  const hook = await proposals.propose("hook", [item.id], "cobalt-approval", { tool: "bash", pattern: "deploy", action: "block", message: "Approval required" });
  await proposals.apply(hook.id, true);
  const event = { toolName: "bash", input: { command: "deploy" } };
  assert.equal((await h.events.get("tool_call")!(event, h.ctx)).block, true);
  await writeFile(join(store.scopeDirectory(), "items", `${item.id}.md`), serializeMemory({ ...store.get([item.id])[0]!, source: { ...item.source, entries: ["u2"] } }));
  assert.equal(await h.events.get("tool_call")!(event, h.ctx), undefined);
});


test("resource discovery refreshes canonical evidence before exposing applied skills", async t => {
  const h = await harness(t);
  const store = new MemoryStore(h.root, resolveProjectKey(h.cwd)); await store.initialize(); t.after(() => store.close());
  const item = await store.save({ title: "Cobalt workflow", body: "Run cobalt verify before staging.", source: { session: "prior", entries: ["u1"], origin: "user_statement" } });
  const proposals = new ProposalManager(store, { root: h.root, projectKey: store.projectKey, cwd: h.cwd });
  const skill = await proposals.propose("skill", [item.id], "cobalt-workflow");
  const applied = await proposals.apply(skill.id, true);
  assert.deepEqual((await h.events.get("resources_discover")!({}, h.ctx)).skillPaths, [applied.destination]);
  await writeFile(join(store.scopeDirectory(), "items", `${item.id}.md`), serializeMemory({ ...store.get([item.id])[0]!, confidence: 0.4 }));
  assert.deepEqual((await h.events.get("resources_discover")!({}, h.ctx)).skillPaths, []);
});


test("capture reports invalid output once without retrying or storing an unsupported fact", async t => {
  const fact = { title: "Test policy", body: "Run tests before committing.", source: { entries: ["u1"], origin: "user_statement" } };
  const cases = [
    { name: "malformed envelope", outputs: ["not JSON"], calls: 1 },
    { name: "invalid source", outputs: [{ candidates: [{ ...fact, source: { ...fact.source, entries: ["invented"] } }], verdicts: [] }], calls: 1 },
    { name: "invalid curator", outputs: [{ candidates: [fact], verdicts: [] }, { operations: [{ candidate: 0, action: "SUPERSEDE", id: "invented" }] }], calls: 2 },
  ];
  for (const example of cases) await t.test(example.name, async subtest => {
    const h = await harness(subtest, "inject", true, true);
    h.branch([{ id: "u1", type: "message", message: { role: "user", content: "Remember: run tests before committing." } }]);
    let calls = 0;
    Object.assign(h.ctx, { model: { id: "test", maxTokens: 6000 }, modelRegistry: {
      hasConfiguredAuth: () => true, find: () => ({ id: "test", provider: "test", maxTokens: 6000 }),
      streamSimple: () => { const output = example.outputs[calls++]; return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: typeof output === "string" ? output : JSON.stringify(output) }] }) }; },
    } });
    await compact(h);
    assert.equal(calls, example.calls);
    assert.equal(h.notifications.length, 1);
    assert.match(h.notifications[0]!, /^Memory capture rejected output: .+\. Original session evidence retained\.$/);
    const originalNotice = h.notifications[0];
    await compact(h);
    assert.equal(calls, example.calls); assert.deepEqual(h.notifications, [originalNotice]);
    const store = new MemoryStore(h.root, resolveProjectKey(h.cwd)); await store.initialize();
    assert.equal(store.list().length, 0); store.close();
  });
});

test("expected temporary and already-documented skips do not notify capture errors", async t => {
  for (const documented of [false, true]) await t.test(String(documented), async subtest => {
    const h = await harness(subtest, "inject", true, true);
    const body = documented ? "Run tests before committing." : "Use 1 worker for now.";
    h.branch([{ id: "u1", type: "message", message: { role: "user", content: `Remember: ${body}` } }]);
    let calls = 0;
    Object.assign(h.ctx, { model: { id: "test", maxTokens: 6000 }, getSystemPrompt: () => documented ? body : "", modelRegistry: {
      hasConfiguredAuth: () => true, find: () => ({ id: "test", provider: "test", maxTokens: 6000 }),
      streamSimple: () => { calls++; return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ candidates: [{ title: "Policy", body, source: { entries: ["u1"], origin: "user_statement" } }], verdicts: [] }) }] }) }; },
    } });
    await compact(h);
    await compact(h);
    assert.equal(calls, 1); assert.deepEqual(h.notifications, []);
    const store = new MemoryStore(h.root, resolveProjectKey(h.cwd)); await store.initialize();
    assert.equal(store.list().length, 0); store.close();
  });
});


test("resumed capture rejection reaches the normal notice flow exactly once", async t => {
  const h = await harness(t, "inject", true, true);
  let resumes = 0;
  t.mock.method(CapturePipeline.prototype, "resumePending", async () => ++resumes === 1
    ? { saved: 0, skipped: false, rejected: [{ candidate: -1, reason: "Memory model returned invalid JSON object" }] }
    : { saved: 0, skipped: true });
  // Empty current branch skips capture. Actual pending-file replay is covered by capture.test.ts.
  await compact(h);
  assert.deepEqual(h.notifications, ["Memory capture rejected output: Memory model returned invalid JSON object. Original session evidence retained."]);
  await compact(h);
  assert.equal(h.notifications.length, 1); assert.equal(resumes, 2);
  const store = new MemoryStore(h.root, resolveProjectKey(h.cwd)); await store.initialize();
  assert.equal(store.list().length, 0); store.close();
});

test("a resumed saved outcome reaches maintenance even when current capture skips", async t => {
  const h = await harness(t, "inject", true, true);
  const key = resolveProjectKey(h.cwd), path = join(h.root, `maintenance-${key}.json`);
  const store = new MemoryStore(h.root, key); await store.initialize();
  const resume = t.mock.method(CapturePipeline.prototype, "resumePending", async () => {
    await store.save({ title: "Resumed test policy", body: "Run tests before committing.", source: { session: "prior", entries: ["u1"], origin: "user_statement" } });
    return { saved: 1, skipped: false };
  });
  await assert.rejects(stat(path), { code: "ENOENT" });
  await compact(h);
  assert.ok((await stat(path)).isFile());
  assert.equal(store.list().length, 1); assert.deepEqual(h.notifications, []);
  resume.mock.restore(); store.close();
});

test("compaction is never held up by memory: only a finished compaction captures, without waiting", async t => {
  let calls = 0;
  const h = await harness(t, "inject", true, true, { context: { model: testModel, modelRegistry: {
    hasConfiguredAuth: () => true, find: () => testModel,
    streamSimple: () => { calls++; return { result: () => new Promise(() => {}) }; },
  } } });
  h.branch([{ id: "u1", type: "message", message: { role: "user", content: "Remember: run tests before committing." } }]);
  // A compaction that another extension cancels or defers never reaches memory.
  assert.equal(h.events.has("session_before_compact"), false);
  const durations: number[] = [];
  for (let i = 0; i < 5; i++) {
    const started = performance.now();
    assert.equal(h.events.get("session_compact")!({}, h.ctx), undefined);
    durations.push(performance.now() - started);
  }
  assert.ok(Math.max(...durations) < 50, `slowest hook ${Math.max(...durations).toFixed(1)} ms`);
  await until(() => calls === 1, "the capture request");
  // The next prompt neither waits for the capture nor aborts it.
  const started = performance.now();
  await h.events.get("before_agent_start")!({ prompt: "tests", messageType: "user", systemPromptOptions: { sections: {} } }, h.ctx);
  await h.events.get("agent_start")!({}, h.ctx);
  assert.ok(performance.now() - started < 1000, `the prompt waited ${(performance.now() - started).toFixed(0)} ms`);
  assert.equal(calls, 1, "one capture at a time; the others wait for it");
  assert.equal(await completed(h), 0);
});

test("a failed compaction capture is retried in the background and saves once", async t => {
  let calls = 0;
  const outputs = [{ candidates: [fact], verdicts: [] }, { operations: [{ candidate: 0, action: "ADD" }] }];
  const h = await harness(t, "inject", true, true, { context: { model: testModel, modelRegistry: {
    hasConfiguredAuth: () => true, find: () => testModel,
    streamSimple: () => ++calls === 1 ? { result: async () => { throw new Error("Temporary network outage"); } } : reply(outputs[calls - 2]),
  } } });
  h.branch([{ id: "u1", type: "message", message: { role: "user", content: "Remember: run tests before committing." } }]);
  await compact(h);
  assert.deepEqual((await jobEvents(h)).map(event => [event.status, event.attempt ?? event.saved]), [["retrying", 1], ["completed", 1]]);
  assert.equal(calls, 3);
  const store = new MemoryStore(h.root, resolveProjectKey(h.cwd)); await store.initialize();
  assert.deepEqual(store.list().map(item => item.body), ["Run tests before committing."]); store.close();
  assert.deepEqual(h.notifications, []);
});

test("a capture that keeps failing gives up after its retries and keeps the evidence for a later capture", async t => {
  let calls = 0;
  const h = await harness(t, "inject", true, true, { capture: { retries: 1 }, context: { model: testModel, modelRegistry: {
    hasConfiguredAuth: () => true, find: () => testModel,
    streamSimple: () => { calls++; return { result: async () => { throw new Error("Provider down"); } }; },
  } } });
  h.branch([{ id: "u1", type: "message", message: { role: "user", content: "Remember: run tests before committing." } }]);
  assert.equal(h.events.get("session_compact")!({}, h.ctx), undefined);
  await until(async () => (await jobEvents(h)).some(event => event.status === "failed"), "the job to fail");
  assert.equal(calls, 2);
  await until(() => h.notifications.length === 1, "the failure notice");
  assert.match(h.notifications[0]!, /^Memory capture after compaction failed: .*Provider down.*Session evidence retained/);
});

test("a compaction capture interrupted by exit resumes in the next process and saves once", async t => {
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const cwd = await mkdtemp(join(tmpdir(), "pi-memory-restart-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, "session.jsonl"), timestamp = new Date().toISOString();
  await writeFile(path, [
    { type: "session", version: 3, id: "test-session", timestamp, cwd },
    { id: "u1", parentId: null, timestamp, type: "message", message: { role: "user", content: "Remember: run tests before committing.", timestamp: Date.now() } },
  ].map(value => JSON.stringify(value)).join("\n") + "\n");
  let first = 0;
  const h1 = await harness(t, "inject", true, true, { cwd, sessionManager: SessionManager.open(path), context: { model: testModel, modelRegistry: {
    hasConfiguredAuth: () => true, find: () => testModel,
    streamSimple: () => { first++; return { result: () => new Promise(() => {}) }; },
  } } });
  assert.equal(h1.events.get("session_compact")!({}, h1.ctx), undefined);
  await until(() => first === 1, "the capture request");
  // Pi exits while the capture waits for the model.
  await h1.events.get("session_shutdown")!({}, h1.ctx);
  const stored = (await readdir(join(cwd, "memory", "capture"))).filter(name => name.endsWith(".jobs.db"));
  assert.equal(stored.length, 1);
  let second = 0;
  const outputs = [{ candidates: [fact], verdicts: [] }, { operations: [{ candidate: 0, action: "ADD" }] }];
  const h2 = await harness(t, "inject", true, true, { cwd, sessionManager: SessionManager.open(path), context: { model: testModel, modelRegistry: {
    hasConfiguredAuth: () => true, find: () => testModel,
    streamSimple: () => reply(outputs[second++]),
  } } });
  await until(async () => await completed(h2) === 1, "the resumed capture");
  assert.equal(second, 2);
  assert.equal(first, 1, "the interrupted process made no further request");
  const store = new MemoryStore(h2.root, resolveProjectKey(cwd)); await store.initialize();
  assert.deepEqual(store.list().map(item => item.source.entries), [["u1"]]); store.close();
  // The finished job leaves nothing stored once the session closes.
  await h2.events.get("session_shutdown")!({}, h2.ctx);
  assert.deepEqual((await readdir(join(cwd, "memory", "capture"))).filter(name => name.includes(".jobs.db")), []);
});

test("a settled raw entry raises no retraction, and a new user note in the live transcript is not recalled back", async t => {
  const h = await harness(t, "both");
  const store = new MemoryStore(h.root, resolveProjectKey(h.cwd)); await store.initialize(); t.after(() => store.close());
  const raw = (body: string, entries: string[]) => store.save({ title: body, body, source: { session: "prior", entries, origin: "user_statement" }, raw: { role: "user", at: new Date().toISOString() } });
  const past = await raw("Cobalt rehearsal routes to zone-b.", ["old"]), live = await raw("Cobalt rehearsal uses the amber key.", ["u1"]);
  h.branch([{ type: "message", id: "u1", message: { role: "user", content: "Cobalt rehearsal uses the amber key." } }]);
  const request = () => ({ messageType: "user", prompt: "Cobalt rehearsal", systemPromptOptions: { sections: {} } });
  const first = await h.events.get("before_agent_start")!(request(), h.ctx);
  assert.deepEqual(first.message.details.ids, [past.id], "the entry still in the transcript is not recalled");
  assert.match(first.message.content, /raw note, not yet consolidated/);
  await store.settleRaw(new Map([[past.id, []]]));
  const next = await h.events.get("before_agent_start")!(request(), h.ctx);
  assert.ok(!next?.message?.details?.retiredIds?.length);
  assert.ok(store.get([live.id])[0]!.status === "active");
});

test("/memory dream runs the sleep pass over raw entries, and status counts them", async t => {
  const previous = process.env.PI_MEMORY_DREAM;
  delete process.env.PI_MEMORY_DREAM;
  t.after(() => { if (previous !== undefined) process.env.PI_MEMORY_DREAM = previous; });
  const h = await harness(t, "both", true, false, { memory: { dream: { model: "test/test" } } });
  const store = new MemoryStore(h.root, resolveProjectKey(h.cwd)); await store.initialize(); t.after(() => store.close());
  await store.save({ title: "Deploy note", body: "Deploys use the blue pool.", source: { session: "prior", entries: ["old"], origin: "user_statement" }, raw: { role: "user", at: new Date().toISOString() } });
  const handler = h.commands.get("memory").handler;
  await handler("status", h.ctx);
  assert.match(h.notifications.at(-1)!, /^1 memories, 1 raw;/);
  const chat = { id: "test", maxTokens: 6000 };
  Object.assign(h.ctx, { modelRegistry: { find: () => chat, hasConfiguredAuth: () => true, streamSimple: () => ({ result: async () => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ candidates: [], verdicts: [] }) }] }) }) } });
  await handler("dream", h.ctx);
  const result = JSON.parse(h.notifications.at(-1)!);
  assert.deepEqual([result.assimilation.pruned, result.assimilation.saved], [1, 0]);
  assert.deepEqual(store.rawEntries(), []);
});
