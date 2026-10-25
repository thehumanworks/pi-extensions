import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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

async function harness(t: TestContext, mode = "inject", enabled = true, captureEnabled = false) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-memory-extension-")), root = join(cwd, "memory");
  const events = new Map<string, Function>(), tools = new Map<string, any>(), commands = new Map<string, any>();
  let entries: any[] = [];
  const notifications: string[] = [];
  const pi = {
    on: (event: string, handler: Function) => { events.set(event, handler); return () => events.delete(event); },
    registerFlag: () => {}, getFlag: () => undefined,
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    getSettings: () => ({ memory: { enabled, dir: root, mode, capture: { enabled: captureEnabled, ...(captureEnabled ? { model: "test/test" } : {}) } } }),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command), registerMessageRenderer: () => {},
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd, mode: "json", hasUI: true, isIdle: () => true, hasPendingMessages: () => false, isProjectTrusted: () => true,
    ui: { notify: (message: string) => notifications.push(message) },
    sessionManager: { getBranch: () => entries, getSessionId: () => "test-session", getSessionFile: () => undefined, getLeafId: () => entries.at(-1)?.id },
  } as unknown as ExtensionContext;
  memoryExtension(pi);
  await events.get("session_start")!({}, ctx);
  t.after(async () => { await events.get("session_shutdown")!({}, ctx); await rm(cwd, { recursive: true, force: true }); });
  return { cwd, root, events, tools, commands, ctx, notifications, entries: () => [...entries], branch: (next: any[]) => { entries = next; } };
}

test("/memory model validates, checks the registry, and persists a nested patch without clobbering siblings", async t => {
  assert.deepEqual(mergeSettings({ capture: { enabled: true, onCompact: false }, mode: "agent" }, { capture: { model: "p/m" } }), { capture: { enabled: true, onCompact: false, model: "p/m" }, mode: "agent" });
  assert.deepEqual(mergeSettings({ capture: "bad" }, { capture: { model: "p/m" } }), { capture: { model: "p/m" } });
  const agentDir = await mkdtemp(join(tmpdir(), "pi-memory-agent-")), previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(agentDir, { recursive: true, force: true }); });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark", memory: { capture: { enabled: true, onCompact: false } } }));
  const h = await harness(t);
  const handler = h.commands.get("memory").handler, known = { id: "m", provider: "p" };
  Object.assign(h.ctx, { modelRegistry: { find: (provider: string, id: string) => provider === "p" && id === "m" ? known : undefined, hasConfiguredAuth: (m: unknown) => m === known } });
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
    await h.events.get("session_before_compact")!({}, h.ctx);
    assert.equal(calls, example.calls);
    assert.equal(h.notifications.length, 1);
    assert.match(h.notifications[0]!, /^Memory capture rejected output: .+\. Original session evidence retained\.$/);
    const originalNotice = h.notifications[0];
    await h.events.get("session_before_compact")!({}, h.ctx);
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
    await h.events.get("session_before_compact")!({}, h.ctx);
    await h.events.get("session_before_compact")!({}, h.ctx);
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
  await h.events.get("session_before_compact")!({}, h.ctx);
  assert.deepEqual(h.notifications, ["Memory capture rejected output: Memory model returned invalid JSON object. Original session evidence retained."]);
  await h.events.get("session_before_compact")!({}, h.ctx);
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
  await h.events.get("session_before_compact")!({}, h.ctx);
  assert.ok((await stat(path)).isFile());
  assert.equal(store.list().length, 1); assert.deepEqual(h.notifications, []);
  resume.mock.restore(); store.close();
});
