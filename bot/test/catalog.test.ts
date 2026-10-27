import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createBot, listBots, editBot, archiveBot, applyTextEdits } from "../src/catalog.js";
import { inspectBot } from "../src/project.js";
import { acquireLock } from "../src/lock.js";
import { fixture, scripted } from "./helpers.js";
import { openBot } from "../src/runtime.js";

test("roster creates new-format bots and lists metadata without importing executable capabilities", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const root = join(f.root, "roster");
  const created = await createBot("reviewer", { description: "Reviews code", prompt: "Be precise." }, root);
  assert.equal(created.format, 2); assert.equal(created.stateDir, join(root, "reviewer", ".bot"));
  await writeFile(join(created.sourceDir, "tools", "bad.ts"), "throw new Error('must not execute while listing');");
  const listing = await listBots(root);
  assert.equal(listing.bots.length, 1); assert.equal(listing.bots[0].description, "Reviews code");
  await assert.rejects(createBot("reviewer", {}, root), /already exists/);
  await assert.rejects(createBot("../escape", {}, root), /Bot names/);
  await assert.rejects(inspectBot(created.sourceDir), /must not execute/);
});

test("definition edits preserve unknown values and distinguish empty selections from discovery", async t => {
  const f = await fixture({ extraConfig: { important: true } }); t.after(f.cleanup);
  await editBot(f.source, { prompt: "Persona. Be direct.", tools: [], skills: [], thinking: "high" });
  assert.deepEqual((await inspectBot(f.source)).tools, []);
  await editBot(f.source, { edits: [{ oldText: "Be direct.", newText: "Be direct and cite sources." }], tools: null, maintenance: true });
  assert((await inspectBot(f.source)).tools.some(tool => tool.name === "bot_edit"));
  const definition = await readFile(join(f.source, "BOT.md"), "utf8");
  assert.match(definition, /important/); assert.match(definition, /cite sources/);
  await assert.rejects(editBot(f.source, { prompt: "a", edits: [] }), /Use prompt or edits/);
  await assert.rejects(editBot(f.source, { definition: definition, model: null }), /cannot be combined/);
  await assert.rejects(editBot(f.source, { definition: "No metadata" }), /expected 2/);
  assert.equal(await readFile(join(f.source, "BOT.md"), "utf8"), definition);
});

test("metadata validation rejects old-format definitions rather than providing compatibility", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const root = join(f.root, "roster"); await mkdir(join(root, "old"), { recursive: true });
  await writeFile(join(root, "old", "BOT.md"), "---\ndescription: old\n---\nPersona");
  const result = await listBots(root);
  assert.equal(result.bots.length, 0); assert.match(result.errors[0], /expected 2/);
});

test("archive refuses an owned source and preserves source/state once it is closed", async t => {
  const f = await fixture(); t.after(f.cleanup);
  await mkdir(join(f.source, ".bot")); await writeFile(join(f.source, ".bot", "MEMORY.md"), "keep this");
  const release = await acquireLock(join(f.source, ".sdk-source.lock"));
  await assert.rejects(archiveBot(f.source), /already open/); await release();
  const path = await archiveBot(f.source);
  assert.match(path, /\.archive/); assert.equal(await readFile(join(path, ".bot", "MEMORY.md"), "utf8"), "keep this");
});

test("catalog and self-maintenance coordinate BOT.md edits without requiring the execution lock", async t => {
  const f = await fixture({ maintenance: true }); t.after(f.cleanup);
  const { models } = scripted([]); const bot = await openBot(f.source, { models, agentDir: f.agentDir }); t.after(() => bot.close());
  const release = await acquireLock(join(f.source, ".sdk-definition.lock"));
  try {
    await assert.rejects(editBot(f.source, { prompt: "changed" }), /already open/);
    await assert.rejects(bot.callTool("bot_edit", { area: "source", path: "BOT.md", oldText: "Test persona.", newText: "changed" }), /already open/);
  } finally { await release(); }
  await editBot(f.source, { prompt: "Changed while runtime is open." });
  assert.equal((await bot.reload()).changed, true);
  assert.deepEqual((await bot.info()).diagnostics, []);
});

test("persona patches match once against the original and reject overlapping spans", () => {
  assert.equal(applyTextEdits("abc def", [{ oldText: "abc", newText: "def" }, { oldText: "def", newText: "abc" }]), "def abc");
  assert.throws(() => applyTextEdits("aaa", [{ oldText: "a", newText: "x" }]), /exactly once/);
  assert.throws(() => applyTextEdits("abc", [{ oldText: "ab", newText: "x" }, { oldText: "bc", newText: "y" }]), /overlap/);
});
